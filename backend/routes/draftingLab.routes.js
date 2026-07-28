// draftingLab.routes.js
// Contract: _contracts/04-drafting-lab.md
// featureLimit('drafting_lab', 3) is applied to /case-study ONLY (AI case generation).
// Listing types, polling the result and history carry no daily limit.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimit }   = require('../middleware/featureLimit.middleware');
const {
  listTypes,
  generateCaseStudy,
  getCaseResult,
  getHistory,
} = require('../controllers/draftingLab.controller');

router.get('/types',                    authMiddleware, listTypes);
router.post('/case-study',              authMiddleware, featureLimit('drafting_lab', 3), generateCaseStudy);
router.get('/case-study/result/:docId', authMiddleware, getCaseResult);
router.get('/history',                  authMiddleware, getHistory);

module.exports = router;
