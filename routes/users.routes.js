const express = require("express");
const router = express.Router();
const users = require("../controllers/users.controller");



router.post("/add_users",  users.create);
router.get("/get-user/:uid",  users.getMe);
router.put("/users/me",  users.updateMe);
router.delete("/users/me",  users.deleteMe);

module.exports = router;
