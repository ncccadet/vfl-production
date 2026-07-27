/**
 * lawNews.controller.js
 * Manages email digest preference. Actual emails sent by lawNews.worker.js every Sunday.
 */
const { pool } = require('../config/db');

const getPreference = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT email_digest FROM users WHERE user_id = $1 AND college_id = $2`,
      [user_id, college_id]
    );
    res.json({ emailDigest: rows[0]?.email_digest ?? true });
  } catch (err) { next(err); }
};

const updatePreference = async (req, res, next) => {
  try {
    const { emailDigest }         = req.body;
    const { user_id, college_id } = req.user;
    await pool.query(
      `UPDATE users SET email_digest = $1 WHERE user_id = $2 AND college_id = $3`,
      [!!emailDigest, user_id, college_id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

module.exports = { getPreference, updatePreference };
