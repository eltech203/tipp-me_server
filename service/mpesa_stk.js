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
  const { phone, amount, profile_id } = req.body;

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
          "https://tipp-meserver-production.up.railway.app/api/payments/callback",
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
router.post("/callback", async (req, res) => {
  console.log("📩 MPESA CALLBACK");
  console.log(JSON.stringify(req.body, null, 2));

  // ALWAYS ACK MPESA
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback || callback.ResultCode !== 0) return;

    const meta = paymentMetaStore[callback.CheckoutRequestID];
    if (!meta) {
      console.error("❌ Missing meta data");
      return;
    }

    const { profile_id, uid } = meta;

    if (!profile_id || isNaN(profile_id)) {
      console.error("❌ Invalid profile_id:", profile_id);
      return;
    }

    const items = callback.CallbackMetadata.Item;
    const amount = Number(items.find(i => i.Name === "Amount")?.Value);
    const receipt = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;

    if (!amount || !receipt) return;

    const fee = Number((amount * 0.05).toFixed(2));
    const net = Number((amount - fee).toFixed(2));

    // INSERT WALLET LEDGER
    db.query(
      `INSERT INTO wallet_ledger
       (user_id,uid, entry_type, direction, gross_amount, fee_amount, net_amount, reference)
       VALUES (?, ?, 'TIP_RECEIVED', 'CREDIT', ?, ?, ?, ?)`,
      [profile_id, uid, amount, fee, net, receipt],
      (err) => {
        if (err) {
          console.error("❌ wallet_ledger insert error:", err);
          return;
        }

        // UPDATE WALLET
        db.query(
          `UPDATE wallets
           SET pending_balance = pending_balance + ?
           WHERE uid = ?`,
          [net, uid],
          (err2) => {
            if (err2) {
              console.error("❌ wallet update error:", err2);
              return;
            }

            console.log("✅ Payment credited:", receipt);
            delete paymentMetaStore[callback.CheckoutRequestID];
          }
        );
      }
    );
  } catch (err) {
    console.error("❌ Callback crash:", err);
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
