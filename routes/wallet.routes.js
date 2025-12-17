const express = require("express");
const router = express.Router();
const wallet = require("../controllers/wallet.controller");

router.get("/:user_id", wallet.getWallet);
router.get("/get-ledger/:user_id", wallet.getLedger);
router.get("/get-balance/:uid", wallet.getBalance);
router.get("/get-wallet/:uid", wallet.getWalletByUid);


module.exports = router;
