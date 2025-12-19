const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  console.log("Incoming:", req.method, req.url);
  next();
});

app.use("/api/user", require("./routes/users.routes"));
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/profiles", require("./routes/profile.routes"));
app.use("/api/payments", require("./service/mpesa_stk"));
app.use("/api/b2c", require("./service/mpesa_b2c"));
app.use("/api/wallets", require("./routes/wallet.routes"));
app.use("/api/withdrawals", require("./routes/withdrawal.routes"));
app.use("/api/admin", require("./routes/admin.routes"));

// Base route
app.get("/", (req, res) => res.send("tipme Backend API Running 🚀"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
