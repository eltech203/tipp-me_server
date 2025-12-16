const db = require("../config/db");
const redis = require("../config/redis");
const mpesa = require("../service/mpesa.service");

exports.stkPush = async (req, res) => {
  const { profile_id, phone, amount } = req.body;
  const reference = `TIP-${Date.now()}`;

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

exports.callback = async (req, res) => {
  console.log("------MPESA CALLBACK ----");
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  const stk = req.body.Body.stkCallback;

  const meta = stk.CallbackMetadata.Item;
  const amount = meta.find(i => i.Name === "Amount")?.Value;
  const receipt = meta.find(i => i.Name === "MpesaReceiptNumber")?.Value;

  db.query(
    "SELECT * FROM payment_intents WHERE reference = ?",
    [stk.AccountReference],
    (err, rows) => {
      if (!rows.length) return;

      const intent = rows[0];
      const fee = amount * 0.05;
      const net = amount - fee;

      db.query(
        `INSERT INTO wallet_ledger
        (user_id, entry_type, direction, gross_amount, fee_amount, net_amount, reference)
        VALUES (?, 'TIP_RECEIVED', 'CREDIT', ?, ?, ?, ?)`,
        [intent.user_id, amount, fee, net, receipt]
      );

      db.query(
        `UPDATE wallets SET pending_balance = pending_balance + ?
         WHERE user_id = ?`,
        [net, intent.user_id]
      );
    }
  );
};
