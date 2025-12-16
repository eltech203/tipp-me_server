const express = require("express");
const router = express.Router();

const {
  createProfile,
  getProfileByUid,
  getProfileByUsername,
  updateProfile,
  deleteProfile
} = require("../controllers/profile.controller");

// Create profile
router.post("/create_profile", createProfile);

// Get profile by UID
router.get("/uid/:uid", getProfileByUid);

// Get profile by username
router.get("/username/:username", getProfileByUsername);

// Update profile
router.put("/:uid", updateProfile);

// Delete profile
router.delete("/:uid", deleteProfile);

module.exports = router;
