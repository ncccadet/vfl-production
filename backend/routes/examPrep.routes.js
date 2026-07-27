// examPrep.routes.js — v2
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { getQuestions, submitAttempt, getAnalytics } = require('../controllers/examPrep.controller');
// GET  /api/exam/questions?exam_type=pcs_j&format=long_form
// POST /api/exam/submit      — full attempt (MCQ + written answers), returns comparing answer sheet
// GET  /api/exam/analytics   — score trends per student (SQL only, no AI)
router.get('/questions', authMiddleware, getQuestions);
router.post('/submit',   authMiddleware, submitAttempt);
router.get('/analytics', authMiddleware, getAnalytics);
module.exports = router;
