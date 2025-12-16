const express = require("express");
const router = express.Router();
const admin = require("../controllers/admin.controller");

router.get("/withdrawals", admin.allWithdrawals);
router.get("/ledger/:user_id", admin.userLedger);

module.exports = router;
