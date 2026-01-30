const db = require("../config/db");
const redis = require("../config/redis");
const util = require("util");

const query = util.promisify(db.query).bind(db);
const getConnection = util.promisify(db.getConnection).bind(db);

const walletCacheKey = (uid) => `wallet:${uid}`;

/**
 * 🔓 Auto-release pending balance when goal is reached
 */
const releaseFundsIfGoalReached = async (profile_id) => {
  const conn = await getConnection();

  try {
    await util.promisify(conn.beginTransaction).bind(conn)();

    // 1️⃣ Lock profile
    const [profile] = await util.promisify(conn.query).bind(conn)(
      `
      SELECT goal_amount, goal_raised
      FROM profiles
      WHERE id = ?
      FOR UPDATE
      `,
      [profile_id]
    );

    if (
      !profile ||
      profile.goal_amount === null ||
      Number(profile.goal_raised) < Number(profile.goal_amount)
    ) {
      await util.promisify(conn.commit).bind(conn)();
      conn.release();
      return;
    }

    // 2️⃣ Lock wallet
    const [wallet] = await util.promisify(conn.query).bind(conn)(
      `
      SELECT pending_balance, available_balance
      FROM wallets
      WHERE user_id = ?
      FOR UPDATE
      `,
      [profile_id]
    );

    if (!wallet || Number(wallet.pending_balance) <= 0) {
      await util.promisify(conn.commit).bind(conn)();
      conn.release();
      return;
    }

    const pending = Number(wallet.pending_balance);
    const newAvailable =
      Number(wallet.available_balance || 0) + pending;

    // 3️⃣ Move funds
    await util.promisify(conn.query).bind(conn)(
      `
      UPDATE wallets
      SET pending_balance = 0,
          available_balance = ?
      WHERE user_id = ?
      `,
      [newAvailable, profile_id]
    );

    // 4️⃣ Ledger entry
    await util.promisify(conn.query).bind(conn)(
      `
      INSERT INTO wallet_ledger
      (user_id, entry_type, direction, gross_amount, net_amount, reference)
      VALUES (?, 'GOAL_RELEASE', 'CREDIT', ?, ?, 'GOAL_REACHED')
      `,
      [profile_id, pending, pending]
    );

    await util.promisify(conn.commit).bind(conn)();
    conn.release();

    console.log("🎯 Goal reached — funds released:", profile_id);
  } catch (err) {
    await util.promisify(conn.rollback).bind(conn)();
    conn.release();
    console.error("❌ Goal release failed:", err);
  }
};

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
