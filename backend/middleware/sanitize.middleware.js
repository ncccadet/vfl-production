/**
 * sanitize.middleware.js — Input sanitization
 *
 * Runs on every request with a body, before any feature logic.
 * 1. Strips HTML tags (prevents XSS stored in DB)
 * 2. Trims whitespace
 * 3. Sets req.inputFlagged = true for inputs over 2000 chars
 *    (controllers check this and reject — prevents prompt injection)
 */
const sanitizeString = (str) =>
  typeof str === 'string' ? str.replace(/<[^>]*>/g, '').trim() : str;

const sanitizeObject = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      typeof v === 'string' ? sanitizeString(v) :
      typeof v === 'object' ? sanitizeObject(v) : v,
    ])
  );
};

const sanitizeMiddleware = (req, _res, next) => {
  if (req.body) {
    req.body = sanitizeObject(req.body);
    if (JSON.stringify(req.body).length > 2000) req.inputFlagged = true;
  }
  next();
};

module.exports = { sanitizeMiddleware };
