const express = require("express");
const router = express.Router();
const {getWallet,getLedger,getBalance,getWalletByUid} = require("../controllers/wallet.controller");


router.get("/get-ledger/:user_id", getLedger);
router.get("/get-balance/:uid", getBalance);
router.get("/get-wallet/:uid", getWalletByUid);
router.get("/:user_id", getWallet); // LAST
module.exports = router;
