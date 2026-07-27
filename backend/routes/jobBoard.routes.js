// jobBoard.routes.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { getJobs } = require('../controllers/jobBoard.controller');
// GET /api/jobs?city=Mumbai&type=internship
// Students NEVER hit external APIs — always reads job_cache table
router.get('/', authMiddleware, getJobs);
module.exports = router;
