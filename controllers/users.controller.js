const db = require("../config/db");
const redis = require("../config/redis");

/**
 * CREATE user
 * POST /users
 */
exports.create = async (req, res) => {
  const { uid, phone } = req.body; // from Firebase
  const cacheKey = `user:${uid}`;

  db.query(
    "INSERT INTO users (uid, phone) VALUES (?, ?)",
    [uid, phone],
    async (err, result) => {
      if (err) {
        if (err.code === "ER_DUP_ENTRY") {
          return res.status(409).json({ error: "User already exists" });
        }
        return res.status(500).json({ error: err.message });
      }

      const user = {
        id: result.insertId,
        uid,
        phone,
        status: "ACTIVE"
      };

      await redis.setEx(cacheKey, 3600, JSON.stringify(user));
      res.status(201).json(user);
    }
  );
};

/**
 * READ own user
 * GET /users/me
 */
exports.getMe = async (req, res) => {
  const { uid } = req.params;
  const cacheKey = `user:${uid}`;

  const cached = await redis.get(cacheKey);
  if (cached) return res.json(JSON.parse(cached));

  db.query(
    "SELECT * FROM users WHERE uid = ? LIMIT 1",
    [uid],
    async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!rows.length)
        return res.status(404).json({ error: "User not found" });

      await redis.setEx(cacheKey, 3600, JSON.stringify(rows[0]));
      res.json(rows[0]);
    }
  );
};

/**
 * UPDATE own user
 * PUT /users/me
 */
exports.updateMe = async (req, res) => {
  const { uid } = req.user;
  const { status } = req.body;

  if (!["ACTIVE", "BLOCKED"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  db.query(
    "UPDATE users SET status = ? WHERE uid = ?",
    [status, uid],
    async (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!result.affectedRows)
        return res.status(404).json({ error: "User not found" });

      await redis.del(`user:${uid}`);
      res.json({ message: "User updated" });
    }
  );
};

/**
 * DELETE own user (soft delete)
 * DELETE /users/me
 */
exports.deleteMe = async (req, res) => {
  const { uid } = req.user;

  db.query(
    "UPDATE users SET status = 'BLOCKED' WHERE uid = ?",
    [uid],
    async (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!result.affectedRows)
        return res.status(404).json({ error: "User not found" });

      await redis.del(`user:${uid}`);
      res.json({ message: "User blocked" });
    }
  );
};
