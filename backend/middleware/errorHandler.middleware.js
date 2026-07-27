/**
 * errorHandler.middleware.js — Global error handler
 *
 * Must be registered LAST in app.js (after all routes).
 * Never exposes stack traces in production (aids attackers).
 * Logs to error_log table for Monday morning review.
 */
const { pool } = require('../config/db');

const errorHandler = async (err, req, res, _next) => {
  const isDev = process.env.NODE_ENV === 'development';

  try {
    await pool.query(
      'INSERT INTO error_log (college_id, endpoint, error_message, created_at) VALUES ($1,$2,$3,NOW())',
      [req.user?.college_id || null, req.path, err.message]
    );
  } catch (_) { /* never let logging break the response */ }

  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  res.status(err.status || 500).json({
    error: isDev ? err.message : 'Something went wrong. Please try again.',
    ...(isDev && { stack: err.stack }),
  });
};

module.exports = { errorHandler };
