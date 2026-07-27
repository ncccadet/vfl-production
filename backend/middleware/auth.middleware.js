/**
 * auth.middleware.js — JWT verification + single-device enforcement.
 */
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const authMiddleware = async (req, res, next) => {
  const token = req.cookies?.accessToken;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    const { rows } = await pool.query(
      'SELECT active_session_version FROM users WHERE user_id = $1',
      [decoded.user_id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (decoded.session_version !== rows[0].active_session_version) {
      return res.status(401).json({ error: 'Logged in on another device' });
    }

    req.user = { user_id: decoded.user_id, college_id: decoded.college_id, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = { authMiddleware };
