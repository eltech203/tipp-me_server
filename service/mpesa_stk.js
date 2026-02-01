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

function accessToken(req, res, next) {
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
router.post("/stk-push", accessToken, (req, res) => {
  const { phone, amount, profile_id, uid } = req.body;

  console.log("STK Push Request:", req.body);


  if (!phone || !amount || !profile_id) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const shortCode = "174379";
  const passKey =
    "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, -3);
  const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString(
    "base64"
  );

  const reference = `TIP-${Date.now()}`;

  request(
    {
      url: "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.access_token}`,
      },
      json: {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Number(amount),
        PartyA: phone,
        PartyB: shortCode,
        PhoneNumber: phone,
        CallBackURL:
          "https://tipp-meserver-production-5b51.up.railway.app/api/payments/callback",
        AccountReference: reference,
        TransactionDesc: "Tip Payment",
      },
    },
    (error, response, body) => {
      if (error) {
        console.error("❌ STK error:", error);
        return res.status(500).json(error);
      }

      if (body.CheckoutRequestID) {
        paymentMetaStore[body.CheckoutRequestID] = {
          profile_id: Number(profile_id),
          reference,
          uid,
        };
      }

      res.status(200).json(body);
    }
  );
});

/* ----------------------------------------------------
   📥 STK CALLBACK
---------------------------------------------------- */
router.post("/callback", (req, res) => {
  console.log("📩 MPESA CALLBACK");
  console.log(JSON.stringify(req.body, null, 2));

  // ✅ ALWAYS ACK MPESA FIRST
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback || callback.ResultCode !== 0) return;

    const meta = paymentMetaStore[callback.CheckoutRequestID];
    if (!meta) {
      console.error("❌ Missing payment meta");
      return;
    }

    const { profile_id, uid, reference } = meta;

    if (!profile_id || isNaN(profile_id)) {
      console.error("❌ Invalid profile_id:", profile_id);
      return;
    }

    // Extract MPESA values
    const items = callback.CallbackMetadata?.Item || [];
    const amount = Number(items.find(i => i.Name === "Amount")?.Value);
    const receipt = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;

    if (!amount || !receipt) return;

    const fee = Number((amount * 0.05).toFixed(2));
    const net = Number((amount - fee).toFixed(2));

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

        // 1️⃣ Lock or create user wallet
        conn.query(
          `SELECT pending_balance FROM wallets WHERE user_id = ? FOR UPDATE`,
          [profile_id],
          (err, rows) => {
            if (err) return rollback(err);

            let newUserBalance;

            if (rows.length === 0) {
              newUserBalance = net;

              conn.query(
                `INSERT INTO wallets (user_id, uid, pending_balance)
                 VALUES (?, ?, ?)`,
                [profile_id, uid, net],
                err => {
                  if (err) return rollback(err);
                  insertLedger();
                }
              );
            } else {
              newUserBalance =
                Number(rows[0].pending_balance || 0) + net;

              conn.query(
                `UPDATE wallets
                 SET pending_balance = ?
                 WHERE user_id = ?`,
                [newUserBalance, profile_id],
                err => {
                  if (err) return rollback(err);
                  insertLedger();
                }
              );
            }

            // 2️⃣ Insert wallet ledger
            function insertLedger() {
              conn.query(
                `
                INSERT INTO wallet_ledger
                (user_id, uid, entry_type, direction,
                 gross_amount, fee_amount, net_amount,
                 balance_after, reference, status)
                VALUES (?, ?, 'TIP_RECEIVED', 'CREDIT',
                        ?, ?, ?, ?, ?, 'COMPLETED')
                `,
                [
                  profile_id,
                  uid,
                  amount,
                  fee,
                  net,
                  newUserBalance,
                  receipt
                ],
                err => {
                  if (err) return rollback(err);
                  updateGoalRaised();
                }
              );
            }

            function updateGoalRaised() {
                conn.query(
                    `
                    UPDATE profiles
                    SET goal_raised = goal_raised + ?
                    WHERE uid = ? AND status = 'ACTIVE'
                    `,
                    [net, uid],
                    (err, result) => {
                    if (err) return rollback(err);
                    creditPlatform(); // continue flow
                    }
                );
             }

            // 3️⃣ Lock platform wallet
            function creditPlatform() {
              conn.query(
                `SELECT balance FROM platform_wallet WHERE id = 1 FOR UPDATE`,
                (err, rows) => {
                  if (err) return rollback(err);

                  const platformBalance =
                    rows.length > 0 ? Number(rows[0].balance) : 0;

                  const newPlatformBalance = platformBalance + fee;

                  // Ensure platform wallet row exists
                  conn.query(
                    `INSERT INTO platform_wallet (id, balance)
                     VALUES (1, ?)
                     ON DUPLICATE KEY UPDATE balance = ?`,
                    [newPlatformBalance, newPlatformBalance],
                    err => {
                      if (err) return rollback(err);

                      // 4️⃣ Insert platform ledger
                      conn.query(
                        `
                        INSERT INTO platform_ledger
                        (entry_type, direction, amount, reference)
                        VALUES ('FEE', 'CREDIT', ?, ?)
                        `,
                        [fee, receipt],
                        err => {
                          if (err) return rollback(err);

                          // ✅ COMMIT EVERYTHING
                          conn.commit(() => {
                            conn.release();
                            console.log("✅ Payment credited:", receipt);
                          });
                        }
                      );
                    }
                  );
                }
              );
            }


          }
        );
      });



      
    });




  } catch (err) {
    console.error("❌ Callback fatal error:", err);
  }
});
/* ----------------------------------------------------
   🔎 STK QUERY
---------------------------------------------------- */
router.post("/stk-push/query", accessToken, (req, res) => {
  const { checkoutRequestId } = req.body;

  const shortCode = "174379";
  const passKey =
    "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, -3);
  const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString(
    "base64"
  );

  request(
    {
      url: "https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query",
      method: "POST",
      headers: { Authorization: `Bearer ${req.access_token}` },
      json: {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      },
    },
    (err, response, body) => {
      if (err) return res.status(500).json(err);
      res.status(200).json(body);
    }
  );
});

module.exports = router;
