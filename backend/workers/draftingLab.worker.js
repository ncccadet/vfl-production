/**
 * draftingLab.worker.js — BullMQ worker (case generation)
 * Contract: _contracts/04-drafting-lab.md
 *
 * WHY A WORKER: the AI call runs off the main API process so a Gemini slowdown
 * never blocks a request. The worker only GENERATES A CASE (a fact scenario) for
 * the chosen draft type. There is no scoring and no model draft — the student
 * reads the case and fills the blanks of the template themselves.
 *
 * FLOW per job:
 *   1. ONE Gemini call → JSON { title, facts } for the given draft type (retry once).
 *   2. UPDATE the drafting_lab documents row (status + analysis_json.case).
 *   3. Log tokens to ai_usage_log.
 *   4. On failure: mark 'failed' AND refund the student's daily slot (P009).
 *
 * Run as its OWN process (not imported by app.js):  npm run worker:drafting
 */
require('dotenv').config(); // MUST load env before requiring redisConnection (reads REDIS_URL at load)
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const redis = require('../config/redisConnection');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_ID = 'gemini-3-1-flash-lite';
const CASE_MAX_OUT = 800;

const limitKey = (user_id, dateKey) => `feature_limit:${user_id}:drafting_lab:${dateKey}`;

const parseJson = (text) => {
  const c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in model output');
  return JSON.parse(c.slice(s, e + 1));
};

const logUsage = (user_id, college_id, tin, tout) =>
  pool.query(
    `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
     VALUES ($1,$2,'drafting_lab',$3,$4,$5)`,
    [user_id, college_id, MODEL_ID, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

const buildPrompt = (label) =>
`You are a law-school drafting instructor in India. Generate ONE realistic, self-contained
fact scenario (a "case") that a student will use to draft a ${label}. Use current codes
(BNSS/BNS/BSA 2023) where relevant. Include concrete details the student will need to fill in
the draft: party names, dates, place/court, FIR/case numbers or amounts as applicable.

Return STRICT JSON only:
{ "title": "<short case title>", "facts": "<8-12 sentences of concrete facts>" }

Do NOT write the draft itself. Use only fictional persons. Keep under ${CASE_MAX_OUT} tokens.`;

const processJob = async (job) => {
  const { docId, label, user_id, college_id, dateKey } = job.data;

  let parsed, tin = 0, tout = 0, lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const model = genAI.getGenerativeModel({ model: MODEL_ID });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(label) }] }],
        generationConfig: { maxOutputTokens: CASE_MAX_OUT, temperature: 0.6, responseMimeType: 'application/json' },
      });
      const resp = result.response;
      const usage = resp.usageMetadata || {};
      tin += usage.promptTokenCount ?? 0;
      tout += usage.candidatesTokenCount ?? 0;
      parsed = parseJson(resp.text());
      break;
    } catch (e) { lastErr = e; }
  }
  if (tin || tout) logUsage(user_id, college_id, tin, tout);

  if (!parsed) {
    await pool.query(
      `UPDATE documents SET status='failed', analysis_json = analysis_json || $2::jsonb WHERE doc_id=$1`,
      [docId, JSON.stringify({ message: 'We could not generate a case. Please try again.' })]
    );
    await redis.decr(limitKey(user_id, dateKey)).catch(() => {}); // refund the daily slot (P009)
    throw lastErr || new Error('drafting_lab: unparseable model output');
  }

  const caseObj = {
    title: String(parsed.title || 'Practice case').slice(0, 200),
    facts: String(parsed.facts || '').slice(0, 4000),
  };
  await pool.query(
    `UPDATE documents SET status='complete', analysis_json = analysis_json || $2::jsonb WHERE doc_id=$1`,
    [docId, JSON.stringify({ case: caseObj })]
  );
};

const worker = new Worker('drafting-lab', processJob, { connection: require('../config/redisConnection') });
worker.on('completed', (job) => console.log(`Drafting-lab job ${job.id} done (doc ${job.data.docId})`));
worker.on('failed', (job, err) => console.error(`Drafting-lab job ${job?.id} failed:`, err?.message));

module.exports = worker;
