/**
 * aiInterviewer.controller.js
 * Contract: _contracts/06-ai-interviewer.md
 *
 * Flow (three difficulty tiers):
 *   1. GET  /options                 → difficulties + focus areas
 *   2. POST /start { difficulty, focus }  → weekly-limited; creates the session
 *        · easy/medium: enqueue the worker to batch-generate up to 10 questions
 *          (status 'preparing' → poll). Asked one-by-one / turn-by-turn.
 *        · hard: generate Q1 inline (status 'active'); each later question is
 *          generated ADAPTIVELY from the last answer in /answer (live conversation).
 *   3. GET  /session/:id             → poll: status + questions (easy/medium once ready)
 *   4. POST /answer { session_id, index, answer, voiceLevel, durationSec, wordCount }
 *        · records the answer + voice metrics; hard tier returns the next question.
 *   5. POST /finish { session_id }   → ONE summary call → correctness, efficiency,
 *        confidence, clarity, voice level. status 'complete'.
 *   6. GET  /result/:id             → the summary.
 *
 * STT + TTS are browser-native (Web Speech API / SpeechSynthesis) — no backend
 * audio. Camera is presence-only (browser); no video reaches the server.
 * college_id filters every sessions query. Weekly limit: 4/week (P015 staggered).
 */
const crypto = require('crypto');
const { Pool } = require('pg');
const { Queue } = require('bullmq');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const redis = require('../config/redisConnection');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const interviewQueue = new Queue('ai-interviewer', { connection: require('../config/redisConnection') });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_ID = 'gemini-3-1-flash-lite';
const DISCLAIMER = 'For educational purposes only. Verify with a qualified advocate.';

const MAX_QUESTIONS = 10;
const FOCUS_AREAS = ['General', 'Litigation', 'Corporate', 'Judiciary (PCS-J)'];

// Per-tier token caps (founder spec). "in" includes the context window.
const TIER = {
  easy:   { level: 'easy',   adaptive: false, inCap: 1500, outCap: 1000 },
  medium: { level: 'medium', adaptive: false, inCap: 1500, outCap: 2000 },
  hard:   { level: 'hard',   adaptive: true,  inCap: 5000, outCap: 4000 },
};
const CHARS_PER_TOKEN = 4;

// ── weekly-limit key (mirrors featureLimitWeekly so a failure can refund it) ──
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const collegeStaggerMs = (collegeId) => {
  const h = crypto.createHash('md5').update(String(collegeId)).digest();
  return (h.readUInt16BE(0) % 48) * 60 * 60 * 1000;
};
const weeklyKey = (user_id, college_id) => {
  const staggered = Date.now() + IST_OFFSET_MS - collegeStaggerMs(college_id);
  const weekIndex = Math.floor((staggered - 4 * 24 * 60 * 60 * 1000) / (7 * 24 * 60 * 60 * 1000));
  return `feature_limit_wk:${user_id}:ai_interviewer:${weekIndex}`;
};
const refundWeekly = (user_id, college_id) => redis.decr(weeklyKey(user_id, college_id)).catch(() => {});

// ── Gemini helpers ───────────────────────────────────────────────────────────
const cap = (text, inCap) => String(text || '').slice(0, inCap * CHARS_PER_TOKEN);
const callGemini = async (prompt, outCap) => {
  const model = genAI.getGenerativeModel({ model: MODEL_ID });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: outCap, temperature: 0.6, responseMimeType: 'application/json' },
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
     VALUES ($1,$2,'ai_interviewer',$3,$4,$5)`,
    [user_id, college_id, MODEL_ID, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

// Generate the FIRST hard-tier question inline (short, fast).
const firstHardQuestion = async (focus, user_id, college_id) => {
  const prompt =
`You are conducting a live mock legal interview for an Indian law student. Focus: ${focus}.
This is a HARD, adaptive interview. Ask the FIRST question — a solid opener you can build on.
Return STRICT JSON: { "question": "<one interview question>" }`;
  const { text, tokensIn, tokensOut } = await callGemini(cap(prompt, TIER.hard.inCap), TIER.hard.outCap);
  logUsage(user_id, college_id, tokensIn, tokensOut);
  const q = parseJson(text).question;
  return String(q || 'Tell me about yourself and why you chose law.').slice(0, 600);
};

// ── ownership helper ─────────────────────────────────────────────────────────
const loadOwnSession = async (id, user_id, college_id) => {
  const { rows } = await pool.query(
    `SELECT * FROM sessions WHERE session_id=$1 AND user_id=$2 AND college_id=$3 AND feature_name='ai_interviewer'`,
    [id, user_id, college_id]
  );
  return rows[0] || null;
};

// ── 1. options ───────────────────────────────────────────────────────────────
const getInterviewOptions = (_req, res) => {
  res.json({ difficulties: Object.keys(TIER), focusAreas: FOCUS_AREAS, maxQuestions: MAX_QUESTIONS });
};

// ── 2. start ─────────────────────────────────────────────────────────────────
const startInterview = async (req, res, next) => {
  const { user_id, college_id } = req.user;
  try {
    const difficulty = String(req.body.difficulty || '');
    const focus = FOCUS_AREAS.includes(req.body.focus) ? req.body.focus : 'General';
    if (!TIER[difficulty]) {
      await refundWeekly(user_id, college_id); // bad input never uses a weekly slot
      return res.status(400).json({ error: 'difficulty must be easy | medium | hard' });
    }

    if (TIER[difficulty].adaptive) {
      // HARD: generate Q1 now, go straight to active.
      let firstQ;
      try {
        firstQ = await firstHardQuestion(focus, user_id, college_id);
      } catch (e) {
        await refundWeekly(user_id, college_id);
        return res.status(502).json({ error: 'Could not start the interview. Please try again.' });
      }
      const { rows } = await pool.query(
        `INSERT INTO sessions (user_id, college_id, feature_name, session_type, difficulty, filters, questions, turns, turn_count, status)
         VALUES ($1,$2,'ai_interviewer','interview',$3,$4,$5,'[]'::jsonb,0,'active') RETURNING session_id`,
        [user_id, college_id, difficulty, JSON.stringify({ focus }), JSON.stringify([firstQ])]
      );
      return res.status(201).json({ sessionId: rows[0].session_id, status: 'active', difficulty, totalQuestions: MAX_QUESTIONS });
    }

    // EASY / MEDIUM: batch-generate in the worker.
    const { rows } = await pool.query(
      `INSERT INTO sessions (user_id, college_id, feature_name, session_type, difficulty, filters, status)
       VALUES ($1,$2,'ai_interviewer','interview',$3,$4,'preparing') RETURNING session_id`,
      [user_id, college_id, difficulty, JSON.stringify({ focus })]
    );
    const sessionId = rows[0].session_id;
    await interviewQueue.add(
      'generate-questions',
      { sessionId, difficulty, focus, user_id, college_id, weeklyKey: weeklyKey(user_id, college_id) },
      { removeOnComplete: 100, removeOnFail: 100, attempts: 1 }
    );
    res.status(202).json({ sessionId, status: 'preparing', difficulty, totalQuestions: MAX_QUESTIONS });
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
    if (s.status === 'failed') return res.json({ status: 'failed', message: 'Could not prepare your interview. Please try again.' });

    return res.json({
      status: s.status, // active | complete
      difficulty: s.difficulty,
      adaptive: TIER[s.difficulty]?.adaptive || false,
      totalQuestions: MAX_QUESTIONS,
      questions: s.questions || [], // easy/medium: full list. hard: questions generated so far.
      turnCount: s.turn_count,
      disclaimer: DISCLAIMER,
    });
  } catch (err) { next(err); }
};

// ── 4. answer (records answer + voice metrics; hard tier returns next question) ─
const submitAnswer = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { session_id, index } = req.body;
    const answer = String(req.body.answer || '').slice(0, 4000);
    const voiceLevel = Math.max(0, Math.min(100, Number(req.body.voiceLevel) || 0));
    const durationSec = Math.max(0, Number(req.body.durationSec) || 0);
    const wordCount = Math.max(0, Number(req.body.wordCount) || answer.trim().split(/\s+/).filter(Boolean).length);

    const s = await loadOwnSession(session_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status !== 'active') return res.status(409).json({ error: 'This interview is not active.' });

    const questions = s.questions || [];
    const turns = s.turns || [];
    const qText = questions[index] || questions[turns.length] || '';
    turns.push({ q: qText, a: answer, voiceLevel, durationSec, wordCount });

    const tier = TIER[s.difficulty];
    let nextQuestion = null;
    let done = turns.length >= MAX_QUESTIONS;

    if (tier.adaptive && !done) {
      // HARD: generate the next, harder question from the conversation so far.
      const convo = turns.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a}`).join('\n\n');
      const prompt =
`You are conducting a live, adaptive mock legal interview (HARD) for an Indian law student.
Focus: ${s.filters?.focus || 'General'}. Conversation so far:\n${convo}\n
Analyse the student's last answer and ask ONE NEXT question that is HARDER and follows naturally
from what they said (probe deeper, challenge a weak point, or escalate difficulty).
Return STRICT JSON: { "question": "<the next question>" }`;
      try {
        const { text, tokensIn, tokensOut } = await callGemini(cap(prompt, tier.inCap), tier.outCap);
        logUsage(user_id, college_id, tokensIn, tokensOut);
        nextQuestion = String(parseJson(text).question || '').slice(0, 600);
        if (nextQuestion) questions.push(nextQuestion);
      } catch (e) {
        done = true; // don't block the interview on a hiccup — allow finishing
      }
    } else if (!tier.adaptive) {
      done = turns.length >= questions.length; // easy/medium: finished when all pre-generated answered
    }

    await pool.query(
      `UPDATE sessions SET turns=$2, turn_count=$3, questions=$4 WHERE session_id=$1`,
      [session_id, JSON.stringify(turns), turns.length, JSON.stringify(questions)]
    );

    res.json({ recorded: true, nextQuestion, questionIndex: turns.length, done, disclaimer: DISCLAIMER });
  } catch (err) { next(err); }
};

// ── 5. finish → ONE summary call (correctness, efficiency, confidence, clarity, voice) ─
const finishInterview = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.body.session_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status === 'complete' && s.summary) return res.json({ status: 'complete', result: JSON.parse(s.summary) });

    const turns = s.turns || [];
    if (turns.length === 0) return res.status(400).json({ error: 'Answer at least one question before finishing.' });

    // Aggregate the client-measured voice metrics (deterministic).
    const levels = turns.map((t) => t.voiceLevel || 0);
    const avgVoice = Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
    const voiceLabel = avgVoice < 30 ? 'low' : avgVoice > 75 ? 'loud' : 'balanced';
    const totalWords = turns.reduce((a, t) => a + (t.wordCount || 0), 0);
    const totalSec = turns.reduce((a, t) => a + (t.durationSec || 0), 0);
    const wpm = totalSec > 0 ? Math.round((totalWords / totalSec) * 60) : 0;

    const transcript = turns.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a || '(no answer)'}`).join('\n\n');
    const prompt =
`You are an expert interview coach evaluating a ${s.difficulty} mock legal interview for an Indian law student.
Focus: ${s.filters?.focus || 'General'}.
Measured speech metrics: average voice level ${avgVoice}/100 (${voiceLabel}), speaking pace ~${wpm} words/min.

Transcript:
${transcript}

Assess the student and return STRICT JSON only:
{
  "overallScore": <0-100>,
  "correctness": <0-100>,
  "efficiency": <0-100>,
  "confidence": <0-100>,
  "clarity": <0-100>,
  "voiceLevel": "low|balanced|loud",
  "summary": "<2-3 sentence overall assessment>",
  "feedback": [ { "area": "<short>", "comment": "<specific, grounded in the answers>" } ]
}
Rules: base confidence/clarity on the answers AND the speech metrics; set voiceLevel to "${voiceLabel}";
be specific and constructive; do not invent facts. Keep within the output budget.`;

    let parsed, tin = 0, tout = 0;
    try {
      const out = await callGemini(cap(prompt, 5000), 1200);
      tin = out.tokensIn; tout = out.tokensOut;
      parsed = parseJson(out.text);
    } catch (e) {
      if (tin || tout) logUsage(user_id, college_id, tin, tout);
      return res.status(502).json({ error: 'Could not generate your summary. Please try again.' });
    }
    logUsage(user_id, college_id, tin, tout);

    const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
    const result = {
      overallScore: clamp(parsed.overallScore),
      correctness: clamp(parsed.correctness),
      efficiency: clamp(parsed.efficiency),
      confidence: clamp(parsed.confidence),
      clarity: clamp(parsed.clarity),
      voiceLevel: ['low', 'balanced', 'loud'].includes(parsed.voiceLevel) ? parsed.voiceLevel : voiceLabel,
      speechPaceWpm: wpm,
      summary: String(parsed.summary || '').slice(0, 800),
      feedback: Array.isArray(parsed.feedback)
        ? parsed.feedback.slice(0, 8).map((f) => ({ area: String(f.area || '').slice(0, 80), comment: String(f.comment || '').slice(0, 500) }))
        : [],
      disclaimer: DISCLAIMER,
    };

    await pool.query(
      `UPDATE sessions SET status='complete', is_complete=TRUE, summary=$2,
              filters = filters || $3::jsonb WHERE session_id=$1`,
      [s.session_id, JSON.stringify(result), JSON.stringify({ metrics: { avgVoice, voiceLabel, wpm } })]
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

module.exports = { getInterviewOptions, startInterview, getSession, submitAnswer, finishInterview, getResult };
