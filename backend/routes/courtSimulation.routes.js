// courtSimulation.routes.js
// Contract: _contracts/05-court-simulation.md
// WEEKLY limit: 4 sessions/week (per-college staggered, P015) — on /start only.
// Turns/finish within a started session are free. Token caps: case 1000/1000,
// turn 1500/900, summary 2000/2000.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimitWeekly } = require('../middleware/featureLimit.middleware');
const {
  getCaseTypes,
  startSession,
  getSession,
  takeTurn,
  finishSession,
  getResult,
} = require('../controllers/courtSimulation.controller');

router.get('/case-types',   authMiddleware, getCaseTypes);
router.post('/start',       authMiddleware, featureLimitWeekly('court_simulation', 4), startSession);
router.get('/session/:id',  authMiddleware, getSession);  // poll while status='preparing'
router.post('/turn',        authMiddleware, takeTurn);     // student statement → judge + opposition
router.post('/finish',      authMiddleware, finishSession);
router.get('/result/:id',   authMiddleware, getResult);

module.exports = router;
