// courtSimulation.routes.js — v2
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { featureLimitWeekly } = require('../middleware/featureLimit.middleware');
const { getCaseTypes, startSession, takeTurn } = require('../controllers/courtSimulation.controller');
// v2: WEEKLY limit — 4 sessions/week (was 2/day). Weekly Redis window with
// per-college stagger. Double-protected: Redis + DB check in controller.
// Token limits per turn: revised numbers TBD — update contract 05 when finalised.
router.get('/case-types', authMiddleware, getCaseTypes);
router.post('/start',     authMiddleware, featureLimitWeekly('court_simulation', 4), startSession);
router.post('/turn',      authMiddleware, takeTurn);
module.exports = router;
