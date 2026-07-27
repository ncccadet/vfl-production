// resumeBuilder.routes.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimit }   = require('../middleware/featureLimit.middleware');
const { buildResume, getResume } = require('../controllers/resumeBuilder.controller');
// Daily limit: 1 per student. Result cached in S3 — no re-runs on refresh.
router.post('/build',    authMiddleware, featureLimit('resume_builder', 1), buildResume);
router.get('/download',  authMiddleware, getResume);
module.exports = router;
