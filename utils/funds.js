const db = require("../config/db");
const redis = require("../config/redis");
const util = require("util");

const query = util.promisify(db.query).bind(db);
const getConnection = util.promisify(db.getConnection).bind(db);


exports.releaseFundsIfGoalReached = async ({
  profile_id,
})=>{
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