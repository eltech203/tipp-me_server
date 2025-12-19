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
                QueueTimeOutURL: "https://tipp-meserver-production.up.railway.app/api/payments",
                ResultURL: "https://tipp-meserver-production.up.railway.app/api/b2c/b2c-callback",
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

  // ALWAYS ACK MPESA
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  const result = req.body?.Result;
  if (!result) return;

  const { ResultCode, ResultDesc, TransactionID } = result;

  // ⚠️ YOU MUST DERIVE THIS CORRECTLY
  // Example if Remarks = WD-12

  if (!withdrawalId) {
    console.error("❌ withdrawalId missing");
    return;
  }

  // 🔐 START TRANSACTION
  db.getConnection((err, conn) => {
    if (err) {
      console.error("❌ DB connection error:", err);
      return;
    }

    conn.beginTransaction(err => {
      if (err) {
        conn.release();
        console.error("❌ Transaction start failed:", err);
        return;
      }

      // 1️⃣ LOAD WITHDRAWAL
      conn.query(
        `SELECT * FROM withdrawals WHERE id = ? FOR UPDATE`,
        [withdrawalId],
        (err, rows) => {
          if (err || !rows.length) {
            return conn.rollback(() => conn.release());
          }

          const wd = rows[0];
          const amount = Number(wd.amount);

          // ❌ FAILURE PATH
          if (ResultCode !== 0) {
            conn.query(
              `UPDATE withdrawals
               SET status = 'FAILED', mpesa_ref = ?
               WHERE id = ?`,
              [TransactionID || "FAILED", withdrawalId],
              () => {
                conn.commit(() => conn.release());
              }
            );
            return;
          }

          // ✅ SUCCESS PATH
          // 2️⃣ UPDATE WITHDRAWAL
          conn.query(
            `UPDATE withdrawals
             SET status = 'COMPLETED', mpesa_ref = ?
             WHERE id = ?`,
            [TransactionID, withdrawalId],
            (err) => {
              if (err) return conn.rollback(() => conn.release());

              // 3️⃣ DEBIT WALLET
              conn.query(
                `UPDATE wallets
                 SET pending_balance = pending_balance - ?
                 WHERE user_id = ?`,
                [amount, wd.user_id],
                (err) => {
                  if (err) return conn.rollback(() => conn.release());

                  // 4️⃣ 🎯 UPDATE PROFILE GOAL
                  conn.query(
                    `UPDATE profiles
                     SET goal_raised = GREATEST(goal_raised - ?, 0)
                     WHERE user_id = ?`,
                    [amount, wd.user_id],
                    (err) => {
                      if (err) return conn.rollback(() => conn.release());

                      // 5️⃣ WALLET LEDGER
                      conn.query(
                        `INSERT INTO wallet_ledger
                         (user_id, uid, entry_type, direction, gross_amount, net_amount, reference)
                         VALUES (?, ?, 'WITHDRAWAL', 'DEBIT', ?, ?, ?)`,
                        [wd.user_id, wd.uid, amount, amount, TransactionID],
                        (err) => {
                          if (err) return conn.rollback(() => conn.release());

                          // ✅ COMMIT EVERYTHING
                          conn.commit(err => {
                            if (err) {
                              return conn.rollback(() => conn.release());
                            }
                            conn.release();
                            console.log("✅ Withdrawal fully completed:", TransactionID);
                          });
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    });
  });
});



module.exports = router;
