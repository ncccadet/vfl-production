/**
 * resumeAnalyzer.worker.js — BullMQ worker
 * Contract: _contracts/02-resume-analyzer.md
 *
 * WHY A WORKER (P004): a malicious or corrupt PDF can crash the parser. Isolating
 * all PDF reading + the Gemini call here means the main API process stays alive.
 *
 * FLOW per job:
 *   1. Download the PDF from S3 (buffer only — never written to disk).
 *   2. Validate it: %PDF magic bytes → pdf-parse → 1–3 pages → has real text.
 *   3. Cheap résumé pre-filter (keyword signals) to reject obvious non-résumés
 *      before spending a Gemini call.
 *   4. Truncate text to ~3000 tokens, then ONE Gemini call
 *      (gemini-3-1-flash-lite, maxOutputTokens 1500, JSON response).
 *   5. The model returns isResume + 7 scored parameters. If isResume is false,
 *      mark the document 'failed' with a friendly message.
 *   6. UPDATE documents (status + analysis_json), scoped by doc_id.
 *   7. Log tokens to ai_usage_log (source of truth for the cost review).
 *
 * Every failure path marks the document 'failed' so the student stops polling.
 * There is no Redis refund step: this feature has no daily limit to refund.
 */
const { Worker } = require('bullmq');
const AWS = require('aws-sdk');
const pdfParse = require('pdf-parse');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const s3 = new AWS.S3({ region: process.env.AWS_REGION, signatureVersion: 'v4' });
const BUCKET = process.env.S3_BUCKET_FILES;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_ID = 'gemini-3-1-flash-lite';

const DISCLAIMER = 'For educational purposes only. Verify with a qualified advocate.';

// ── Token / size caps (contract) ─────────────────────────────────────────────
const MAX_INPUT_CHARS  = 12000; // ~3000 tokens of PDF text (≈4 chars/token)
const MAX_OUTPUT_TOKENS = 1500;
const MIN_TEXT_CHARS   = 150;   // below this = image-only/scanned/empty PDF
const MIN_PAGES = 1;
const MAX_PAGES = 3;

// The exact 7 parameters the model must score (contract). Order is enforced.
const PARAMETERS = [
  'Structure & Formatting',
  'Contact & Online Presence',
  'Education & Academic Record',
  'Legal Experience & Internships',
  'Skills & Competencies',
  'Achievements & Impact',
  'Language, Grammar & Clarity',
];

// Cheap résumé signal words — used only as a pre-filter, not the final verdict.
const RESUME_SIGNALS = [
  'experience', 'education', 'skills', 'internship', 'project', 'objective',
  'curriculum vitae', 'resume', 'résumé', 'university', 'college', 'bachelor',
  'llb', 'ba llb', 'moot', 'certification', 'achievement', 'reference',
  'email', 'phone', 'linkedin', 'languages',
];

const buildPrompt = (resumeText) => `You are an expert legal-careers résumé reviewer for Indian law students.
Analyse the résumé text between the <resume> tags.

First decide whether the document actually is a résumé / CV (not an invoice, letter,
notes, article, or any other document). If it is NOT a résumé, respond with EXACTLY:
{"isResume": false, "reason": "<short reason>"}

If it IS a résumé, score it on these SEVEN parameters, in this exact order:
${PARAMETERS.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Respond with STRICT JSON only (no markdown, no prose) in this shape:
{
  "isResume": true,
  "overallScore": <integer 0-100>,
  "summary": "<one or two sentence overall impression>",
  "parameters": [
    { "name": "<one of the 7 names, exact>", "score": <integer 0-100>,
      "strengths": ["<short point>", "..."],
      "improvements": ["<specific, actionable point>", "..."] }
  ]
}
Rules: exactly 7 objects in "parameters", names exactly as listed and in order.
1-3 bullet points per list. Be specific and constructive. Do not invent facts that
are not in the résumé. Keep the whole response under ${MAX_OUTPUT_TOKENS} tokens.

<resume>
${resumeText}
</resume>`;

// ── DB helpers (always scoped by doc_id — a job can only touch its own row) ───
const markFailed = (docId, message) =>
  pool.query(
    `UPDATE documents SET status = 'failed', analysis_json = $2 WHERE doc_id = $1`,
    [docId, JSON.stringify({ message })]
  );

const markComplete = (docId, analysis) =>
  pool.query(
    `UPDATE documents SET status = 'complete', analysis_json = $2 WHERE doc_id = $1`,
    [docId, JSON.stringify(analysis)]
  );

const logUsage = (user_id, college_id, tokensIn, tokensOut) =>
  pool
    .query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'resume_analyzer', $3, $4, $5)`,
      [user_id, college_id, MODEL_ID, tokensIn, tokensOut]
    )
    .catch((e) => console.error('ai_usage_log insert failed:', e.message)); // never fail the job over logging

// Pull the first {...} block out of the model text and parse it. Tolerant of
// stray markdown fences the model occasionally adds despite responseMimeType.
const parseModelJson = (text) => {
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
};

// Validate + normalise the model's résumé analysis into exactly our 7-parameter shape.
const normaliseAnalysis = (parsed) => {
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  if (!Array.isArray(parsed.parameters)) throw new Error('missing parameters array');

  const clampScore = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const asList = (v) =>
    (Array.isArray(v) ? v : [v]).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3);

  // Map by (case-insensitive) name so order/casing wobble in the model doesn't break us.
  const byName = new Map(
    parsed.parameters
      .filter((p) => p && p.name)
      .map((p) => [String(p.name).toLowerCase().trim(), p])
  );

  const parameters = PARAMETERS.map((name) => {
    const p = byName.get(name.toLowerCase()) || {};
    return {
      name,
      score: clampScore(p.score),
      strengths: asList(p.strengths),
      improvements: asList(p.improvements),
    };
  });

  const overallScore =
    parsed.overallScore != null
      ? clampScore(parsed.overallScore)
      : Math.round(parameters.reduce((s, p) => s + p.score, 0) / parameters.length);

  return {
    overallScore,
    summary: String(parsed.summary || '').trim().slice(0, 500),
    parameters,
    disclaimer: DISCLAIMER,
  };
};

// One Gemini call. Returns { text, tokensIn, tokensOut }.
const callGemini = async (prompt) => {
  const model = genAI.getGenerativeModel({ model: MODEL_ID });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS, // REAL cap, not a prompt request
      temperature: 0.3,
      responseMimeType: 'application/json',
    },
  });
  const resp = result.response;
  const usage = resp.usageMetadata || {};
  return {
    text: resp.text(),
    tokensIn: usage.promptTokenCount ?? Math.ceil(prompt.length / 4),
    tokensOut: usage.candidatesTokenCount ?? 0,
  };
};

// ── The job processor ────────────────────────────────────────────────────────
const processJob = async (job) => {
  const { docId, s3Key, user_id, college_id } = job.data;

  // 1. Download PDF as a buffer (never touches disk).
  let buffer;
  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: s3Key }).promise();
    buffer = obj.Body;
  } catch (e) {
    await markFailed(docId, 'We could not find your uploaded file. Please try uploading again.');
    return;
  }

  // 2a. Magic bytes — a .jpg/.exe renamed .pdf is rejected here.
  if (!buffer || buffer.length < 5 || buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
    await markFailed(docId, 'That file is not a valid PDF. Please upload a PDF résumé.');
    return;
  }

  // 2b. Parse: text + page count.
  let parsedPdf;
  try {
    parsedPdf = await pdfParse(buffer);
  } catch (e) {
    await markFailed(docId, 'We could not read this PDF. Please upload a text-based (not scanned) PDF résumé.');
    return;
  }

  const numPages = parsedPdf.numpages || 0;
  const text = (parsedPdf.text || '').replace(/\s+\n/g, '\n').trim();

  if (numPages < MIN_PAGES || numPages > MAX_PAGES) {
    await markFailed(
      docId,
      `A résumé should be ${MIN_PAGES}–${MAX_PAGES} pages. This PDF has ${numPages} page(s). Please upload a shorter résumé.`
    );
    return;
  }
  if (text.length < MIN_TEXT_CHARS) {
    await markFailed(docId, 'We could not extract text from this PDF (it may be a scanned image). Please upload a text-based PDF résumé.');
    return;
  }

  // 3. Cheap résumé pre-filter — reject obvious non-résumés without spending a call.
  const lower = text.toLowerCase();
  const signalHits = RESUME_SIGNALS.filter((w) => lower.includes(w)).length;
  if (signalHits < 2) {
    await markFailed(docId, 'This does not look like a résumé. Please upload your CV / résumé as a PDF.');
    return;
  }

  // 4. Truncate to the input token cap, then call Gemini (one retry on bad JSON).
  const resumeText = text.slice(0, MAX_INPUT_CHARS);
  const prompt = buildPrompt(resumeText);

  let parsed;
  let totalIn = 0;
  let totalOut = 0;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text: out, tokensIn, tokensOut } = await callGemini(prompt);
      totalIn += tokensIn;
      totalOut += tokensOut;
      parsed = parseModelJson(out);
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  // Log whatever tokens we actually spent, even on failure (cost is cost).
  if (totalIn || totalOut) logUsage(user_id, college_id, totalIn, totalOut);

  if (!parsed) {
    await markFailed(docId, 'Our analyser had trouble reading this résumé. Please try again in a moment.');
    throw lastErr || new Error('resume analysis: unparseable model output'); // surfaces in logs
  }

  // 5. Model's résumé verdict.
  if (parsed.isResume === false) {
    await markFailed(docId, 'This does not look like a résumé. Please upload your CV / résumé as a PDF.');
    return;
  }

  // 6. Normalise to our fixed 7-parameter shape and store.
  const analysis = normaliseAnalysis(parsed);
  await markComplete(docId, analysis);
};

const worker = new Worker('resume-analysis', processJob, {
  connection: require('../config/redisConnection'),
});

worker.on('completed', (job) => console.log(`Resume job ${job.id} done (doc ${job.data.docId})`));
worker.on('failed', (job, err) => console.error(`Resume job ${job?.id} failed:`, err?.message));

module.exports = worker;
