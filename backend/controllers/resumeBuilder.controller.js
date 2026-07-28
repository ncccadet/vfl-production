/**
 * resumeBuilder.controller.js
 *
 * No daily AI limit on this feature (explicit founder decision — see
 * _contracts/07-resume-builder.md "Daily AI Limit"). Unlike every other AI
 * feature here, /build carries no featureLimit middleware.
 *
 * Two-tier design:
 *   POST /draft  — free, unlimited, no AI. Autosaves the form and returns a
 *                  deterministic completeness percentage (pure field-presence
 *                  math, zero AI cost) so the frontend can animate the live
 *                  progress bar on every keystroke without touching Gemini.
 *   POST /build  — enqueues ONE BullMQ job (Gemini polish + pdfkit render +
 *                  S3 upload). Heavy work never runs in the main API process
 *                  (project non-negotiable) — see resumeBuilder.worker.js.
 *
 * buildId == the BullMQ jobId == the eventual documents.doc_id. The worker is
 * handed this same UUID up front (via the `jobId` queue option) and uses it
 * as the primary key when it inserts the finished row, so /result/:buildId
 * can check job state AND look up the row with one shared identifier — no
 * placeholder "pending" row needs to exist in `documents` while the job runs.
 */
const crypto = require('crypto');
const { Pool } = require('pg');
const { Queue } = require('bullmq');
const AWS = require('aws-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
// Data only, no side effects — safe to import here. NEVER require the worker
// file itself from a controller; it starts a live BullMQ Worker as a side
// effect of being loaded, which belongs in its own process, not the API's.
const { TEMPLATE_IDS, TEMPLATE_LABELS, DEFAULT_TEMPLATE_ID } = require('../config/resumeTemplates');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // RDS requires SSL — see auth.controller.js
});

const resumeBuilderQueue = new Queue('resume-builder', { connection: require('../config/redisConnection') });

const s3 = new AWS.S3({ region: process.env.AWS_REGION });

const DRAFT_FEATURE = 'resume_builder_draft';
const BUILD_FEATURE = 'resume_builder';

// ── Shared model name for every in-page (synchronous) AI call in this feature
// — the per-field "AI Enhance" (POST /enhance) and the whole-draft "AI Enhance
// All" (POST /enhance-all). Both run synchronously (no BullMQ job) because the
// whole point is an instant, on-page rewrite while the student is still on the
// form, not a polled background job. Same no-daily-limit policy as the rest of
// this feature (founder decision).
const AI_MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

// ── Completeness scoring — deterministic, zero AI cost ───────────────────────
// Weights match the reference template's own footer checklist (see contract):
// Personal Info 20 (required) · Education 25 (required) · Skills 25 (required)
// · Experience 20 (bonus) · Achievements 10 (bonus). Bar admissions, languages,
// and the profile summary are captured but never scored.
const WEIGHTS = { personal_info: 20, education: 25, skills: 25, experience: 20, achievements: 10 };
const COMPULSORY_SECTIONS = ['personal_info', 'education', 'skills'];

const isFilled = (v) => typeof v === 'string' && v.trim().length > 0;

// Best-effort ratio of required sub-fields filled across all entries in an
// array section (Education / Experience) — picks whichever single entry is
// most complete, so a student doesn't need every entry finished for credit.
const bestEntryRatio = (entries, requiredKeys) => {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  let best = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const filledCount = requiredKeys.filter((k) => isFilled(entry[k])).length;
    best = Math.max(best, filledCount / requiredKeys.length);
  }
  return best;
};

const calculateCompleteness = (draft) => {
  const d = draft && typeof draft === 'object' ? draft : {};

  const personalInfoKeys = ['full_name', 'email', 'phone', 'target_field'];
  const personalInfo = d.personal_info && typeof d.personal_info === 'object' ? d.personal_info : {};
  const personalInfoRatio = personalInfoKeys.filter((k) => isFilled(personalInfo[k])).length / personalInfoKeys.length;

  const educationRatio = bestEntryRatio(d.education, ['institution', 'degree', 'year']);
  const experienceRatio = bestEntryRatio(d.experience, ['organization', 'role', 'duration']);

  const skills = d.skills && typeof d.skills === 'object' ? d.skills : {};
  const skillCount = Object.values(skills).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.filter((s) => isFilled(s)).length : 0),
    0
  );
  const skillsRatio = Math.min(skillCount, 3) / 3;

  const achievements = Array.isArray(d.achievements) ? d.achievements.filter((a) => isFilled(a)) : [];
  const achievementsRatio = achievements.length >= 1 ? 1 : 0;

  const scores = {
    personal_info: Math.round(personalInfoRatio * WEIGHTS.personal_info),
    education: Math.round(educationRatio * WEIGHTS.education),
    skills: Math.round(skillsRatio * WEIGHTS.skills),
    experience: Math.round(experienceRatio * WEIGHTS.experience),
    achievements: Math.round(achievementsRatio * WEIGHTS.achievements),
  };
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const canBuild = COMPULSORY_SECTIONS.every((section) => scores[section] === WEIGHTS[section]);

  return { total, ...scores, canBuild };
};

// Normalizes whatever the client sent into the shape we persist. Defensive
// against garbage/wrong-typed input (Stupid Path) — never throws, just drops
// anything malformed to a safe empty default instead of 500ing.
const normalizeDraft = (body) => {
  const b = body && typeof body === 'object' ? body : {};
  return {
    personal_info: b.personal_info && typeof b.personal_info === 'object' ? b.personal_info : {},
    profile_summary: isFilled(b.profile_summary) ? b.profile_summary : '',
    education: Array.isArray(b.education) ? b.education.slice(0, 10) : [],
    experience: Array.isArray(b.experience) ? b.experience.slice(0, 10) : [],
    // Same entry shape as experience; unscored bonus section (like achievements
    // beyond the first) — capped to keep the AI-polish payload bounded.
    volunteer: Array.isArray(b.volunteer) ? b.volunteer.slice(0, 5) : [],
    skills: b.skills && typeof b.skills === 'object' ? b.skills : {},
    achievements: Array.isArray(b.achievements) ? b.achievements.slice(0, 20) : [],
    certifications: Array.isArray(b.certifications) ? b.certifications.slice(0, 15) : [],
    bar_admissions: Array.isArray(b.bar_admissions) ? b.bar_admissions.slice(0, 10) : [],
    languages: Array.isArray(b.languages) ? b.languages.slice(0, 10) : [],
  };
};

// ── POST /draft — autosave, free, unlimited ───────────────────────────────────
const saveDraft = async (req, res, next) => {
  try {
    if (req.inputFlagged) return res.status(400).json({ error: 'Input too large' });
    const { user_id, college_id } = req.user;
    const draft = normalizeDraft(req.body);
    const completeness = calculateCompleteness(draft);

    const { rows: existing } = await pool.query(
      'SELECT doc_id FROM documents WHERE user_id = $1 AND college_id = $2 AND feature_name = $3 LIMIT 1',
      [user_id, college_id, DRAFT_FEATURE]
    );

    const analysisJson = { ...draft, completeness };

    if (existing.length > 0) {
      await pool.query('UPDATE documents SET analysis_json = $1 WHERE doc_id = $2', [analysisJson, existing[0].doc_id]);
    } else {
      await pool.query(
        `INSERT INTO documents (user_id, college_id, feature_name, template_type, s3_key, analysis_json)
         VALUES ($1, $2, $3, 'law_resume_v1', '', $4)`,
        [user_id, college_id, DRAFT_FEATURE, analysisJson]
      );
    }

    // canBuild lives INSIDE `completeness` — must match GET /draft's shape exactly
    // (that endpoint just re-serves the same stored object). Bug found during a live
    // end-to-end test (2026-07-20): this used to put canBuild as a sibling key instead,
    // so the frontend — which reads completeness.canBuild everywhere, matching GET
    // /draft's shape — always saw it as undefined after every autosave, permanently
    // disabling the Build button even once every compulsory section was complete.
    res.json({
      completeness: {
        total: completeness.total,
        personal_info: completeness.personal_info,
        education: completeness.education,
        experience: completeness.experience,
        skills: completeness.skills,
        achievements: completeness.achievements,
        canBuild: completeness.canBuild,
      },
    });
  } catch (err) { next(err); }
};

// ── GET /draft — resume where the student left off ────────────────────────────
const getDraft = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      'SELECT analysis_json FROM documents WHERE user_id = $1 AND college_id = $2 AND feature_name = $3 LIMIT 1',
      [user_id, college_id, DRAFT_FEATURE]
    );

    if (rows.length === 0) return res.json({ draft: null, completeness: calculateCompleteness(null) });

    const { completeness, ...draft } = rows[0].analysis_json;
    res.json({ draft, completeness });
  } catch (err) { next(err); }
};

// ── GET /templates — the whitelist the frontend picker renders from ──────────
const getTemplates = async (_req, res, next) => {
  try {
    res.json({ templates: TEMPLATE_IDS.map((id) => ({ id, label: TEMPLATE_LABELS[id] })), defaultTemplateId: DEFAULT_TEMPLATE_ID });
  } catch (err) { next(err); }
};

// ── POST /build — no daily limit; enqueue the one AI + PDF job ────────────────
const buildResume = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;

    // Student picks a template at Build time (not up front) — same saved
    // draft can be rendered into any template without re-entering data.
    const requestedTemplateId = req.body?.template_id;
    if (requestedTemplateId !== undefined && !TEMPLATE_IDS.includes(requestedTemplateId)) {
      return res.status(400).json({ error: 'Unknown template_id.', validTemplateIds: TEMPLATE_IDS });
    }
    const templateId = requestedTemplateId || DEFAULT_TEMPLATE_ID;

    const { rows } = await pool.query(
      'SELECT analysis_json FROM documents WHERE user_id = $1 AND college_id = $2 AND feature_name = $3 LIMIT 1',
      [user_id, college_id, DRAFT_FEATURE]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No resume details saved yet. Fill out the form before building.' });
    }

    const { completeness, ...draft } = rows[0].analysis_json;
    const freshCompleteness = calculateCompleteness(draft); // never trust a stale stored value — recompute now

    if (!freshCompleteness.canBuild) {
      const missing = COMPULSORY_SECTIONS.filter((s) => freshCompleteness[s] < WEIGHTS[s]);
      return res.status(400).json({ error: 'Compulsory sections incomplete.', missing });
    }

    // ── Duplicate-build guard ────────────────────────────────────────────────
    // This feature has NO daily limit (intentional founder decision), so the
    // one thing we DO guard is pure waste: a fast double-click (Stupid Path) or
    // a stuck frontend firing /build several times enqueues several distinct
    // Gemini-polish + PDF-render jobs for the same student — real cost and CPU
    // for zero benefit, since only the last result is ever shown. Each jobId is
    // a fresh UUID, so BullMQ can't dedupe these on its own. Before enqueuing we
    // scan this student's own not-yet-finished jobs; if one is already in
    // flight we return it (202) so the frontend simply keeps polling the build
    // that's already running instead of starting another. This is NOT a rate
    // limit — once a build finishes, the student can immediately build again as
    // many times as they like.
    const pendingJobs = await resumeBuilderQueue.getJobs(['active', 'waiting', 'delayed', 'paused']);
    const existing = pendingJobs.find(
      (j) => j?.data?.user_id === user_id && j?.data?.college_id === college_id
    );
    if (existing) {
      return res.status(202).json({ buildId: existing.id, status: 'processing' });
    }

    const buildId = crypto.randomUUID();
    await resumeBuilderQueue.add(
      'build',
      { doc_id: buildId, user_id, college_id, draft, template_id: templateId },
      { jobId: buildId }
    );

    res.status(202).json({ buildId, status: 'processing' });
  } catch (err) { next(err); }
};

// ── GET /photo-upload-url — presigned S3 PUT for the profile photo ────────────
// Matches the project's own rule that uploads go client → S3 directly, never
// through the API process. The frontend PUTs the raw file straight to this
// URL, then saves the returned photoKey into personal_info.photo_key on the
// next /draft autosave — the worker downloads it from S3 at build time.
const ALLOWED_PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png'];
const ALLOWED_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png'];

const getPhotoUploadUrl = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const extRaw = (req.query.ext || 'jpg').toLowerCase().replace(/[^a-z]/g, '');
    const ext = ALLOWED_PHOTO_EXTENSIONS.includes(extRaw) ? extRaw : 'jpg';
    const contentType = ALLOWED_PHOTO_CONTENT_TYPES.includes(req.query.contentType) ? req.query.contentType : 'image/jpeg';

    // Fixed key per student (not per-upload) — a re-upload simply overwrites
    // the old photo in S3, so a rebuild always uses the latest one and no
    // orphaned photo objects accumulate per student over time.
    const photoKey = `resume-photos/${college_id}/${user_id}/photo.${ext}`;
    const uploadUrl = s3.getSignedUrl('putObject', {
      Bucket: process.env.S3_BUCKET_FILES,
      Key: photoKey,
      Expires: 120,
      ContentType: contentType,
    });

    res.json({ uploadUrl, photoKey });
  } catch (err) { next(err); }
};

// ── POST /enhance-all — rewrite EVERY free-text field at once, no daily limit ─
// Replaces the old "AI Analyze" (which only returned a score + tips). This
// takes the student's whole current draft and rewrites the WORDING of every
// narrative field into professional, action-verb-led resume phrasing, then
// returns the improved values so the frontend can drop them straight back into
// the form fields the student is looking at (profile summary, experience &
// volunteer bullets, achievements, education coursework/honors, and the
// formatting of the skill lists).
//
// HARD SAFETY LINE (same as the build-time polish): it only ever rewrites
// PHRASING. It never touches hard facts — institution, degree, year, GPA,
// organization, role, dates — and never adds, removes, merges, or invents a
// skill or an achievement. Skills are only tidied for capitalisation/spacing.
//
// Reads the draft straight from the request body (what's on screen right now),
// not from the DB, so the student never has to wait for an autosave first.
const ENHANCE_ALL_MAX_INPUT_CHARS = 8000;
// Generous output cap: this rewrites many bullets in one call, and
// gemini-3.1-flash-lite is a reasoning model that can spend part of its budget
// thinking before emitting — too tight a cap truncates the JSON.
const ENHANCE_ALL_MAX_OUTPUT_TOKENS = 2000;

const buildEnhanceAllPrompt = (draft) => {
  const payload = {
    profile_summary: draft.profile_summary || '',
    experience: (draft.experience || []).map((e) => ({ role: e.role, bullets: e.bullets || [] })),
    volunteer: (draft.volunteer || []).map((e) => ({ role: e.role, bullets: e.bullets || [] })),
    achievements: draft.achievements || [],
    education: (draft.education || []).map((e) => ({ coursework: e.coursework || '', honors: e.honors || '' })),
    skills: draft.skills || {},
  };
  return (
    'You are polishing the WORDING of a law student\'s resume. Rewrite each piece of text into ' +
    'concise, professional, action-verb-led resume phrasing. ' +
    'HARD RULES — never break these: ' +
    '(1) Do NOT invent facts, numbers, dates, employers, statutes, skills, or achievements not present in the input. ' +
    '(2) Preserve every specific already written: statute/regulator names (SEBI, Companies Act 2013, GDPR, IBC) stay verbatim; ' +
    'every number (clients served, team size, memos drafted) stays; moot-court levels and the student\'s stated role/result stay exactly. ' +
    '(3) For SKILLS: only fix capitalisation and spacing of each item — never add, remove, merge, split, or reword a skill. ' +
    '(4) For EDUCATION: only polish the phrasing of coursework and honors — do NOT change institution, degree, year, or GPA (those are not even in your input). ' +
    'Keep the SAME array lengths and the SAME index order as the input for experience, volunteer, achievements, and education, so each rewrite maps back to its entry. ' +
    'Return ONLY valid JSON, no markdown fences, matching exactly this shape: ' +
    '{"profile_summary": string, ' +
    '"experience": [{"bullets": [string]}], ' +
    '"volunteer": [{"bullets": [string]}], ' +
    '"achievements": [string], ' +
    '"education": [{"coursework": string, "honors": string}], ' +
    '"skills": {"legal": [string], "advocacy": [string], "research_tools": [string], "drafting": [string], "software": [string], "soft_skills": [string]}}. ' +
    `Input:\n${JSON.stringify(payload)}`
  );
};

const parseEnhanceAllJson = (text) => {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
};

const enhanceAll = async (req, res, next) => {
  try {
    if (req.inputFlagged) return res.status(400).json({ error: 'Input too large' });
    const { user_id, college_id } = req.user;

    // Read the draft the frontend sent (what's on screen), normalise it against
    // garbage/oversized input, then bound the total size before it reaches Gemini.
    const draft = normalizeDraft(req.body);
    const inputChars = JSON.stringify(draft).length;
    if (inputChars > ENHANCE_ALL_MAX_INPUT_CHARS) {
      return res.status(400).json({ error: 'Your resume is too long to enhance in one pass — try the per-field ✦ Enhance buttons instead.' });
    }

    const hasText =
      isFilled(draft.profile_summary) ||
      (draft.achievements || []).some(isFilled) ||
      (draft.experience || []).some((e) => (e.bullets || []).some(isFilled)) ||
      (draft.volunteer || []).some((e) => (e.bullets || []).some(isFilled)) ||
      (draft.education || []).some((e) => isFilled(e.coursework) || isFilled(e.honors));
    if (!hasText) {
      return res.status(400).json({ error: 'Write a few lines first — then AI Enhance can polish your resume.' });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: AI_MODEL_NAME,
      generationConfig: { maxOutputTokens: ENHANCE_ALL_MAX_OUTPUT_TOKENS, temperature: 0.4 },
    });

    // Retry once on a malformed JSON response (same pattern as the build polish).
    const prompt = buildEnhanceAllPrompt(draft);
    let polished, usage, lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await model.generateContent(prompt);
      usage = result.response.usageMetadata || {};
      try { polished = parseEnhanceAllJson(result.response.text()); break; }
      catch (e) { lastErr = e; }
    }
    if (!polished) throw (lastErr instanceof SyntaxError ? lastErr : new SyntaxError('Gemini did not return valid JSON.'));

    // Merge the model's rewrites back onto the student's own draft, index by
    // index, ALWAYS falling back to the original value — so a short/omitted
    // model response can only ever leave a field unchanged, never blanked and
    // never re-ordered. Hard facts (institution/degree/year/role/org/dates)
    // are copied through untouched because the model was never given them.
    const mergedEducation = (draft.education || []).map((e, i) => ({
      ...e,
      coursework: polished.education?.[i]?.coursework ?? e.coursework ?? '',
      honors: polished.education?.[i]?.honors ?? e.honors ?? '',
    }));
    const mergedExperience = (draft.experience || []).map((e, i) => ({
      ...e,
      bullets: polished.experience?.[i]?.bullets?.length ? polished.experience[i].bullets : (e.bullets || []),
    }));
    const mergedVolunteer = (draft.volunteer || []).map((e, i) => ({
      ...e,
      bullets: polished.volunteer?.[i]?.bullets?.length ? polished.volunteer[i].bullets : (e.bullets || []),
    }));
    // Skills: keep only the tidied strings for the SAME items — never let the
    // model change how many skills there are, only their formatting.
    const mergedSkills = {};
    for (const key of Object.keys(draft.skills || {})) {
      const original = Array.isArray(draft.skills[key]) ? draft.skills[key] : [];
      const tidied = Array.isArray(polished.skills?.[key]) ? polished.skills[key] : [];
      mergedSkills[key] = tidied.length === original.length ? tidied : original;
    }

    const enhancedDraft = {
      ...draft,
      profile_summary: (typeof polished.profile_summary === 'string' && polished.profile_summary.trim())
        ? polished.profile_summary.trim() : draft.profile_summary,
      experience: mergedExperience,
      volunteer: mergedVolunteer,
      achievements: (Array.isArray(polished.achievements) && polished.achievements.length)
        ? polished.achievements.filter((a) => typeof a === 'string') : draft.achievements,
      education: mergedEducation,
      skills: mergedSkills,
    };

    // Best-effort usage logging — a DB blip must never cost the student their
    // enhancement (same non-fatal pattern as everywhere else in this feature).
    try {
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
         VALUES ($1, $2, 'resume_builder_enhance_all', $3, $4, $5)`,
        [user_id, college_id, AI_MODEL_NAME, usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0]
      );
    } catch (logErr) {
      console.error('[resume_builder_enhance_all] ai_usage_log insert failed (non-fatal):', logErr);
    }

    res.json({ draft: enhancedDraft, note: 'AI-assisted rewrite for educational purposes only. Verify with a qualified advocate.' });
  } catch (err) {
    // A malformed/unparseable Gemini response surfaces as a clean "try again"
    // rather than a raw 500.
    if (err instanceof SyntaxError) {
      return res.status(502).json({ error: 'Could not enhance right now — please try again.' });
    }
    next(err);
  }
};

// ── POST /enhance — per-field AI rewrite, no daily limit ─────────────────────
// The in-form "AI Enhance" button: takes ONE free-text field's current value
// (profile summary, an experience/volunteer bullets box, achievements) and
// returns it rewritten into professional resume phrasing. Same no-daily-limit
// policy as the rest of this feature (founder decision), but tightly bounded:
// input capped at 1,500 chars, output at 350 tokens, one field per call.
// Distinct from /analyze (scores the whole draft) and from the build-time
// polish (rewrites everything at once) — this is instant, field-scoped.
const ENHANCE_MAX_INPUT_CHARS = 1500;
const ENHANCE_MAX_OUTPUT_TOKENS = 350;

const buildEnhancePrompt = (text) => (
  'Rewrite this law student resume text into concise, professional, action-verb-led phrasing. ' +
  'HARD RULES: do not invent facts, numbers, dates, employers, statutes, or achievements not present ' +
  'in the input. Preserve every specific the student wrote: statute/regulator names (SEBI, Companies ' +
  'Act 2013, GDPR, IBC) stay verbatim, every number (clients served, team size, memos drafted) stays, ' +
  'moot court levels and roles stay exactly as written. If the input is multiple lines, return the ' +
  'same number of lines or fewer, one polished point per line. ' +
  'Return ONLY valid JSON, no markdown fences: {"enhanced": string}. ' +
  `Input text:\n${text}`
);

const enhanceText = async (req, res, next) => {
  try {
    if (req.inputFlagged) return res.status(400).json({ error: 'Input too large' });
    const { user_id, college_id } = req.user;

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (text.length < 10) {
      return res.status(400).json({ error: 'Write a few words first — then AI Enhance can improve them.' });
    }
    if (text.length > ENHANCE_MAX_INPUT_CHARS) {
      return res.status(400).json({ error: `Text too long to enhance (max ${ENHANCE_MAX_INPUT_CHARS} characters). Split it up.` });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: AI_MODEL_NAME,
      generationConfig: { maxOutputTokens: ENHANCE_MAX_OUTPUT_TOKENS, temperature: 0.35 },
    });

    const result = await model.generateContent(buildEnhancePrompt(text));
    const cleaned = result.response.text().trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned);
    const enhanced = typeof parsed.enhanced === 'string' && parsed.enhanced.trim() ? parsed.enhanced.trim() : text;
    const usage = result.response.usageMetadata || {};

    // Same non-fatal logging pattern as analyzeResume above — a DB blip on
    // the usage-log write must never cost the student their AI Enhance
    // result. See that comment for the full explanation.
    try {
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
         VALUES ($1, $2, 'resume_builder_enhance', $3, $4, $5)`,
        [user_id, college_id, AI_MODEL_NAME, usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0]
      );
    } catch (logErr) {
      console.error('[resume_builder_enhance] ai_usage_log insert failed (non-fatal):', logErr);
    }

    // Every AI-generated response must carry the standard disclaimer (project
    // Security Non-Negotiable) — /analyze and the PDF footer already do; this
    // endpoint was the one AI response missing it.
    res.json({ enhanced, note: 'AI-assisted rewrite for educational purposes only. Verify with a qualified advocate.' });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(502).json({ error: 'Could not enhance right now — please try again.' });
    }
    next(err);
  }
};

// ── GET /result/:buildId — poll job + fetch the finished PDF's URL ────────────
const getBuildResult = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { buildId } = req.params;

    const job = await resumeBuilderQueue.getJob(buildId);
    if (!job) return res.status(404).json({ error: 'Build not found.' });

    // Access Path: this buildId exists, but does it belong to the caller?
    if (job.data.user_id !== user_id || job.data.college_id !== college_id) {
      return res.status(403).json({ error: 'Not authorized to view this build.' });
    }

    const state = await job.getState();

    if (state === 'completed') {
      const { rows } = await pool.query(
        'SELECT s3_key FROM documents WHERE doc_id = $1 AND user_id = $2 AND college_id = $3 AND feature_name = $4',
        [buildId, user_id, college_id, BUILD_FEATURE]
      );
      if (rows.length === 0) {
        // Job flipped to completed a beat before its DB write committed — treat as still processing.
        return res.json({ status: 'processing', downloadUrl: null });
      }
      const downloadUrl = s3.getSignedUrl('getObject', {
        Bucket: process.env.S3_BUCKET_FILES,
        Key: rows[0].s3_key,
        Expires: 300,
      });
      return res.json({ status: 'done', downloadUrl });
    }

    if (state === 'failed') {
      return res.json({ status: 'failed', downloadUrl: null });
    }

    res.json({ status: 'processing', downloadUrl: null });
  } catch (err) { next(err); }
};

// ── GET /download — most recent finished resume, no rebuild ───────────────────
const getResume = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT s3_key FROM documents
       WHERE user_id = $1 AND college_id = $2 AND feature_name = $3
       ORDER BY created_at DESC LIMIT 1`,
      [user_id, college_id, BUILD_FEATURE]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'No resume built yet.' });

    const downloadUrl = s3.getSignedUrl('getObject', {
      Bucket: process.env.S3_BUCKET_FILES,
      Key: rows[0].s3_key,
      Expires: 300,
    });
    res.json({ downloadUrl });
  } catch (err) { next(err); }
};

module.exports = { getTemplates, saveDraft, getDraft, buildResume, getBuildResult, getResume, getPhotoUploadUrl, enhanceAll, enhanceText };
