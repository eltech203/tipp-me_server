const express = require("express");
const router = express.Router();
const payment = require("../controllers/payment.controller");

router.post("/stk-push", payment.stkPush);
router.post("/callback", payment.callback);

module.exports = router;
