const express = require("express");
const router = express.Router();
const wallet = require("../controllers/wallet.controller");

router.get("/:user_id", wallet.getWallet);
router.get("/:user_id/ledger", wallet.getLedger);
router.get("/get-balance/:uid", wallet.getBalance);


module.exports = router;
