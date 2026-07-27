// resumeAnalyzer.routes.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimit }   = require('../middleware/featureLimit.middleware');
const { getUploadUrl, analyzeResume, getResult, getHistory } = require('../controllers/resumeAnalyzer.controller');
// Daily limit: 1 per student (enforced by featureLimit)
router.get('/upload-url',    authMiddleware, getUploadUrl);
router.post('/analyze',      authMiddleware, featureLimit('resume_analyzer', 1), analyzeResume);
router.get('/result/:jobId', authMiddleware, getResult);
router.get('/history',       authMiddleware, getHistory);
module.exports = router;
