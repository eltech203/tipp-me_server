const db = require("../config/db");
const redis = require("../config/redis");
const mpesa = require("../service/mpesa.service");

let profile_id,reference;
exports.stkPush = async (req, res) => {
  const { phone, amount } = req.body;
  profile_id = req.body;
  reference = `TIP-${Date.now()}`;

  db.query(
    `INSERT INTO payment_intents (profile_id, phone, amount, reference)
     VALUES (?, ?, ?, ?)`,
    [profile_id, phone, amount, reference]
  );

  try {
    const response = await mpesa.sendStk(phone, amount, reference);
    res.json(response);
  } catch (err) {

    res.status(500).json({ error: err.message });
  }
};



 
exports.callback = async function(req, res)  {
  console.log("------MPESA CALLBACK ----" )

   try {
    const callback = req.body.Body?.stkCallback;
    if (!callback) return console.error("❌ No stkCallback found in body");

    if (callback.ResultCode !== 0) {
      return console.warn("⚠️ Transaction failed:", callback.ResultDesc);
    }

    const metadata = callback.CallbackMetadata;
    if (!metadata) return console.error("❌ No CallbackMetadata found");

    const amount = metadata.Item.find((i) => i.Name === "Amount")?.Value;
    const receipt = metadata.Item.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
    const phone = metadata.Item.find((i) => i.Name === "PhoneNumber")?.Value;
    const transdate = new Date();
    const metaKey = callback.CheckoutRequestID;

    
 db.query(
    "SELECT * FROM payment_intents WHERE reference = ?",
    [reference],
    (err, rows) => {
      if (!rows.length) return;

      const intent = rows[0];
      const fee = amount * 0.05;
      const net = amount - fee;

      db.query(
        `INSERT INTO wallet_ledger
        (user_id, entry_type, direction, gross_amount, fee_amount, net_amount, reference)
        VALUES (?, 'TIP_RECEIVED', 'CREDIT', ?, ?, ?, ?)`,
        [profile_id, amount, fee, net, receipt]
      );

      db.query(
        `UPDATE wallets SET pending_balance = pending_balance + ?
         WHERE user_id = ?`,
        [net, profile_id]
      );
    }
  );


  
  } catch (err) {
    console.error("❌ Callback handling error:", err.message);
  }










};
