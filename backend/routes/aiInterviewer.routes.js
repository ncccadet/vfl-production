// aiInterviewer.routes.js
// Contract: _contracts/06-ai-interviewer.md
// WEEKLY limit: 4 sessions/week (per-college staggered reset, P015) — on /start only.
// Answers/finish within a started session are free. STT/TTS are browser-native (no /tts proxy).
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimitWeekly } = require('../middleware/featureLimit.middleware');
const {
  getInterviewOptions,
  startInterview,
  getSession,
  submitAnswer,
  finishInterview,
  getResult,
} = require('../controllers/aiInterviewer.controller');

router.get('/options',      authMiddleware, getInterviewOptions);
router.post('/start',       authMiddleware, featureLimitWeekly('ai_interviewer', 4), startInterview);
router.get('/session/:id',  authMiddleware, getSession);   // poll while status='preparing'
router.post('/answer',      authMiddleware, submitAnswer); // records answer; hard tier returns next question
router.post('/finish',      authMiddleware, finishInterview);
router.get('/result/:id',   authMiddleware, getResult);

module.exports = router;
