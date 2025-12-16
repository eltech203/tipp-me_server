const express = require("express");
const router = express.Router();
const auth = require("../controllers/auth.controller");

router.post("/request-otp", auth.requestOtp);
router.post("/verify-otp", auth.verifyOtp);

module.exports = router;
