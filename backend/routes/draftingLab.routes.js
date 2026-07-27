// draftingLab.routes.js — v2: three modes
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimit }   = require('../middleware/featureLimit.middleware');
const { getTemplates, getTemplate, verifyBlanks, generateCaseStudy, submitCaseDraft, getCaseResult, getHistory } = require('../controllers/draftingLab.controller');

// Modes 1–2: no AI → no featureLimit (free reads + deterministic verification)
router.get('/templates',              authMiddleware, getTemplates);
router.get('/templates/:id',          authMiddleware, getTemplate);
router.post('/verify-blanks',         authMiddleware, verifyBlanks);

// Mode 3: AI — 3/day covers the PAIR (case generation counts; scoring of that case is free)
router.post('/case-study',            authMiddleware, featureLimit('drafting_lab', 3), generateCaseStudy);
router.post('/case-study/submit',     authMiddleware, submitCaseDraft);  // bounded: one submit per generated case (enforce in controller)
router.get('/case-study/result/:id',  authMiddleware, getCaseResult);
router.get('/history',                authMiddleware, getHistory);
module.exports = router;
