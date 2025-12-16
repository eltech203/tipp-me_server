const db = require("../config/db");
const redis = require("../config/redis");

exports.requestOtp = async (req, res) => {
  const { phone } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000);

  await redis.setEx(`otp:${phone}`, 300, otp);

  // send SMS here
  res.json({ message: "OTP sent" });
};

exports.verifyOtp = async (req, res) => {
  const { phone, otp } = req.body;
  const savedOtp = await redis.get(`otp:${phone}`);

  if (savedOtp !== otp)
    return res.status(400).json({ error: "Invalid OTP" });

  db.query(
    "SELECT * FROM users WHERE phone = ?",
    [phone],
    (err, rows) => {
      if (rows.length) return res.json(rows[0]);

      db.query(
        "INSERT INTO users (phone) VALUES (?)",
        [phone],
        () => res.json({ phone })
      );
    }
  );
};
