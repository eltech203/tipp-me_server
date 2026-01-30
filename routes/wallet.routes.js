const express = require("express");
const router = express.Router();
const {getWallet,getLedger,getBalance,getWalletByUid} = require("../controllers/wallet.controller");

router.get("/:user_id", getWallet);
router.get("/get-ledger/:user_id", getLedger);
router.get("/get-balance/:uid", getBalance);
router.get("/get-wallet/:uid", getWalletByUid);


module.exports = router;
