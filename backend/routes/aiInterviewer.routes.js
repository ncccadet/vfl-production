// aiInterviewer.routes.js — v2
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimitWeekly } = require('../middleware/featureLimit.middleware');
const { getInterviewOptions, startInterview, getSession, submitAnswer, textToSpeech } = require('../controllers/aiInterviewer.controller');

// WEEKLY limit: 4 sessions/week (NOT 2/day) — enforced with weekly Redis window
router.get('/options',       authMiddleware, getInterviewOptions);
router.post('/start',        authMiddleware, featureLimitWeekly('ai_interviewer', 4), startInterview);
router.get('/session/:id',   authMiddleware, getSession);   // poll while worker generates questions
router.post('/answer',       authMiddleware, submitAnswer); // limit is per SESSION, answers within a session are free
router.post('/tts',          authMiddleware, textToSpeech); // server-side proxy; provider key never in browser
module.exports = router;
