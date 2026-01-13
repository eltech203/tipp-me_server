const db = require("../config/db");
const redis = require("../config/redis");
const util = require("util");

const query = util.promisify(db.query).bind(db);


const walletCacheKey = (uid) => `wallet:${uid}`;

// ✅ Get wallet balance by UID
exports.getWalletByUid = async (req, res) => {
  const { uid } = req.params;

  try {
    // 1️⃣ Check Redis
    const cached = await redis.get(walletCacheKey(uid));
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    // 2️⃣ Get wallet
    const [wallet] = await query(
      `
      SELECT 
        user_id,
        uid,
        available_balance,
        pending_balance,
        locked_balance,
        updated_at
      FROM wallets
      WHERE uid = ?
      `,
      [uid]
    );

    // 3️⃣ Auto-create wallet if missing
    if (!wallet) {
      const [user] = await query(
        `SELECT id FROM users WHERE uid = ?`,
        [uid]
      );

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      await query(
        `
        INSERT INTO wallets (user_id, uid)
        VALUES (?, ?)
        `,
        [user.id, uid]
      );

      const newWallet = {
        user_id: user.id,
        uid,
        available_balance: 0,
        pending_balance: 0,
        locked_balance: 0,
        total_balance: 0
      };

      await redis.setEx(walletCacheKey(uid), 100, JSON.stringify(newWallet));
      return res.status(200).json(newWallet);
    }

    // 4️⃣ Build response
    const response = {
      ...wallet,
      total_balance:
        Number(wallet.available_balance) +
        Number(wallet.pending_balance) +
        Number(wallet.locked_balance)
    };

    // 5️⃣ Cache
    await redis.setEx(walletCacheKey(uid), 200, JSON.stringify(response));

    res.status(200).json(response);
  } catch (err) {
    console.error("❌ Get wallet error:", err);
    res.status(500).json({ message: "Server error" });
  }
};





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
          await redis.setEx(cacheKey, 100, balance);

          res.json({ balance });
        }
      );
    }
  );
};