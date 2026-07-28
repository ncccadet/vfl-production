/**
 * courtSimulation.controller.js
 * Contract: _contracts/05-court-simulation.md
 *
 * Flow:
 *   1. GET  /case-types                → case types + the positions each allows
 *   2. POST /start { caseType, position }  → weekly-limited; generates the case
 *        brief inline (1000 in / 1000 out) and returns it (status 'active').
 *   3. GET  /session/:id               → fetch/resume: brief + your position + turns
 *   4. POST /turn { session_id, statement, voiceLevel?, durationSec?, wordCount? }
 *        → ONE Gemini call (1500 in incl. context / 900 out) returns the JUDGE
 *          remark + OPPOSITION statement (+ concluded flag). Student statement is
 *          capped at 400 words (300 + 100 buffer).
 *        · Aims to conclude by turn 10; hard cap 15 turns (forced).
 *   5. POST /finish { session_id }     → ONE summary call (2000 in / 2000 out) →
 *        scored feedback on the student's advocacy + a verdict.
 *   6. GET  /result/:id                → the summary.
 *
 * Token caps (founder spec): case 1000/1000 · turn 1500/900 · summary 2000/2000.
 * Weekly limit 4/week (featureLimitWeekly, P015). college_id filters every query.
 */
const crypto = require('crypto');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const redis = require('../config/redisConnection');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_ID = 'gemini-3-1-flash-lite';
const DISCLAIMER = 'For educational purposes only. Verify with a qualified advocate.';

const SOFT_CONCLUDE = 10;   // aim to wrap up by this turn
const HARD_CAP = 15;        // absolute max turns (forced conclusion)
const MAX_WORDS = 400;      // student statement: 300 words + 100-word buffer
const CHARS_PER_TOKEN = 4;
const CASE_IN = 1000, CASE_OUT = 1000, TURN_IN = 1500, TURN_OUT = 900, SUM_IN = 2000, SUM_OUT = 2000;

// caseType → label + allowed positions
const CASE_TYPES = {
  criminal_trial:   { label: 'Criminal Trial',   positions: ['Prosecution', 'Defence'] },
  bail_hearing:     { label: 'Bail Hearing',     positions: ['Prosecution', 'Defence'] },
  civil_suit:       { label: 'Civil Suit',       positions: ['Plaintiff', 'Defendant'] },
  writ_pil:         { label: 'Writ / PIL',        positions: ['Petitioner', 'Respondent (State)'] },
  contract_dispute: { label: 'Contract Dispute', positions: ['Claimant', 'Respondent'] },
};

// ── weekly-limit key (mirrors featureLimitWeekly so a failure can refund it) ──
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const collegeStaggerMs = (collegeId) => {
  const h = crypto.createHash('md5').update(String(collegeId)).digest();
  return (h.readUInt16BE(0) % 48) * 60 * 60 * 1000;
};
const weeklyKey = (user_id, college_id) => {
  const staggered = Date.now() + IST_OFFSET_MS - collegeStaggerMs(college_id);
  const weekIndex = Math.floor((staggered - 4 * 24 * 60 * 60 * 1000) / (7 * 24 * 60 * 60 * 1000));
  return `feature_limit_wk:${user_id}:court_simulation:${weekIndex}`;
};
const refundWeekly = (user_id, college_id) => redis.decr(weeklyKey(user_id, college_id)).catch(() => {});

// ── Gemini helpers ───────────────────────────────────────────────────────────
const capChars = (text, inTokens) => String(text || '').slice(0, inTokens * CHARS_PER_TOKEN);
const callGemini = async (prompt, outCap) => {
  const model = genAI.getGenerativeModel({ model: MODEL_ID });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: outCap, temperature: 0.7, responseMimeType: 'application/json' },
  });
  const resp = result.response;
  const u = resp.usageMetadata || {};
  return { text: resp.text(), tokensIn: u.promptTokenCount ?? Math.ceil(prompt.length / 4), tokensOut: u.candidatesTokenCount ?? 0 };
};
const parseJson = (text) => {
  const c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in model output');
  return JSON.parse(c.slice(s, e + 1));
};
const logUsage = (user_id, college_id, tin, tout) =>
  pool.query(
    `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
     VALUES ($1,$2,'court_simulation',$3,$4,$5)`,
    [user_id, college_id, MODEL_ID, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

const loadOwnSession = async (id, user_id, college_id) => {
  const { rows } = await pool.query(
    `SELECT * FROM sessions WHERE session_id=$1 AND user_id=$2 AND college_id=$3 AND feature_name='court_simulation'`,
    [id, user_id, college_id]
  );
  return rows[0] || null;
};
const clampWords = (text) => String(text || '').trim().split(/\s+/).slice(0, MAX_WORDS).join(' ');

// Generate the case brief inline (1000 in / 1000 out).
const generateBrief = async (label, position, user_id, college_id) => {
  const prompt =
`Create a concise, self-contained fact scenario for a mock Indian ${label}, where a law student will argue
for the ${position}. Use current Indian law (BNSS/BNS/BSA 2023) where relevant, with concrete names, dates
and facts, and a clear point of contention the two sides can argue.
Return STRICT JSON: { "brief": "<8-14 sentences of facts + the legal issue>" }`;
  const { text, tokensIn, tokensOut } = await callGemini(capChars(prompt, CASE_IN), CASE_OUT);
  logUsage(user_id, college_id, tokensIn, tokensOut);
  return String(parseJson(text).brief || '').slice(0, 4000);
};

// ── 1. options ───────────────────────────────────────────────────────────────
const getCaseTypes = (_req, res) => {
  res.json({ caseTypes: Object.entries(CASE_TYPES).map(([id, v]) => ({ id, label: v.label, positions: v.positions })) });
};

// ── 2. start ─────────────────────────────────────────────────────────────────
const startSession = async (req, res, next) => {
  const { user_id, college_id } = req.user;
  try {
    const caseType = String(req.body.caseType || req.body.case_type || '');
    const def = CASE_TYPES[caseType];
    const position = def && def.positions.includes(req.body.position) ? req.body.position : (def ? def.positions[0] : null);
    if (!def) {
      await refundWeekly(user_id, college_id);
      return res.status(400).json({ error: 'Choose a valid case type.' });
    }

    // Generate the case brief inline. If Gemini fails, refund the weekly slot.
    let brief;
    try {
      brief = await generateBrief(def.label, position, user_id, college_id);
    } catch (e) {
      await refundWeekly(user_id, college_id);
      return res.status(502).json({ error: 'Could not set up the case. Please try again.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO sessions (user_id, college_id, feature_name, session_type, difficulty, filters, turns, turn_count, status)
       VALUES ($1,$2,'court_simulation',$3,'standard',$4,'[]'::jsonb,0,'active') RETURNING session_id`,
      [user_id, college_id, caseType, JSON.stringify({ caseType, position, label: def.label, brief })]
    );
    res.status(201).json({ sessionId: rows[0].session_id, status: 'active', caseType, position, label: def.label, brief });
  } catch (err) {
    await refundWeekly(user_id, college_id);
    next(err);
  }
};

// ── 3. poll session ──────────────────────────────────────────────────────────
const getSession = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.params.id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status === 'preparing') return res.json({ status: 'preparing' });
    if (s.status === 'failed') return res.json({ status: 'failed', message: 'Could not prepare the case. Please try again.' });

    const f = s.filters || {};
    return res.json({
      status: s.status, // active | complete
      caseType: f.caseType, label: f.label, position: f.position,
      brief: f.brief || '',
      turns: s.turns || [],
      turnCount: s.turn_count,
      softConclude: SOFT_CONCLUDE, hardCap: HARD_CAP, maxWords: MAX_WORDS,
      disclaimer: DISCLAIMER,
    });
  } catch (err) { next(err); }
};

// ── 4. turn (student statement → judge remark + opposition statement) ────────
const takeTurn = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.body.session_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status !== 'active') return res.status(409).json({ error: 'This simulation is not active.' });

    const statement = clampWords(req.body.statement); // hard-cap 400 words server-side too
    if (statement.trim().length < 3) return res.status(400).json({ error: 'Please make your statement first.' });
    const voiceLevel = Math.max(0, Math.min(100, Number(req.body.voiceLevel) || 0));
    const durationSec = Math.max(0, Number(req.body.durationSec) || 0);
    const wordCount = Math.max(0, Number(req.body.wordCount) || statement.split(/\s+/).filter(Boolean).length);

    const f = s.filters || {};
    const turns = s.turns || [];
    const forcedConclude = turns.length + 1 >= HARD_CAP;

    // Build the running context, truncated so total input stays within the turn cap.
    const history = turns.map((t, i) =>
      `Turn ${i + 1}\nStudent (${f.position}): ${t.student}\nOpposition: ${t.opposition}\nJudge: ${t.judge}`
    ).join('\n\n');
    const prompt =
`You are running a mock Indian courtroom (${f.label}). The STUDENT argues for the ${f.position}.
Case brief: ${f.brief}

Transcript so far:
${history || '(opening — no turns yet)'}

The student's new statement (${f.position}): "${statement}"

Respond as BOTH the OPPOSING COUNSEL and the JUDGE, using current Indian law (BNSS/BNS/BSA 2023) where relevant:
- "opposition": the opposing counsel's rebuttal (~300 words, forceful but fair).
- "judge": a SHORT ruling/interjection (1-3 sentences, authoritative).
- "concluded": true only if the argument has reached a natural conclusion (aim to conclude by turn ${SOFT_CONCLUDE}).
${forcedConclude ? 'This is the FINAL turn — you MUST set "concluded": true and have the judge close the hearing.' : ''}
Return STRICT JSON only: { "opposition": "...", "judge": "...", "concluded": <bool> }`;

    let parsed, tin = 0, tout = 0;
    try {
      const out = await callGemini(capChars(prompt, TURN_IN), TURN_OUT);
      tin = out.tokensIn; tout = out.tokensOut;
      parsed = parseJson(out.text);
    } catch (e) {
      if (tin || tout) logUsage(user_id, college_id, tin, tout);
      return res.status(502).json({ error: 'The court could not respond. Please try again.' });
    }
    logUsage(user_id, college_id, tin, tout);

    const opposition = String(parsed.opposition || '').slice(0, 3000);
    const judge = String(parsed.judge || '').slice(0, 1000);
    const concluded = forcedConclude || parsed.concluded === true;

    turns.push({ student: statement, opposition, judge, voiceLevel, durationSec, wordCount });
    await pool.query(
      `UPDATE sessions SET turns=$2, turn_count=$3 WHERE session_id=$1`,
      [s.session_id, JSON.stringify(turns), turns.length]
    );

    res.json({ turnNumber: turns.length, opposition, judge, concluded, disclaimer: DISCLAIMER });
  } catch (err) { next(err); }
};

// ── 5. finish → ONE summary call ─────────────────────────────────────────────
const finishSession = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.body.session_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status === 'complete' && s.summary) return res.json({ status: 'complete', result: JSON.parse(s.summary) });

    const f = s.filters || {};
    const turns = s.turns || [];
    if (turns.length === 0) return res.status(400).json({ error: 'Argue at least one turn before finishing.' });

    const transcript = turns.map((t, i) =>
      `Turn ${i + 1}\nStudent (${f.position}): ${t.student}\nOpposition: ${t.opposition}\nJudge: ${t.judge}`
    ).join('\n\n');
    const prompt =
`You are a senior advocate evaluating a law student's performance in a mock ${f.label}.
The student argued for the ${f.position}. Case brief: ${f.brief}

Full transcript:
${transcript}

Assess the STUDENT's advocacy and return STRICT JSON only:
{
  "overallScore": <0-100>,
  "legalReasoning": <0-100>,
  "argumentation": <0-100>,
  "courtcraft": <0-100>,
  "clarity": <0-100>,
  "verdict": "won|lost|split",
  "summary": "<3-4 sentence overall assessment>",
  "feedback": [ { "area": "<short>", "comment": "<specific, grounded in what the student said>" } ]
}
Rules: judge the STUDENT, not the AI opposition; ground every comment in the transcript;
cite where a stronger authority/section would have helped; be constructive.`;

    let parsed, tin = 0, tout = 0;
    try {
      const out = await callGemini(capChars(prompt, SUM_IN), SUM_OUT);
      tin = out.tokensIn; tout = out.tokensOut;
      parsed = parseJson(out.text);
    } catch (e) {
      if (tin || tout) logUsage(user_id, college_id, tin, tout);
      return res.status(502).json({ error: 'Could not generate your feedback. Please try again.' });
    }
    logUsage(user_id, college_id, tin, tout);

    const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
    const result = {
      overallScore: clamp(parsed.overallScore),
      legalReasoning: clamp(parsed.legalReasoning),
      argumentation: clamp(parsed.argumentation),
      courtcraft: clamp(parsed.courtcraft),
      clarity: clamp(parsed.clarity),
      verdict: ['won', 'lost', 'split'].includes(parsed.verdict) ? parsed.verdict : 'split',
      summary: String(parsed.summary || '').slice(0, 1000),
      feedback: Array.isArray(parsed.feedback)
        ? parsed.feedback.slice(0, 8).map((x) => ({ area: String(x.area || '').slice(0, 80), comment: String(x.comment || '').slice(0, 500) }))
        : [],
      disclaimer: DISCLAIMER,
    };

    await pool.query(
      `UPDATE sessions SET status='complete', is_complete=TRUE, summary=$2 WHERE session_id=$1`,
      [s.session_id, JSON.stringify(result)]
    );
    res.json({ status: 'complete', result });
  } catch (err) { next(err); }
};

// ── 6. result ────────────────────────────────────────────────────────────────
const getResult = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.params.id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Not found.' });
    if (s.status !== 'complete' || !s.summary) return res.json({ status: s.status });
    res.json({ status: 'complete', result: JSON.parse(s.summary) });
  } catch (err) { next(err); }
};

module.exports = { getCaseTypes, startSession, getSession, takeTurn, finishSession, getResult };
