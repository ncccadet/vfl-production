/**
 * rateLimit.middleware.js — Level 1: IP-based rate limit
 *
 * Max 100 requests per IP per minute. Stops bots and DDoS before any logic runs.
 * This does NOT know who the student is — it only sees IP.
 *
 * Level 2 (per-student daily AI limits) is in featureLimit.middleware.js.
 * Both must exist. They solve different problems.
 */
const rateLimit = require('express-rate-limit');

const rateLimitMiddleware = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

module.exports = { rateLimitMiddleware };
