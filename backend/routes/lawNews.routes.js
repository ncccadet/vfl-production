// lawNews.routes.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { getPreference, updatePreference } = require('../controllers/lawNews.controller');
// Actual email sent by lawNews.worker.js every Sunday. These routes manage preferences.
router.get('/preference', authMiddleware, getPreference);
router.put('/preference', authMiddleware, updatePreference);
module.exports = router;
