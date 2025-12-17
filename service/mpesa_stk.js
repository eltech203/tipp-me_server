const express = require("express");
const request = require("request");
const bodyParser = require("body-parser");
const moment = require("moment");
const router = express.Router();
const cors = require("cors");
const db = require("../config/db");

///-----Port-----///
const _urlencoded = express.urlencoded({ extended: false });
router.use(cors());
router.use(express.json());
router.use(express.static("public"));

// ---- ALLOW ACCESS ----- //
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Methods", "PUT, POST, PATCH, DELETE, GET");
    return res.status(200).json({});
  }
  next();
});

// ---- TEST ROUTE ---- //
router.get("/", (req, res) => {
  res.status(200).send({ message: "payments" });
});

// --------------------------------- //
// 🔑 ACCESS TOKEN MIDDLEWARE
// --------------------------------- //

const consumer_key = process.env.MPESA_CONSUMER_KEY; 
const consumer_secret =process.env.MPESA_CONSUMER_SECRET; 
const auth = Buffer.from(consumer_key + ":" + consumer_secret).toString("base64");

function access(req, res, next) {
  request(
    {
      url: "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      headers: { Authorization: "Basic " + auth },
    },
    (error, response, body) => {
      if (error) {
        console.error("❌ Error getting token:", error);
        return res.status(500).json({ error: "Failed to get access token" });
      }
      req.access_token = JSON.parse(body).access_token;
      next();
    }
  );
}

// Temporary store (use Redis in production)
const paymentMetaStore = {};

// --------------------------------- //
// 📲 STK PUSH
// --------------------------------- //
let phoneNumber, amount, user_id, candidate_id, category_id, transaction_type, vote_count;

router.post("/stk-push", access, express.urlencoded({ extended: false }), function (req, res) {
  phoneNumber = req.body.phone;
  amount = req.body.amount;
  profile_id = req.body.profile_id;
  reference = `TIP-${Date.now()}`;

  let endpoint = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";
  let auth = "Bearer " + req.access_token;

  let shortCode = `174379`; // Sandbox Paybill
  let passKey = `bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919`;

  const timeStamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, -3);
  const password = Buffer.from(`${shortCode}${passKey}${timeStamp}`).toString("base64");

  request(
    {
      url: endpoint,
      method: "POST",
      headers: { Authorization: auth },
      json: {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timeStamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phoneNumber,
        PartyB: shortCode,
        PhoneNumber: phoneNumber,
        CallBackURL: "https://tipp-meserver-production.up.railway.app/api/payments/callback",
        AccountReference: reference,
        TransactionDesc: "Payment",
      },
    },
    (error, response, body) => {
      if (error) {
        console.log(error);
        return res.status(404).json(error);
      }

      // ✅ Store meta data for callback
      if (body.CheckoutRequestID) {
        paymentMetaStore[body.CheckoutRequestID] = {
          amount,
          profile_id,
          reference,
           // ⭐ CHANGE
        };
      }

     return res.status(200).json(body);
    }
  );
});

// --------------------------------- //
// 📥 STK CALLBACK (FULL METHOD)
// --------------------------------- //
router.post("/callback", async (req, res) => {
  console.log("📩 STK CALLBACK RECEIVED");
  console.log(JSON.stringify(req.body, null, 2));

  // ALWAYS acknowledge Mpesa immediately
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      console.error("❌ No stkCallback found");
      return;
    }

    const {
      ResultCode,
      ResultDesc,
      CheckoutRequestID,
      CallbackMetadata,
    } = callback;

    // ❌ Failed transaction
    if (ResultCode !== 0) {
      console.warn("⚠️ Transaction failed:", ResultDesc);
      return;
    }

    // 🔑 Get metadata saved during stk push
    const meta = paymentMetaStore[CheckoutRequestID];
    if (!meta) {
      console.error("❌ No metadata for CheckoutRequestID:", CheckoutRequestID);
      return;
    }

    const { profile_id, reference } = meta;

    // 📦 Extract Mpesa values
    const items = CallbackMetadata.Item;
    const amount = items.find(i => i.Name === "Amount")?.Value;
    const receipt = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
    const phone = items.find(i => i.Name === "PhoneNumber")?.Value;

    if (!amount || !receipt) {
      console.error("❌ Missing amount or receipt");
      return;
    }

    // 🧮 Calculate fee & net
    const fee = amount * 0.05;
    const net = amount - fee;

    // 💾 INSERT wallet ledger
    db.query(
      `INSERT INTO wallet_ledger
        (user_id, entry_type, direction, gross_amount, fee_amount, net_amount, reference)
       VALUES (?, 'TIP_RECEIVED', 'CREDIT', ?, ?, ?, ?)`,
      [profile_id, amount, fee, net, receipt],
      (err) => {
        if (err) {
          console.error("❌ wallet_ledger insert error:", err);
          return;
        }

        // 💰 UPDATE wallet balance
        db.query(
          `UPDATE wallets
           SET pending_balance = pending_balance + ?
           WHERE user_id = ?`,
          [net, profile_id],
          (err2) => {
            if (err2) {
              console.error("❌ wallet update error:", err2);
              return;
            }

            console.log("✅ Payment saved successfully:", receipt);

            // 🧹 Cleanup
            delete paymentMetaStore[CheckoutRequestID];
          }
        );
      }
    );
  } catch (err) {
    console.error("❌ Callback processing error:", err);
  }
});


router.post(
    "/stk-push/query",access,function(req, res, next) {
        let _checkoutRequestId = req.body.checkoutRequestId;

       let auth = "Bearer " + req.access_token;

        let endpoint = "https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query";
        let _shortCode = "174379";
        let _passKey =
            "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
        const timeStamp = new Date()
            .toISOString()
            .replace(/[^0-9]/g, "")
            .slice(0, -3);
        const password = Buffer.from(
            `${_shortCode}${_passKey}${timeStamp}`
        ).toString("base64");

        request({
                url: endpoint,
                method: "POST",
                headers: {
                    Authorization:  auth,
                },
                json: {
                    BusinessShortCode: _shortCode,
                    Password: password,
                    Timestamp: timeStamp,
                    CheckoutRequestID: _checkoutRequestId,
                },
            },
            function(error, response, body) {
                if (error) {
                    console.log(error);
                    res.status(404).json(body);
                } else {
                    var resDesc = body.ResponseDescription;
                    res.status(200).json(body);
                    if (res.status(200)) {
                       
                        var resDesc = body.ResponseDescription;
                        var resultDesc = body.ResultDesc;
                        console.log("Query Body", body);
                    }

                    next();
                }
            }
        );
    }
);



module.exports = router;