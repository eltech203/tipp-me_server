const db = require("../config/db");
const redisClient = require("../config/redis");
const util = require("util");

const query = util.promisify(db.query).bind(db);

// Redis keys
const profileByUidKey = (uid) => `profile:uid:${uid}`;
const profileByUsernameKey = (username) => `profile:username:${username}`;

/* ============================
   CREATE PROFILE
============================ */
exports.createProfile = async (req, res) => {
  const {
    user_id,
    uid,
    username,
    display_name,
    category,
    description,
    avatar_url,
    goal_amount
  } = req.body;

  console.log("Body:", req.body);

  if (!user_id || !uid || !username || !display_name || !category) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const result = await query(
      `INSERT INTO profiles (
        user_id, uid, username, display_name, category,
        description, avatar_url, goal_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        uid,
        username,
        display_name,
        category,
        description || null,
        avatar_url || null,
        goal_amount || null
      ]
    );

    res.status(201).json({
      message: "Profile created successfully",
      profile_id: result.insertId
    });
  } catch (err) {
    console.error("❌ Create profile error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================
   GET PROFILE BY UID
============================ */
exports.getProfileByUid = async (req, res) => {
  const { uid } = req.params;

  try {
    const cacheKey = profileByUidKey(uid);
    const cached = await redisClient.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [profile] = await query(
      `SELECT * FROM profiles WHERE uid = ?`,
      [uid]
    );

    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    await redisClient.setEx(cacheKey, 600, JSON.stringify(profile));
    res.json(profile);
  } catch (err) {
    console.error("❌ Get profile by uid error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================
   GET PROFILE BY USERNAME
============================ */
exports.getProfileByUsername = async (req, res) => {
  const { username } = req.params;

  try {
    const cacheKey = profileByUsernameKey(username);
    const cached = await redisClient.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [profile] = await query(
      `SELECT * FROM profiles WHERE username = ?`,
      [username]
    );

    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    await redisClient.setEx(cacheKey, 600, JSON.stringify(profile));
    res.json(profile);
  } catch (err) {
    console.error("❌ Get profile by username error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================
   UPDATE PROFILE
============================ */
exports.updateProfile = async (req, res) => {
  const { uid } = req.params;
  const updates = req.body;

  try {
    await query(
      `UPDATE profiles SET ? WHERE uid = ?`,
      [updates, uid]
    );

    // Invalidate cache
    await redisClient.del(profileByUidKey(uid));
    if (updates.username) {
      await redisClient.del(profileByUsernameKey(updates.username));
    }

    res.json({ message: "Profile updated successfully" });
  } catch (err) {
    console.error("❌ Update profile error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ============================
   DELETE PROFILE
============================ */
exports.deleteProfile = async (req, res) => {
  const { uid } = req.params;

  try {
    await query(`DELETE FROM profiles WHERE uid = ?`, [uid]);

    await redisClient.del(profileByUidKey(uid));

    res.json({ message: "Profile deleted successfully" });
  } catch (err) {
    console.error("❌ Delete profile error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
