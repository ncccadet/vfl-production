/**
 * jobBoard.controller.js
 * Queries job_cache ONLY. Students never hit external APIs.
 * Fixed cost: 2 API calls/day regardless of student traffic.
 */
const { pool } = require('../config/db');

const getJobs = async (req, res, next) => {
  try {
    const { city, type, page = 1 } = req.query;
    const limit = 50;
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT * FROM job_cache 
       WHERE expires_at > NOW()
         AND ($1::text IS NULL OR location ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR job_type = $2)
       ORDER BY fetched_at DESC 
       LIMIT $3 OFFSET $4`,
      [city || null, type || null, limit, offset]
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM job_cache 
       WHERE expires_at > NOW()
         AND ($1::text IS NULL OR location ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR job_type = $2)`,
      [city || null, type || null]
    );

    const total = parseInt(countRows[0].count, 10);
    res.json({ jobs: rows, total, page: parseInt(page, 10), totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

module.exports = { getJobs };
