/**
 * app.js — Main Express application
 *
 * MIDDLEWARE ORDER (critical — do not change):
 * 1. cors + helmet + cookieParser + json body parser
 * 2. rateLimitMiddleware  — stops bots before any logic runs
 * 3. sanitizeMiddleware   — cleans inputs before any feature logic
 * 4. Feature routes
 * 5. errorHandler         — MUST be last; catches everything above
 */
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');

const { pool } = require('./config/db');
const { rateLimitMiddleware } = require('./middleware/rateLimit.middleware');
const { sanitizeMiddleware }  = require('./middleware/sanitize.middleware');
const { errorHandler }        = require('./middleware/errorHandler.middleware');

const authRoutes            = require('./routes/auth.routes');
const examPrepRoutes        = require('./routes/examPrep.routes');
const resumeAnalyzerRoutes  = require('./routes/resumeAnalyzer.routes');
const jobBoardRoutes        = require('./routes/jobBoard.routes');
const draftingLabRoutes     = require('./routes/draftingLab.routes');
const courtSimulationRoutes = require('./routes/courtSimulation.routes');
const aiInterviewerRoutes   = require('./routes/aiInterviewer.routes');
const resumeBuilderRoutes   = require('./routes/resumeBuilder.routes');
const lawNewsRoutes         = require('./routes/lawNews.routes');

const app = express();
app.set('trust proxy', 1);

// ── CORS — support multiple origins via comma-separated FRONTEND_URL ─────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (curl, server-to-server, mobile apps)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(helmet());                         // Security headers
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(rateLimitMiddleware); // Level 1: 100 req/min per IP
app.use(sanitizeMiddleware);  // Strip HTML, trim, flag large inputs

// Health check — no auth, used by UptimeRobot and ALB
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.use('/api/auth',             authRoutes);
app.use('/api/exam',             examPrepRoutes);
app.use('/api/resume-analyzer',  resumeAnalyzerRoutes);
app.use('/api/jobs',             jobBoardRoutes);
app.use('/api/drafting-lab',     draftingLabRoutes);
app.use('/api/court-simulation', courtSimulationRoutes);
app.use('/api/ai-interviewer',   aiInterviewerRoutes);
app.use('/api/resume-builder',   resumeBuilderRoutes);
app.use('/api/law-news',         lawNewsRoutes);

app.use(errorHandler); // MUST be last

// ── Start workers (same process for simplicity; split to separate process in prod if needed) ──
require('./workers/resumeAnalyzer.worker');
require('./workers/draftingLab.worker');
require('./workers/aiInterviewer.worker');
require('./workers/lawNews.worker');
require('./workers/otp.worker');
require('./workers/jobScraper.worker');

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`Voxera backend on port ${PORT}`));

// ── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    pool.end().then(() => {
      console.log('Database pool closed.');
      process.exit(0);
    });
  });
  // Force kill after 10s if graceful shutdown stalls
  setTimeout(() => {
    console.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
