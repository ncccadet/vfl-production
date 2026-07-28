/**
 * aiInterviewer.worker.js — BullMQ worker (batch question generation)
 * Contract: _contracts/06-ai-interviewer.md
 *
 * Handles EASY and MEDIUM tiers: one Gemini call generates up to 10 interview
 * questions for the session, which are then asked one-by-one / turn-by-turn.
 * (HARD tier is adaptive and generates questions per-turn in the controller.)
 *
 * FLOW per job:
 *   1. Load active tier caps + focus from the job.
 *   2. ONE Gemini call → JSON { questions: [...] } (retry once).
 *   3. UPDATE sessions SET questions=$1, status='active'.
 *   4. Log tokens to ai_usage_log.
 *   5. On failure: status='failed' AND refund the weekly slot (P009).
 *
 * Run as its OWN process (not imported by app.js):  npm run worker:interviewer
 */
require('dotenv').config(); // load env before requiring redisConnection (reads REDIS_URL at load)
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const redis = require('../config/redisConnection');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_ID = 'gemini-3-1-flash-lite';
const MAX_QUESTIONS = 10;

// Per-tier output caps (easy/medium only; hard is per-turn in the controller).
const OUT_CAP = { easy: 1000, medium: 2000 };

const parseJson = (text) => {
  const c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in model output');
  return JSON.parse(c.slice(s, e + 1));
};

const logUsage = (user_id, college_id, tin, tout) =>
  pool.query(
    `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
     VALUES ($1,$2,'ai_interviewer',$3,$4,$5)`,
    [user_id, college_id, MODEL_ID, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

const buildPrompt = (difficulty, focus) =>
`You are an interviewer preparing a ${difficulty} mock legal interview for an Indian law student.
Focus area: ${focus}. Generate up to ${MAX_QUESTIONS} interview questions appropriate to the ${difficulty}
level (easy = foundational/behavioural; medium = applied legal reasoning). Order them from opening to deeper.
Return STRICT JSON only: { "questions": ["<q1>", "<q2>", ... up to ${MAX_QUESTIONS}] }
Use current Indian law (BNSS/BNS/BSA 2023) where a statute is referenced. No preamble, JSON only.`;

const processJob = async (job) => {
  const { sessionId, difficulty, focus, user_id, college_id, weeklyKey } = job.data;
  const outCap = OUT_CAP[difficulty] || 1500;

  let questions, tin = 0, tout = 0, lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const model = genAI.getGenerativeModel({ model: MODEL_ID });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(difficulty, focus) }] }],
        generationConfig: { maxOutputTokens: outCap, temperature: 0.7, responseMimeType: 'application/json' },
      });
      const resp = result.response;
      const u = resp.usageMetadata || {};
      tin += u.promptTokenCount ?? 0; tout += u.candidatesTokenCount ?? 0;
      const parsed = parseJson(resp.text());
      questions = (parsed.questions || [])
        .map((q) => String(q || '').trim())
        .filter(Boolean)
        .slice(0, MAX_QUESTIONS);
      if (questions.length >= 1) break;
      questions = null;
    } catch (e) { lastErr = e; }
  }
  if (tin || tout) logUsage(user_id, college_id, tin, tout);

  if (!questions || questions.length === 0) {
    await pool.query(`UPDATE sessions SET status='failed' WHERE session_id=$1`, [sessionId]);
    if (weeklyKey) await redis.decr(weeklyKey).catch(() => {}); // refund the weekly slot (P009)
    throw lastErr || new Error('ai_interviewer: no questions generated');
  }

  await pool.query(
    `UPDATE sessions SET questions=$2, status='active' WHERE session_id=$1`,
    [sessionId, JSON.stringify(questions)]
  );
};

const worker = new Worker('ai-interviewer', processJob, { connection: require('../config/redisConnection') });
worker.on('completed', (job) => console.log(`AI-interviewer job ${job.id} done (session ${job.data.sessionId})`));
worker.on('failed', (job, err) => console.error(`AI-interviewer job ${job?.id} failed:`, err?.message));

module.exports = worker;
