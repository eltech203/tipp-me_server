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



 
exports.callback = async function(req, res )  {
  console.log("------MPESA CALLBACK ----" )

   try {
    console.log("Callback Desc:", callback.ResultDesc);
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

    



  
  } catch (err) {
    console.error("❌ Callback handling error:", err.message);
  }










};
