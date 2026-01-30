const db = require("../config/db");
const redis = require("../config/redis");
const {releaseFundsIfGoalReached} = require("../utils/funds");

const util = require("util");

const query = util.promisify(db.query).bind(db);
const getConnection = util.promisify(db.getConnection).bind(db);

const walletCacheKey = (uid) => `wallet:${uid}`;

exports.getBalance = async (req, res) => {
  const { uid } = req.params;

  try {
    const [wallet] = await query(
      `
      SELECT 
        available_balance,
        pending_balance,
        locked_balance
      FROM wallets
      WHERE uid = ?
      `,
      [uid]
    );

    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    const total =
      Number(wallet.available_balance) +
      Number(wallet.pending_balance) +
      Number(wallet.locked_balance);

    res.json({
      available_balance: Number(wallet.available_balance),
      pending_balance: Number(wallet.pending_balance),
      locked_balance: Number(wallet.locked_balance),
      total_balance: total,
    });
  } catch (err) {
    console.error("❌ Get balance error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
/**
 * 🔓 Auto-release pending balance when goal is reached
 */

/**
 * ✅ Get wallet by UID (auto-release enabled)
 */
exports.getWalletByUid = async (req, res) => {
  const { uid } = req.params;

  try {
    // 1️⃣ Redis
    const cached = await redis.get(walletCacheKey(uid));
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    // 2️⃣ Wallet
    const [wallet] = await query(
      `
      SELECT user_id, uid, available_balance, pending_balance, locked_balance, updated_at
      FROM wallets
      WHERE uid = ?
      `,
      [uid]
    );

    // 3️⃣ Auto-create wallet
    if (!wallet) {
      const [user] = await query(
        `SELECT id FROM users WHERE uid = ?`,
        [uid]
      );

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      await query(
        `INSERT INTO wallets (user_id, uid) VALUES (?, ?)`,
        [user.id, uid]
      );

      const newWallet = {
        user_id: user.id,
        uid,
        available_balance: 0,
        pending_balance: 0,
        locked_balance: 0,
        total_balance: 0,
      };

      await redis.setEx(walletCacheKey(uid), 120, JSON.stringify(newWallet));
      return res.status(200).json(newWallet);
    }

    // 🔓 AUTO RELEASE FUNDS IF GOAL HIT
    await releaseFundsIfGoalReached(wallet.user_id);

    // 🔄 Reload wallet after release
    const [updatedWallet] = await query(
      `
      SELECT user_id, uid, available_balance, pending_balance, locked_balance, updated_at
      FROM wallets
      WHERE uid = ?
      `,
      [uid]
    );

    const response = {
      ...updatedWallet,
      total_balance:
        Number(updatedWallet.available_balance) +
        Number(updatedWallet.pending_balance) +
        Number(updatedWallet.locked_balance),
    };

    // 4️⃣ Cache
    await redis.setEx(walletCacheKey(uid), 200, JSON.stringify(response));

    res.status(200).json(response);
  } catch (err) {
    console.error("❌ Get wallet error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * ✅ Get wallet by user_id (legacy)
 */
exports.getWallet = (req, res) => {
  db.query(
    "SELECT * FROM wallets WHERE user_id = ?",
    [req.params.user_id],
    (err, rows) => res.json(rows[0])
  );
};

/**
 * 📜 Wallet ledger
 */
exports.getLedger = (req, res) => {
  db.query(
    "SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC",
    [req.params.user_id],
    (err, rows) => res.json(rows)
  );
};
