const db = require("../config/db");

exports.requestWithdrawal = (req, res) => {
  const { user_id, amount, phone } = req.body;

  db.query(
    `INSERT INTO withdrawals (user_id, amount, phone)
     VALUES (?, ?, ?)`,
    [user_id, amount, phone]
  );

  db.query(
    `INSERT INTO wallet_ledger
     (user_id, entry_type, direction, net_amount)
     VALUES (?, 'WITHDRAWAL_REQUEST', 'DEBIT', ?)`,
    [user_id, amount]
  );

  db.query(
    `UPDATE wallets
     SET available_balance = available_balance - ?
     WHERE user_id = ?`,
    [amount, user_id]
  );

  res.json({ message: "Withdrawal requested" });
};
