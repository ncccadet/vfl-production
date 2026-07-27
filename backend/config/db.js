/**
 * db.js — Centralized PostgreSQL Connection Pool
 *
 * This pool is shared across the entire application.
 * Do not instantiate new pg.Pool() instances elsewhere to avoid exhausting DB connections.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }   // In production, verify the RDS CA certificate
    : { rejectUnauthorized: false }, // In dev/staging, allow self-signed
  max: 20,                          // Maximum connections in pool
  idleTimeoutMillis: 30000,         // Close idle connections after 30s
  connectionTimeoutMillis: 5000,    // Fail fast if DB is unreachable
});

module.exports = { pool };
