const db = require("../config/db");
const redis = require("../config/redis");

exports.getWallet = (req, res) => {
  db.query(
    "SELECT * FROM wallets WHERE user_id = ?",
    [req.params.user_id],
    (err, rows) => res.json(rows[0])
  );
};

exports.getLedger = (req, res) => {
  db.query(
    "SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC",
    [req.params.user_id],
    (err, rows) => res.json(rows)
  );
};


exports.getBalance = async (req, res) => {
  const { uid } = req.params;
  const cacheKey = `wallet:balance:${uid}`;

  // 1️⃣ Redis (FAST)
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json({ balance: Number(cached) });
  }

  // 2️⃣ Get wallet
  db.query(
    "SELECT id FROM wallets WHERE user_id = ? AND status = 'ACTIVE'",
    [uid],
    (err, wallets) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!wallets.length)
        return res.status(404).json({ error: "Wallet not found" });

      const walletId = wallets[0].id;

      // 3️⃣ Calculate balance from ledger
      db.query(
        `SELECT IFNULL(SUM(
            CASE
              WHEN type = 'CREDIT' THEN amount
              WHEN type = 'DEBIT' THEN -amount
            END
          ), 0) AS balance
         FROM ledger_entries
         WHERE wallet_id = ?`,
        [walletId],
        async (err, rows) => {
          if (err) return res.status(500).json({ error: err.message });

          const balance = Number(rows[0].balance);

          // 4️⃣ Cache (safe)
          await redis.setEx(cacheKey, 30, balance);

          res.json({ balance });
        }
      );
    }
  );
};