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
                CommandID: "BusinessPayment",
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

  try {
    const result = req.body?.Result;
    if (!result) {
      console.warn("⚠️ No Result object");
      return;
    }

    const {
      ResultCode,
      ResultDesc,
      TransactionID,
    } = result;


    // 🔎 Load withdrawal
    db.query(
      `SELECT * FROM withdrawals WHERE id = ?`,
      [withdrawalId],
      (err, rows) => {
        if (err || !rows.length) {
          console.error("❌ Withdrawal not found:", withdrawalId);
          return;
        }

        const wd = rows[0];

        // ❌ FAILURE PATH
        if (ResultCode !== 0) {
          console.warn("❌ B2C FAILED:", ResultDesc);

          // 1️⃣ Update withdrawal
          db.query(
            `UPDATE withdrawals
             SET status = 'FAILED', mpesa_ref = ?
             WHERE id = ?`,
            [TransactionID || "FAILED", withdrawalId]
          );

          // 2️⃣ Ledger (optional audit)
          db.query(
            `INSERT INTO wallet_ledger
             (user_id, uid, entry_type, direction, gross_amount, net_amount, reference)
             VALUES (?, ?, 'WITHDRAWAL_FAILED', 'DEBIT', ?, ?, ?)`,
            [
              wd.user_id,
              wd.uid,
              wd.amount,
              0,
              TransactionID || "FAILED"
            ]
          );

          return;
        }

        // ✅ SUCCESS PATH (REAL PAYOUT)
        const params = result?.ResultParameters?.ResultParameter || [];
        const getParam = (k) => params.find(p => p.Key === k)?.Value;

        const amount = Number(getParam("TransactionAmount")) || wd.amount;
        const receipt = getParam("TransactionReceipt") || TransactionID;

        // 1️⃣ Update withdrawal
        db.query(
          `UPDATE withdrawals
           SET status = 'COMPLETED', mpesa_ref = ?
           WHERE id = ?`,
          [receipt, withdrawalId]
        );

        // 2️⃣ Debit wallet
        db.query(
          `UPDATE wallets
           SET available_balance = available_balance - ?
           WHERE user_id = ?`,
          [amount, wd.user_id]
        );

        // 3️⃣ Wallet ledger
        db.query(
          `INSERT INTO wallet_ledger
           (user_id, uid, entry_type, direction, gross_amount, net_amount, reference)
           VALUES (?, ?, 'WITHDRAWAL', 'DEBIT', ?, ?, ?)`,
          [wd.user_id, wd.uid, amount, amount, receipt]
        );

        console.log("✅ Withdrawal completed:", receipt);
      }
    );
  } catch (err) {
    console.error("❌ B2C CALLBACK CRASH:", err);
  }
});



module.exports = router;
