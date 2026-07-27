/**
 * draftingLab.controller.js — v2: three modes
 *
 * MODE 1 — VIEW (no AI): pre-fed templates, multiple languages, read-only.
 * MODE 2 — PRACTICE (no AI): same templates with blanks; student fills blanks;
 *          cross-verified deterministically against answer_key in draft_templates.
 *          Zero AI cost, zero rate limit needed.
 * MODE 3 — CASE STUDY (AI): filters → AI generates a fresh case study →
 *          student writes a full draft → worker scores it AND generates a
 *          model draft for comparison.
 *
 * COST NOTE: Mode 3 = 2 AI calls per exercise (1 generate case, 1 score+model draft).
 * Only Mode 3 endpoints carry featureLimit. Modes 1–2 are free reads.
 */
const { Queue } = require('bullmq');
const { pool } = require('../config/db');
const { callGemini } = require('../utils/gemini');
const draftQueue = new Queue('drafting-lab', { connection: require('../config/redisConnection')() });

// ── Mode 1: view templates ───────────────────────────────────────────────────
const getTemplates = async (req, res, next) => {
  try {
    const { language = 'en', template_type } = req.query;
    let query = `SELECT template_id, template_type, language FROM draft_templates WHERE is_active = TRUE AND language = $1`;
    const params = [language];
    if (template_type) {
      query += ` AND template_type = $2`;
      params.push(template_type);
    }
    const { rows } = await pool.query(query, params);
    res.json({ templates: rows });
  } catch (err) { next(err); }
};

const getTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT full_text, blanks_json FROM draft_templates WHERE template_id = $1 AND is_active = TRUE`, [id]);
    res.json({ template: rows[0] || null });
  } catch (err) { next(err); }
};

// ── Mode 2: fill-the-blanks practice (deterministic, no AI) ──────────────────
const verifyBlanks = async (req, res, next) => {
  try {
    const { template_id, answers } = req.body;
    const { rows } = await pool.query(`SELECT answer_key FROM draft_templates WHERE template_id = $1 AND is_active = TRUE`, [template_id]);
    if (!rows.length) return res.status(404).json({ error: 'Template not found' });
    
    const key = rows[0].answer_key || {};
    const results = {};
    let score = 0;
    
    for (const [blankId, userText] of Object.entries(answers)) {
      const expected = key[blankId] || '';
      const isCorrect = userText.trim().toLowerCase() === expected.trim().toLowerCase();
      if (isCorrect) score++;
      results[blankId] = { isCorrect, expected };
    }
    res.json({ results, score });
  } catch (err) { next(err); }
};

// ── Mode 3: AI case study ─────────────────────────────────────────────────────
const generateCaseStudy = async (req, res, next) => {
  try {
    const { filters = {} } = req.body;
    const { user_id, college_id } = req.user;
    
    const filterSummary = Object.entries(filters).map(([k, v]) => `${k}: ${v}`).join(', ') || 'general legal scenario';
    const prompt = `Generate a realistic legal case study for a law student exercise based on these parameters: ${filterSummary}. Include relevant facts, parties involved, legal issues, and applicable laws. The case study should be 300-500 words.`;
    
    const { text: caseText, usage } = await callGemini(prompt, {
      systemInstruction: "You are an expert legal educator creating case studies for Indian law students."
    });

    const { rows } = await pool.query(
      `INSERT INTO documents (user_id, college_id, feature_name, s3_key, analysis_json)
       VALUES ($1, $2, 'drafting_lab_case', 'pending', $3) RETURNING doc_id`,
      [user_id, college_id, JSON.stringify({ filters, case_text: caseText })]
    );

    await pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'drafting_lab_case', 'gemini-3.1-flash-lite', $3, $4)`,
      [user_id, college_id, usage.promptTokenCount, usage.candidatesTokenCount]
    );

    res.json({ caseId: rows[0].doc_id, caseText, disclaimer: 'For educational purposes only. Verify with a qualified advocate.' });
  } catch (err) { next(err); }
};

const submitCaseDraft = async (req, res, next) => {
  try {
    if (req.inputFlagged) return res.status(400).json({ error: 'Input too large' });
    const { case_id, draft_text } = req.body;
    const { user_id, college_id } = req.user;
    
    const { rows: verify } = await pool.query(
      `SELECT doc_id FROM documents WHERE doc_id = $1 AND user_id = $2 AND college_id = $3`,
      [case_id, user_id, college_id]
    );
    if (!verify.length) return res.status(403).json({ error: 'Access denied' });
    if (draft_text.length > 50000) return res.status(400).json({ error: 'Draft text too long' });

    const job = await draftQueue.add('score-draft', { case_id, draft_text, user_id, college_id });
    res.status(202).json({ submissionId: case_id, status: 'scoring', jobId: job.id });
  } catch (err) { next(err); }
};

const getCaseResult = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT analysis_json FROM documents WHERE doc_id = $1 AND user_id = $2 AND college_id = $3`,
      [id, user_id, college_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    
    const analysis = rows[0].analysis_json || {};
    res.json({ 
      status: analysis.status || 'complete', 
      score: analysis.score || null, 
      feedback: analysis.feedback || null, 
      modelDraft: analysis.model_draft || null 
    });
  } catch (err) { next(err); }
};

const getHistory = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT doc_id, feature_name, created_at, analysis_json FROM documents 
       WHERE user_id = $1 AND college_id = $2 AND feature_name LIKE 'drafting_lab%'
       ORDER BY created_at DESC LIMIT 50`,
      [user_id, college_id]
    );
    res.json({ history: rows });
  } catch (err) { next(err); }
};

module.exports = { getTemplates, getTemplate, verifyBlanks, generateCaseStudy, submitCaseDraft, getCaseResult, getHistory };
