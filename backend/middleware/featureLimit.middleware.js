/**
 * featureLimit.middleware.js — Level 2: per-student AI limits
 *
 * Uses Redis atomic INCR — NOT a database count check.
 * Why Redis not DB? If two requests hit at the same millisecond, a DB count
 * check can fail (both read count=1, both pass). Redis INCR is atomic.
 *
 * TWO WINDOW TYPES:
 *   featureLimit(name, n)        — n per DAY, resets midnight IST via TTL
 *   featureLimitWeekly(name, n)  — n per WEEK (Court Simulation + AI Interviewer
 *                                  are 4/week, NOT per-day). Key is ISO-week based.
 *
 * v2 NOTE — Monday-morning RPM spike:
 * If every college's weekly counters reset at the same instant (Monday 00:00 IST),
 * all students regain sessions simultaneously → Gemini RPM spike Monday morning.
 * Mitigation: the weekly key embeds college_id and the reset is offset per college
 * by a stable hash (0–48h stagger). Colleges reset at different points in the week.
 */
const { createClient } = require('redis');
const crypto = require('crypto');

const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch(console.error);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── Daily limit (unchanged behaviour) ────────────────────────────────────────
const featureLimit = (featureName, maxPerDay) => async (req, res, next) => {
  const { user_id } = req.user;
  const nowIST   = new Date(Date.now() + IST_OFFSET_MS);
  const dateKey  = nowIST.toISOString().slice(0, 10);
  const redisKey = `feature_limit:${user_id}:${featureName}:${dateKey}`;

  const current = await redis.incr(redisKey);
  if (current === 1) await redis.expire(redisKey, 90000); // ~25h buffer

  if (current > maxPerDay) {
    return res.status(429).json({
      error: `Daily limit reached for ${featureName}. Resets at midnight IST.`,
      limit: maxPerDay,
      used: current - 1,
    });
  }
  req.featureUsageCount = current;
  next();
};

// ── Weekly limit (v2 — Court Simulation & AI Interviewer: 4/week) ────────────
const collegeStaggerMs = (collegeId) => {
  // Stable 0–48h offset per college so weekly resets don't all land Monday 00:00 IST
  const h = crypto.createHash('md5').update(String(collegeId)).digest();
  return (h.readUInt16BE(0) % 48) * 60 * 60 * 1000;
};

const featureLimitWeekly = (featureName, maxPerWeek) => async (req, res, next) => {
  const { user_id, college_id } = req.user;
  const staggered = Date.now() + IST_OFFSET_MS - collegeStaggerMs(college_id);
  // ISO week index since epoch (weeks start Monday); stagger shifts the boundary per college
  const weekIndex = Math.floor((staggered - 4 * 24 * 60 * 60 * 1000) / (7 * 24 * 60 * 60 * 1000));
  const redisKey  = `feature_limit_wk:${user_id}:${featureName}:${weekIndex}`;

  const current = await redis.incr(redisKey);
  if (current === 1) await redis.expire(redisKey, 8 * 24 * 60 * 60); // 8-day buffer

  if (current > maxPerWeek) {
    return res.status(429).json({
      error: `Weekly limit reached for ${featureName} (${maxPerWeek}/week). Resets next week.`,
      limit: maxPerWeek,
      used: current - 1,
    });
  }
  req.featureUsageCount = current;
  next();
};

module.exports = { featureLimit, featureLimitWeekly };
