const express = require("express");
const router = express.Router();
const withdrawal = require("../controllers/withdrawal.controller");

router.post("/", withdrawal.requestWithdrawal);

module.exports = router;
