const express = require("express");
const request = require("request");
const cors = require("cors");
const db = require("../config/db");

const router = express.Router();

/* ----------------------------------------------------
   MIDDLEWARE
---------------------------------------------------- */
router.use(cors());
router.use(express.json());
router.use(express.urlencoded({ extended: false }));

router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  next();
});

/* ----------------------------------------------------
   TEST ROUTE
---------------------------------------------------- */
router.get("/", (req, res) => {
  res.status(200).json({ message: "Payments API running" });
});

/* ----------------------------------------------------
   MPESA ACCESS TOKEN MIDDLEWARE
---------------------------------------------------- */
const consumer_key = process.env.MPESA_CONSUMER_KEY;
const consumer_secret = process.env.MPESA_CONSUMER_SECRET;
const auth = Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64");

function access(req, res, next) {
  request(
    {
      url: "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      headers: { Authorization: `Basic ${auth}` },
    },
    (err, response, body) => {
      if (err) {
        console.error("❌ Token error:", err);
        return res.status(500).json({ error: "Failed to get access token" });
      }

      req.access_token = JSON.parse(body).access_token;
      next();
    }
  );
}

/* ----------------------------------------------------
   TEMP META STORE (REDIS RECOMMENDED)
---------------------------------------------------- */
const paymentMetaStore = {};

/* ----------------------------------------------------
   📲 STK PUSH
---------------------------------------------------- */
let withdrawalId;
router.post("/withdraw", access, (req, res) => {
  const { user_id, uid, amount, phone } = req.body;

  if (!user_id || !amount || !phone) {
    return res.status(400).json({ message: "Missing fields" });
  }

  // 1️⃣ Check wallet balance
  db.query(
    `SELECT pending_balance FROM wallets WHERE user_id = ?`,
    [user_id],
    (err, rows) => {
      if (err || !rows.length)
        return res.status(400).json({ message: "Wallet not found" });

      const balance = Number(rows[0].pending_balance || 0);
      if (balance < amount)
        return res.status(400).json({ message: "Insufficient balance" });

      // 2️⃣ Create withdrawal record
      db.query(
        `INSERT INTO withdrawals (user_id, uid, amount, phone)
         VALUES (?, ?, ?, ?)`,
        [user_id, uid, amount, phone],
        (err, result) => {
          if (err) {
            console.error(err);
            return res.status(500).json({ message: "Withdraw init failed" });
          }

           withdrawalId = result.insertId;
          const remarks = `WD-${withdrawalId}`;

          // 3️⃣ Call MPESA B2C
          const endpoint = "https://sandbox.safaricom.co.ke/mpesa/b2c/v1/paymentrequest";

          request(
            {
              url: endpoint,
              method: "POST",
              headers: {
                Authorization: "Bearer " + req.access_token,
              },
              json: {
                InitiatorName: process.env.MPESA_INITIATOR,
                SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
                CommandID: "SalaryPayment",
                Amount: amount,
                PartyA: "600983",
                PartyB: phone,
                Remarks: remarks,
                QueueTimeOutURL: "https://tipp-meserver-production-5b51.up.railway.app/api/payments",
                ResultURL: "https://tipp-meserver-production-5b51.up.railway.app/api/b2c/b2c-callback",
                Occasion: remarks,
              },
            },
            (err, response, body) => {
              if (err) {
                console.error(err);
                return res.status(500).json({ message: "MPESA B2C error" });
              }

              // 4️⃣ Update withdrawal → PROCESSING
              db.query(
                `UPDATE withdrawals
                 SET status = 'PROCESSING'
                 WHERE id = ?`,
                [withdrawalId]
              );

              res.json({
                message: "Withdrawal processing",
                withdrawal_id: withdrawalId,
              });
            }
          );
        }
      );
    }
  );
});
/* ----------------------------------------------------
   📥 STK CALLBACK
---------------------------------------------------- */
router.post("/b2c-callback", (req, res) => {
  console.log("📩 B2C CALLBACK");
  console.log(JSON.stringify(req.body, null, 2));

  // ✅ ALWAYS ACK MPESA FIRST
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const result = req.body?.Result;
    if (!result) return;

    const {
      ResultCode,
      ResultDesc,
      TransactionID,
      OriginatorConversationID
    } = result;

    console.log("Result Desc",ResultDesc, "Withdrawal id", withdrawalId)


    // 🔒 START TRANSACTION
    db.getConnection((err, conn) => {
      if (err) {
        console.error("❌ DB connection error:", err);
        return;
      }

      const rollback = (error) => {
        console.error("❌ TX rollback:", error);
        conn.rollback(() => conn.release());
      };

      conn.beginTransaction(err => {
        if (err) return rollback(err);

        // 1️⃣ Lock withdrawal
        conn.query(
          `SELECT * FROM withdrawals WHERE id = ? FOR UPDATE`,
          [withdrawalId],
          (err, rows) => {
            if (err || !rows.length) return rollback(err || "Withdrawal missing");

            const wd = rows[0];
            const amount = Number(wd.amount);

            // ❌ FAILURE PATH
            if (ResultCode === 2040) {
               // ✅ SUCCESS PATH

            // 2️⃣ Update withdrawal
            conn.query(
              `UPDATE withdrawals
               SET status = 'COMPLETED', mpesa_ref = ?
               WHERE id = ?`,
              [TransactionID, withdrawalId],
              err => {
                if (err) return rollback(err);

                // 3️⃣ Debit wallet
                conn.query(
                  `UPDATE wallets
                   SET pending_balance = pending_balance - ?
                   WHERE user_id = ?`,
                  [amount, wd.user_id],
                  err => {
                    if (err) return rollback(err);
                    let amount_proflie = 0;
                    // 4️⃣ 🎯 MINUS GOAL RAISED
                    conn.query(
                      `
                      UPDATE profiles
                      SET goal_raised = ?
                      WHERE id = ? AND status = 'ACTIVE'
                      `,
                      [amount_proflie, wd.user_id],
                      (err, result) => {
                        if (err) return rollback(err);

                        if (result.affectedRows === 0) {
                          console.warn("⚠️ Profile not updated:", wd.user_id);
                        }

                        insertLedger();
                      }
                    );
                  }
                );
              }
            );

            // 5️⃣ Wallet ledger
            function insertLedger() {
              conn.query(

                `
                INSERT INTO wallet_ledger
                (user_id, uid, entry_type, direction,
                 gross_amount, fee_amount, net_amount,
                 balance_after, reference, status)
                VALUES (?, ?, 'WITHDRAWAL_COMPLETED', 'DEBIT',
                        ?, ?, ?, ?, ?, 'COMPLETED')
                `,
                [
                  wd.user_id,
                  wd.uid,
                  amount,
                  0,
                  0,
                  0,
                  TransactionID
                ],
                err => {
                  if (err) return rollback(err);

                  // ✅ COMMIT EVERYTHING
                  conn.commit(() => {
                    conn.release();
                    console.log("✅ Withdrawal fully completed:", TransactionID);
                  });
                }
              );
            }
            }else{
              
            }

           
          }
        );
      });
    });
  } catch (err) {
    console.error("❌ B2C callback fatal error:", err);
  }
});



module.exports = router;
