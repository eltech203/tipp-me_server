const db = require("../config/db");

exports.allWithdrawals = (req, res) => {
  db.query("SELECT * FROM withdrawals", (err, rows) => res.json(rows));
};

exports.userLedger = (req, res) => {
  db.query(
    "SELECT * FROM wallet_ledger WHERE user_id = ?",
    [req.params.user_id],
    (err, rows) => res.json(rows)
  );
};
