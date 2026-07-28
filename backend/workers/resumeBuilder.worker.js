/**
 * resumeBuilder.worker.js — BullMQ worker
 *
 * Why a worker? Same reason as every other AI feature here: a Gemini call +
 * PDF render can take several seconds, and running that inside the main API
 * process would hold a request open and make a slow Gemini response look
 * like a platform outage. This runs off-request; the frontend polls
 * GET /result/:buildId (see resumeBuilder.controller.js).
 *
 * Flow per job:
 *   1. Take the already-saved draft (job.data.draft — the controller already
 *      validated the 3 compulsory sections before enqueueing) and the
 *      student's chosen template_id (validated by the controller against
 *      TEMPLATE_IDS below — never trust an unvalidated string this far in).
 *   2. ONE Gemini call — polishes only the free-text a student wrote
 *      (profile summary, experience bullets, achievements) into professional
 *      phrasing. Structural fields (institution, degree, year, dates,
 *      organization, skills) are NEVER touched by the model — see the
 *      contract's "why the model never generates the layout" note. Retries
 *      once on a malformed JSON response, matching draftingLab.worker.js's
 *      documented pattern.
 *   3. Render the CHOSEN template with pdfkit — no headless browser, safe on
 *      a t3.micro/t3.small. Entries use standard professional resume layout
 *      (bold institution/role line, dates right-aligned, italic subline) —
 *      the earlier "College:/Organization: label on every field" rule was
 *      reversed 2026-07 after feedback that it read like a printed form, not
 *      a resume. Labels are kept only where they add meaning (Coursework:,
 *      Honors:). If this reversal needs founder sign-off, see the decisions log.
 *   4. Upload the PDF to S3.
 *   5. INSERT INTO documents using the SAME doc_id the controller already
 *      handed out as the BullMQ jobId, storing which template was used in
 *      template_type — this is what lets /result/:buildId look up both the
 *      job state and the DB row with one identifier.
 *   6. Log real token usage (from Gemini's response, not an estimate) to
 *      ai_usage_log — this is the only cost visibility this feature has,
 *      since it has no Redis daily-limit counter (see contract).
 *
 * No daily limit on this feature (explicit founder decision — see
 * _contracts/07-resume-builder.md). If the job throws anywhere below, BullMQ
 * marks it 'failed' and the student sees status:'failed' on next poll — no
 * row is ever written to `documents` for a failed build, and no partial S3
 * object is left referenced anywhere.
 */
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const AWS = require('aws-sdk');
const PDFDocument = require('pdfkit');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // RDS requires SSL — see auth.controller.js
});
const s3 = new AWS.S3({ region: process.env.AWS_REGION });

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
// Raised 1200 → 1600 alongside the Volunteer & Certifications sections — a
// fully-filled draft with 2 experience + 2 volunteer entries was tripping the
// old pre-flight char guard even though the actual Gemini cost is still tiny.
const MAX_INPUT_TOKENS = 1600;
// Raised from 700 → 1200 (founder decision, 2026-07), then 1200 → 1400 when
// the Volunteer & Pro Bono section was added to the polish scope (10-12 total
// bullets across experience + volunteer + achievements). Cost impact is still
// small — but the contract's Cost Calculation section must be updated to
// reflect this new cap before the next founder review.
const MAX_OUTPUT_TOKENS = 1400;
// Rough char-per-token heuristic (same style as sanitize.middleware.js's
// char-count safety net) used ONLY as a pre-flight guard so a pathologically
// large draft never even reaches Gemini — the real accounting after the call
// uses the token counts Gemini itself returns in usageMetadata.
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

const PAGE_MARGIN = 50;
// Reserved width for the right-aligned date on every entry's title line.
// Titles must NEVER get the full content width while the date right-aligns
// over the same y — long titles ('Research Assistant, Prof. R. Iyer,
// Securities Law Chair') were colliding with their dates. Titles wrap
// within (width - DATE_COL_W) instead, like the reference designs'
// dedicated date column.
const DATE_COL_W = 95;
const { TEMPLATE_IDS: KNOWN_TEMPLATE_IDS, DEFAULT_TEMPLATE_ID } = require('../config/resumeTemplates');

// ── Step 2: Gemini — polish free text only, never structure ──────────────────
const buildGeminiPrompt = (draft) => {
  const payload = {
    profile_summary: draft.profile_summary || '',
    experience_bullets: (draft.experience || []).map((e) => ({ role: e.role, bullets: e.bullets || [] })),
    volunteer_bullets: (draft.volunteer || []).map((e) => ({ role: e.role, bullets: e.bullets || [] })),
    achievements: draft.achievements || [],
  };
  return (
    'You are helping a law student polish the WORDING of parts of their resume. ' +
    'Do not invent facts, dates, employers, numbers, statutes, or achievements that are not present below. ' +
    'Rewrite each piece of text into concise, professional, action-verb-led resume phrasing. ' +
    'Preserve and foreground SPECIFICS the student already wrote: if a bullet names a statute, ' +
    'regulation, or body (e.g. SEBI, Companies Act 2013, GDPR, IBC), keep that exact name in the ' +
    'polished bullet — never flatten it into generic phrases like "regulatory compliance". ' +
    'Keep every number the student wrote (clients served, team size, matters handled, memos drafted) ' +
    'in the rewritten bullet — quantified bullets always beat vague ones. Never add a number that is ' +
    'not in the input. For moot court or competition achievements, keep the competition level ' +
    '(national/international) and the student\'s stated role or result exactly as written. ' +
    'If an experience or volunteer entry has fewer than 3 bullets, you may split a longer sentence ' +
    'into 2-4 more granular bullets so the entry reads fully — but every bullet must still be ' +
    'traceable to something the student actually wrote, never a new fact. Aim for 3-5 polished ' +
    'bullets per entry, and up to 10-12 total bullets combined across experience + volunteer + ' +
    'achievements, when the source material genuinely supports it — accuracy always outweighs ' +
    'hitting a count. ' +
    'Return ONLY valid JSON, no markdown fences, matching exactly this shape: ' +
    '{"profile_summary": string, "experience_bullets": [{"role": string, "bullets": [string]}], ' +
    '"volunteer_bullets": [{"role": string, "bullets": [string]}], "achievements": [string]}. ' +
    `Input:\n${JSON.stringify(payload)}`
  );
};

const parseGeminiJson = (text) => {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
};

const polishWithGemini = async (draft) => {
  const inputText = JSON.stringify(draft);
  if (inputText.length > MAX_INPUT_CHARS) {
    throw new Error(`Draft too large for AI polish (${inputText.length} chars, cap is ~${MAX_INPUT_CHARS}).`);
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.4 },
  });

  const prompt = buildGeminiPrompt(draft);
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    try {
      const polished = parseGeminiJson(text);
      const usage = result.response.usageMetadata || {};
      return { polished, tokensIn: usage.promptTokenCount ?? 0, tokensOut: usage.candidatesTokenCount ?? 0 };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Gemini did not return valid JSON after 2 attempts: ${lastError?.message}`);
};

// ── Shared label helper — used ONLY where a label genuinely adds meaning
// (Coursework:, Honors:). Entry primary lines are now plain professional
// layout (bold title + right-aligned dates), never "Field: value" dumps.
const withLabel = (label, value) => (value ? `${label}: ${value}` : '');

// Photo is optional everywhere — a student who never uploaded one still gets
// a normal resume, nothing shifts or leaves a gap. `photoBuffer` is raw image
// bytes already downloaded from S3 by processBuild (never touched here).
// pdfkit has no native "rounded/circular image" primitive, so we clip a
// circular path and draw the image inside it — wrapped in try/catch because
// a corrupt or unsupported image format should never fail the whole build,
// just silently skip the photo.
const drawCircularPhoto = (doc, photoBuffer, cx, cy, radius) => {
  if (!photoBuffer) return false;
  try {
    doc.save();
    doc.circle(cx, cy, radius).clip();
    doc.image(photoBuffer, cx - radius, cy - radius, { width: radius * 2, height: radius * 2 });
    doc.restore();
    return true;
  } catch (_) {
    doc.restore();
    return false;
  }
};

// ── Page-fill helper — shared by every template family ───────────────────────
// The single biggest complaint that drove this round of changes: a resume
// with modest content (say 4-5 sections) would render its sections back to
// back at fixed spacing, finish a third of the way down the page, and leave
// a large dead white gap below — reading as "unfinished" even though every
// section that HAD data was shown. We never invent content to fill that gap
// (the contract forbids the model touching facts). Instead we count how many
// natural "gap points" a given draft will produce (once, from the draft data
// itself — no PDF math needed) and, after a cheap measuring pass tells us
// how tall the content is at normal spacing, distribute the leftover
// vertical space evenly across those gap points. A sparse resume gets more
// breathing room between sections; a full resume is untouched (extraGap
// clamps to 0 once content already reaches the bottom of the page).
// Each section contributes ONE gap point (before its header) plus one gap
// point BETWEEN entries when it holds more than one (never after the last
// entry — that transition is already covered by the next section's header
// gap). Double-counting that last-entry transition was what produced one
// oversized gap right before the next heading instead of even rhythm.
const countSectionGaps = (draft) => {
  let n = 1; // the closing rule before the footer disclaimer, always present
  if (draft.profile_summary) n += 1;
  if ((draft.education || []).length > 0) n += 1 + Math.max(0, draft.education.length - 1);
  const skills = draft.skills || {};
  const skillKeys = ['legal', 'advocacy', 'research_tools', 'drafting', 'software', 'soft_skills'];
  if (skillKeys.some((k) => (skills[k] || []).length > 0)) n += 1;
  if ((draft.experience || []).length > 0) n += 1 + Math.max(0, draft.experience.length - 1);
  if ((draft.volunteer || []).length > 0) n += 1 + Math.max(0, draft.volunteer.length - 1);
  if ((draft.achievements || []).length > 0) n += 1;
  if ((draft.certifications || []).length > 0) n += 1;
  if ((draft.bar_admissions || []).length > 0) n += 1;
  if ((draft.languages || []).length > 0) n += 1;
  return n;
};
// Cap how much any single gap can grow — even a resume with just one
// section should still look like a resume, not five section headers spread
// across a page with huge canyons of whitespace between them.
const MAX_EXTRA_GAP = 56;
// `measuredPages` guard (2026-07 fix): if the measuring pass itself spilled
// onto a second page, measureDoc.y has RESET to the top of that new page —
// so it reads as "very short content", the deficit looks huge, and the real
// pass would balloon an already-full resume with maximum gaps (observed:
// a 2-page resume rendering as 3 pages, the last holding one line). A resume
// that already fills a page needs zero extra breathing room — return 0.
const computeExtraGap = (availableHeight, measuredHeight, gapCount, measuredPages = 1) => {
  if (gapCount <= 0 || measuredPages > 1) return 0;
  const deficit = availableHeight - measuredHeight;
  return Math.max(0, Math.min(MAX_EXTRA_GAP, deficit / gapCount));
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE FAMILY 1 — single column, 5 visual variants sharing one layout
// engine, differing only by theme (color, font weight, header treatment).
// ═══════════════════════════════════════════════════════════════════════════
// Draws the header (name/role/contact + rule) starting at doc.y === 0 and
// returns the y it left off at — extracted so the measuring pass can learn
// the real starting y for the body without duplicating this block.
const drawSingleColumnHeader = (doc, draft, theme, pageWidth, photoBuffer) => {
  const { accent, text: textColor, headerFont, bodyFont, nameAlign, banner, ruleWeight } = theme;
  const p = draft.personal_info || {};
  if (banner) {
    doc.rect(0, 0, pageWidth, 112).fill(accent);
    drawCircularPhoto(doc, photoBuffer, pageWidth - PAGE_MARGIN - 32, 56, 32);
    doc.fillColor('#ffffff').font(headerFont).fontSize(27).text((p.full_name || 'STUDENT NAME').toUpperCase(), PAGE_MARGIN, 30, { align: nameAlign, characterSpacing: 0.5 });
    if (p.target_field) doc.font(headerFont).fontSize(10.5).fillColor('#ffffff').text(p.target_field.toUpperCase(), { align: nameAlign, characterSpacing: 0.75 });
    doc.y = 132;
    doc.fillColor(textColor);
  } else {
    drawCircularPhoto(doc, photoBuffer, pageWidth - PAGE_MARGIN - 32, 32, 32);
    doc.fillColor(accent).font(headerFont).fontSize(27).text((p.full_name || 'STUDENT NAME').toUpperCase(), { align: nameAlign, characterSpacing: 0.5 });
    if (p.target_field) doc.font(headerFont).fontSize(10.5).fillColor(accent).text(p.target_field.toUpperCase(), { align: nameAlign, characterSpacing: 0.75 });
  }
  const contactLine = [p.email, p.phone, p.city_country, p.linkedin].filter(Boolean).join('    |    ');
  if (contactLine) {
    doc.moveDown(0.35);
    doc.font(bodyFont).fontSize(9.5).fillColor(textColor).text(contactLine, { align: nameAlign });
  }
  doc.moveDown(0.4);
  // A thin+thick double rule under the header reads as a more deliberately
  // designed touch than a single line, at basically no extra cost.
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(pageWidth - PAGE_MARGIN, doc.y).strokeColor(accent).lineWidth(ruleWeight + 1).stroke();
  doc.moveTo(PAGE_MARGIN, doc.y + 3).lineTo(pageWidth - PAGE_MARGIN, doc.y + 3).strokeColor(accent).lineWidth(0.5).stroke();
  doc.y += 6;
};

// Draws every content section (Profile → Languages) plus the closing rule +
// disclaimer. `extraGap` is added on top of the normal spacing at each
// natural break point — 0 during the measuring pass, the computed fill
// amount during the real pass. Word-level spacing/line-wrapping itself is
// untouched (pdfkit's own justification), so text never looks "crowded" —
// only the breathing room BETWEEN blocks grows.
const drawSingleColumnBody = (doc, draft, theme, pageWidth, extraGap) => {
  const { accent, text: textColor, muted, headerFont, bodyFont, italicFont, ruleWeight } = theme;

  const sectionHeader = (title) => {
    doc.moveDown(0.8);
    doc.y += extraGap;
    doc.fillColor(accent).font(headerFont).fontSize(13).text(title.toUpperCase(), { characterSpacing: 1.2 });
    const y = doc.y + 2;
    doc.moveTo(PAGE_MARGIN, y).lineTo(pageWidth - PAGE_MARGIN, y).strokeColor(accent).lineWidth(ruleWeight).stroke();
    doc.moveDown(0.45);
  };
  // Bullet marker drawn in the accent color, text in the body color — a
  // small but noticeably more designed touch than a plain black "•", plus
  // a generous paragraphGap/lineGap so bullets breathe on their own, not
  // just via whitespace dumped between sections.
  const bulletList = (items) => {
    items.filter(Boolean).forEach((item) => {
      doc.font(bodyFont).fontSize(10.5).fillColor(accent).text('•  ', PAGE_MARGIN + 10, doc.y, { continued: true });
      doc.fillColor(textColor).text(item, { paragraphGap: 6, lineGap: 2.2 });
    });
  };
  // `entryRow` sets doc.x/doc.y explicitly for BOTH the title and the date —
  // and pdfkit's positioned text() still mutates doc.y to sit just below
  // whichever piece it drew LAST. Because the date is single-line and drawn
  // after a title that can wrap to 2+ lines, doc.y was snapping back up to
  // the date's (shorter) height, so the next line (an italic org/location
  // subline) got drawn ON TOP of the title's wrapped second line — the
  // "Chair" collision. Fix: capture both endpoints, keep the taller one.
  const entryRow = (title, dateRange) => {
    const y = doc.y;
    doc.fillColor(textColor).font(headerFont).fontSize(11.5).text(title, PAGE_MARGIN, y, { width: pageWidth - PAGE_MARGIN * 2 - DATE_COL_W });
    const titleEndY = doc.y;
    if (dateRange) {
      doc.font(bodyFont).fontSize(9.5).fillColor(muted).text(dateRange, PAGE_MARGIN, y + 1, { width: pageWidth - PAGE_MARGIN * 2, align: 'right', lineBreak: false });
    }
    doc.y = Math.max(titleEndY, doc.y) + 2; // even breathing room before the subline — same gap in every family
  };

  if (draft.profile_summary) {
    sectionHeader('Profile');
    doc.font(bodyFont).fontSize(10.5).fillColor(textColor).text(draft.profile_summary, { lineGap: 3 });
  }

  // Professional entry style (2026-07 restructure): institution/organization
  // in bold with dates right-aligned, degree/role in italic beneath — the old
  // "College: X / Degree: Y" label-prefix style read like a printed form, not
  // a resume, and was the root of the "not structured properly" feedback.
  // Labels are kept ONLY where they genuinely add meaning (Coursework:, Honors:).
  const eduEntry = (e) => {
    entryRow(e.institution || '—', e.year || '');
    const subline = [e.degree, e.gpa].filter(Boolean).join('   ·   ');
    if (subline) doc.font(italicFont).fontSize(10).fillColor(textColor).text(subline, { paragraphGap: 4 });
    bulletList([withLabel('Coursework', e.coursework), withLabel('Honors', e.honors)]);
  };
  const workEntry = (e) => {
    entryRow([e.role, e.organization].filter(Boolean).join(', ') || '—', e.duration || '');
    if (e.location) doc.font(italicFont).fontSize(10).fillColor(textColor).text(e.location, { paragraphGap: 4 });
    bulletList(e.bullets || []);
  };

  if ((draft.education || []).length > 0) {
    sectionHeader('Education');
    draft.education.forEach((e, i, arr) => {
      eduEntry(e);
      doc.moveDown(0.5);
      if (i < arr.length - 1) doc.y += extraGap; // between entries only — the next section header already adds its own gap
    });
  }

  const skills = draft.skills || {};
  const skillLabels = { legal: 'Legal', advocacy: 'Advocacy', research_tools: 'Research Tools', drafting: 'Drafting', software: 'Software', soft_skills: 'Soft Skills' };
  const skillRows = Object.entries(skillLabels).filter(([key]) => (skills[key] || []).length > 0);
  if (skillRows.length > 0) {
    sectionHeader('Skills');
    skillRows.forEach(([key, label]) => {
      doc.font(headerFont).fontSize(10).fillColor(textColor).text(`${label}: `, { continued: true, paragraphGap: 7 });
      doc.font(bodyFont).fillColor(textColor).text(skills[key].join(', '));
    });
  }

  if ((draft.experience || []).length > 0) {
    sectionHeader('Experience & Internships');
    draft.experience.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.5);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }

  if ((draft.volunteer || []).length > 0) {
    sectionHeader('Volunteer & Pro Bono');
    draft.volunteer.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.5);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }

  if ((draft.achievements || []).length > 0) {
    sectionHeader('Achievements & Activities');
    bulletList(draft.achievements);
  }

  if ((draft.certifications || []).length > 0) {
    sectionHeader('Certifications & Courses');
    bulletList(draft.certifications);
  }

  if ((draft.bar_admissions || []).length > 0) {
    sectionHeader('Bar Admissions');
    doc.font(bodyFont).fontSize(10).fillColor(textColor).text(draft.bar_admissions.join('  ·  '), { lineGap: 3 });
  }

  if ((draft.languages || []).length > 0) {
    sectionHeader('Languages');
    doc.font(bodyFont).fontSize(10).fillColor(textColor).text(draft.languages.join('  ·  '), { lineGap: 3 });
  }

  doc.moveDown(1.2);
  doc.y += extraGap;
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(pageWidth - PAGE_MARGIN, doc.y).strokeColor(muted).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.font(italicFont).fontSize(7.5).fillColor(muted).text('For educational purposes only. Verify with a qualified advocate.', { align: 'center' });
};

const renderSingleColumnTemplate = (draft, theme, photoBuffer) => {
  // ── Measuring pass: identical header + body at extraGap=0 on a disposable
  // doc, just to learn how tall the content naturally is.
  const measureDoc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  measureDoc.on('data', () => {});
  drawSingleColumnHeader(measureDoc, draft, theme, measureDoc.page.width, null);
  drawSingleColumnBody(measureDoc, draft, theme, measureDoc.page.width, 0);
  const measuredHeight = measureDoc.y;
  const measuredPages = measureDoc.bufferedPageRange().count; // read BEFORE end() — see computeExtraGap's guard note
  measureDoc.end();

  // Fill only up to the BOTTOM margin, not the page edge: pdfkit auto-breaks
  // to a new page the moment y crosses (page.height - margin), so filling to
  // exactly that line reliably pushed the closing rule + disclaimer onto a
  // near-empty page 2 (found in the 2026-07 layout smoke test). The extra
  // PAGE_MARGIN here is the safety band that keeps everything on one page.
  const availableHeight = measureDoc.page.height - PAGE_MARGIN * 2;
  const gapCount = countSectionGaps(draft);
  const extraGap = computeExtraGap(availableHeight, measuredHeight, gapCount, measuredPages);

  // ── Real pass ──
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageWidth = doc.page.width;
  drawSingleColumnHeader(doc, draft, theme, pageWidth, photoBuffer);
  drawSingleColumnBody(doc, draft, theme, pageWidth, extraGap);

  doc.end();
  return done;
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE FAMILY 2 — two-column sidebar layout (structurally different, not
// just a re-theme): contact/skills/languages/bar admissions in a filled
// color sidebar, profile/education/experience/achievements in the main
// column. Same explicit field labels as the single-column family.
// ═══════════════════════════════════════════════════════════════════════════
// Draws the sidebar's content onto ANY doc starting at y=40 and returns the
// final y reached — used twice: once against a disposable measuring doc (to
// find out how tall the sidebar content actually is) and once for real. This
// is what lets the colored sidebar panel hug its actual content instead of
// always stretching to the full page height — a sparse resume no longer
// leaves a large empty colored block that reads as "unfinished".
const drawSidebarContent = (doc, draft, theme, photoBuffer, sbTextX, sidebarX, sidebarWidth) => {
  const { headerFont, bodyFont } = theme;
  const p = draft.personal_info || {};
  let sy = 40;

  if (photoBuffer) {
    const drew = drawCircularPhoto(doc, photoBuffer, sidebarX + sidebarWidth / 2, sy + 38, 38);
    if (drew) sy += 90;
  }
  const sidebarHeading = (title) => {
    doc.fillColor('#ffffff').font(headerFont).fontSize(11).text(title.toUpperCase(), sbTextX, sy, { width: sidebarWidth - 48, characterSpacing: 1 });
    sy = doc.y + 5;
    doc.moveTo(sbTextX, sy).lineTo(sidebarX + sidebarWidth - 24, sy).strokeColor('#ffffff').lineWidth(0.75).stroke();
    sy += 9;
  };
  const sidebarText = (line) => {
    doc.fillColor('#ffffff').font(bodyFont).fontSize(9).text(line, sbTextX, sy, { width: sidebarWidth - 48, lineGap: 1 });
    sy = doc.y + 5;
  };

  doc.fillColor('#ffffff').font(headerFont).fontSize(18).text((p.full_name || 'STUDENT NAME').toUpperCase(), sbTextX, sy, { width: sidebarWidth - 48 });
  sy = doc.y + 4;
  if (p.target_field) { doc.font(bodyFont).fontSize(9).fillColor('#ffffff').text(p.target_field, sbTextX, sy, { width: sidebarWidth - 48 }); sy = doc.y + 16; }

  sidebarHeading('Contact');
  [p.email, p.phone, p.city_country, p.linkedin].filter(Boolean).forEach(sidebarText);
  sy += 7;

  const skills = draft.skills || {};
  const skillLabels = { legal: 'Legal', advocacy: 'Advocacy', research_tools: 'Research Tools', drafting: 'Drafting', software: 'Software', soft_skills: 'Soft Skills' };
  const skillRows = Object.entries(skillLabels).filter(([key]) => (skills[key] || []).length > 0);
  if (skillRows.length > 0) {
    sidebarHeading('Skills');
    // A little extra breathing room between each skill category line — at
    // the default spacing, three stacked "Label: value" lines read as
    // cramped against each other, especially once one wraps to 2 lines.
    skillRows.forEach(([key, label]) => { sidebarText(`${label}: ${skills[key].join(', ')}`); sy += 3; });
    sy += 5;
  }

  if ((draft.certifications || []).length > 0) {
    sidebarHeading('Certifications');
    draft.certifications.forEach(sidebarText);
    sy += 7;
  }

  if ((draft.bar_admissions || []).length > 0) {
    sidebarHeading('Bar Admissions');
    draft.bar_admissions.forEach(sidebarText);
    sy += 7;
  }

  if ((draft.languages || []).length > 0) {
    sidebarHeading('Languages');
    sidebarText(draft.languages.join(', '));
  }

  return sy;
};

// Counts the sidebar template's main-column gap points — Profile/Education/
// Experience/Achievements only (Bar Admissions & Languages live in the
// sidebar for this family, not the main column, so they don't count here).
const countMainColumnGaps = (draft) => {
  let n = 1; // closing rule before the footer disclaimer
  if (draft.profile_summary) n += 1;
  if ((draft.education || []).length > 0) n += 1 + Math.max(0, draft.education.length - 1);
  if ((draft.experience || []).length > 0) n += 1 + Math.max(0, draft.experience.length - 1);
  if ((draft.volunteer || []).length > 0) n += 1 + Math.max(0, draft.volunteer.length - 1);
  if ((draft.achievements || []).length > 0) n += 1;
  return n;
};

// Draws the sidebar template's white main column (Profile → Achievements +
// closing rule/disclaimer) — same measure-then-fill idea as the single
// column family: `extraGap` is 0 on the measuring pass, the computed
// fill amount on the real pass, so a short main column doesn't end a third
// of the way down the page while the sidebar is still full-height.
const drawSidebarMainColumn = (doc, draft, theme, mainX, mainWidth, extraGap) => {
  const { accent, text: textColor, muted, headerFont, bodyFont, italicFont } = theme;
  doc.y = 40;
  const sectionHeader = (title) => {
    doc.moveDown(0.7);
    doc.y += extraGap;
    doc.fillColor(accent).font(headerFont).fontSize(13).text(title.toUpperCase(), mainX, doc.y, { width: mainWidth, characterSpacing: 1.2 });
    const y = doc.y + 2;
    doc.moveTo(mainX, y).lineTo(mainX + mainWidth, y).strokeColor(accent).lineWidth(1).stroke();
    doc.moveDown(0.45);
  };
  const bulletList = (items) => {
    items.filter(Boolean).forEach((item) => {
      doc.font(bodyFont).fontSize(10).fillColor(accent).text('•  ', mainX + 8, doc.y, { width: mainWidth - 8, continued: true });
      doc.fillColor(textColor).text(item, { paragraphGap: 6, lineGap: 2.2 });
    });
  };
  // See the single-column family's entryRow comment for why this needs
  // Math.max: the date is drawn after the (possibly 2-line) title, and
  // pdfkit's doc.y would otherwise snap to the date's shorter height.
  const entryRow = (title, dateRange) => {
    const y = doc.y;
    doc.fillColor(textColor).font(headerFont).fontSize(11).text(title, mainX, y, { width: mainWidth - DATE_COL_W });
    const titleEndY = doc.y;
    if (dateRange) {
      doc.font(bodyFont).fontSize(9).fillColor(muted).text(dateRange, mainX, y + 1, { width: mainWidth, align: 'right', lineBreak: false });
    }
    doc.y = Math.max(titleEndY, doc.y) + 2;
  };

  if (draft.profile_summary) {
    sectionHeader('Profile');
    doc.font(bodyFont).fontSize(10).fillColor(textColor).text(draft.profile_summary, mainX, doc.y, { width: mainWidth, lineGap: 3 });
  }

  // Professional entry style — see the single-column family's note: bold
  // primary line + right-aligned dates + italic subline, no "Label:" prefixes.
  const workEntry = (e) => {
    entryRow([e.role, e.organization].filter(Boolean).join(', ') || '—', e.duration || '');
    if (e.location) doc.font(italicFont).fontSize(9.5).fillColor(textColor).text(e.location, mainX, doc.y, { width: mainWidth, paragraphGap: 4 });
    bulletList(e.bullets || []);
  };

  if ((draft.education || []).length > 0) {
    sectionHeader('Education');
    draft.education.forEach((e, i, arr) => {
      entryRow(e.institution || '—', e.year || '');
      const subline = [e.degree, e.gpa].filter(Boolean).join('   ·   ');
      if (subline) doc.font(italicFont).fontSize(9.5).fillColor(textColor).text(subline, mainX, doc.y, { width: mainWidth, paragraphGap: 4 });
      bulletList([withLabel('Coursework', e.coursework), withLabel('Honors', e.honors)]);
      doc.moveDown(0.45);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }

  if ((draft.experience || []).length > 0) {
    sectionHeader('Experience & Internships');
    draft.experience.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.45);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }

  if ((draft.volunteer || []).length > 0) {
    sectionHeader('Volunteer & Pro Bono');
    draft.volunteer.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.45);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }

  if ((draft.achievements || []).length > 0) {
    sectionHeader('Achievements & Activities');
    bulletList(draft.achievements);
  }

  doc.moveDown(1.1);
  doc.y += extraGap;
  doc.moveTo(mainX, doc.y).lineTo(mainX + mainWidth, doc.y).strokeColor(muted).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.font(italicFont).fontSize(7.5).fillColor(muted).text('For educational purposes only. Verify with a qualified advocate.', mainX, doc.y, { width: mainWidth, align: 'center' });
};

const renderSidebarTemplate = (draft, theme, photoBuffer) => {
  const { accent, sidebarSide = 'left' } = theme;
  const sidebarWidth = 190;

  // ── Measuring pass: draw both the sidebar AND the main column onto
  // disposable docs just to learn how tall each actually is, then throw
  // them away. Nothing from this pass reaches the final PDF.
  const measureDoc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  measureDoc.on('data', () => {}); // discard output — this doc is measurement-only
  const measurePageWidth = measureDoc.page.width;
  const measureSidebarX = sidebarSide === 'right' ? measurePageWidth - sidebarWidth : 0;
  const measuredSy = drawSidebarContent(measureDoc, draft, theme, photoBuffer, measureSidebarX + 24, measureSidebarX, sidebarWidth);
  measureDoc.end();
  // Clamp: never shorter than a tidy minimum, never taller than the page.
  const sidebarHeight = Math.min(measureDoc.page.height, Math.max(360, measuredSy + 30));

  const measureMainDoc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  measureMainDoc.on('data', () => {});
  const measureMainX = sidebarSide === 'right' ? 40 : sidebarWidth + 30;
  const measureMainWidth = sidebarSide === 'right' ? (measurePageWidth - sidebarWidth) - measureMainX - 30 : measurePageWidth - measureMainX - 40;
  drawSidebarMainColumn(measureMainDoc, draft, theme, measureMainX, measureMainWidth, 0);
  const measuredMainHeight = measureMainDoc.y;
  const measuredMainPages = measureMainDoc.bufferedPageRange().count; // read BEFORE end() — see computeExtraGap's guard note
  measureMainDoc.end();
  // Fill the main column at least to the sidebar's height (whichever is
  // taller) so neither column reads as unfinished next to the other.
  const mainAvailableHeight = Math.max(sidebarHeight, measureMainDoc.page.height - 60);
  const mainGapCount = countMainColumnGaps(draft);
  const mainExtraGap = computeExtraGap(mainAvailableHeight, measuredMainHeight, mainGapCount, measuredMainPages);

  // ── Real pass ──
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageWidth = doc.page.width;
  // sidebarSide flips which half of the page is the colored sidebar vs the
  // white main column — this is what makes "Olive Sidebar" a genuinely
  // different layout from "Navy Sidebar" rather than just a re-theme.
  const sidebarX = sidebarSide === 'right' ? pageWidth - sidebarWidth : 0;
  const mainX = sidebarSide === 'right' ? 40 : sidebarWidth + 30;
  const mainWidth = sidebarSide === 'right' ? sidebarX - mainX - 30 : pageWidth - mainX - 40;
  const sbTextX = sidebarX + 24;

  doc.rect(sidebarX, 0, sidebarWidth, sidebarHeight).fill(accent);
  drawSidebarContent(doc, draft, theme, photoBuffer, sbTextX, sidebarX, sidebarWidth);
  drawSidebarMainColumn(doc, draft, theme, mainX, mainWidth, mainExtraGap);

  doc.end();
  return done;
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE FAMILY 3 — "Executive Boxed": photo top-left, name in a bordered
// box top-right, then a two-column body — a narrow left label column
// (section titles) and a wider right content column, divided by a vertical
// rule. Structurally distinct from both families above (labels and content
// never share a horizontal line the way single-column/sidebar do).
// ═══════════════════════════════════════════════════════════════════════════
// Counts the Executive template's row-level gap points — one per top-level
// labeled row (the `row()` helper below is the only thing that adds
// extraGap; per-entry spacing inside a row stays fixed so a 2-entry
// Education section doesn't get a bonus gap the single-entry Profile row
// never sees).
const countExecutiveGaps = (draft) => {
  let n = 1; // final rule before the footer disclaimer
  if (draft.profile_summary) n += 1;
  if ((draft.education || []).length > 0) n += 1;
  const skills = draft.skills || {};
  const skillKeys = ['legal', 'advocacy', 'research_tools', 'drafting', 'software', 'soft_skills'];
  if (skillKeys.some((k) => (skills[k] || []).length > 0)) n += 1;
  if ((draft.experience || []).length > 0) n += 1;
  if ((draft.volunteer || []).length > 0) n += 1;
  if ((draft.achievements || []).length > 0) n += 1;
  if ((draft.certifications || []).length > 0) n += 1;
  if ((draft.bar_admissions || []).length > 0) n += 1;
  if ((draft.languages || []).length > 0) n += 1;
  return n;
};

// Draws the Executive template's label/content body (everything below the
// boxed header) and the vertical divider. `extraGap` is 0 on the measuring
// pass, the computed fill amount on the real pass — same page-fill pattern
// used by every other template family in this file.
const drawExecutiveBody = (doc, draft, theme, contentX, contentWidth, labelColX, labelColWidth, dividerX, bodyStartY, extraGap) => {
  const { accent, text: textColor, muted, headerFont, bodyFont, italicFont } = theme;

  const label = (title) => {
    doc.fillColor(accent).font(headerFont).fontSize(10.5).text(title.toUpperCase(), labelColX, doc.y, { width: labelColWidth, characterSpacing: 0.75 });
  };
  const bulletList = (items) => {
    items.filter(Boolean).forEach((item) => {
      doc.font(bodyFont).fontSize(10).fillColor(accent).text('•  ', contentX + 8, doc.y, { width: contentWidth - 8, continued: true });
      doc.fillColor(textColor).text(item, { paragraphGap: 6, lineGap: 2.2 });
    });
  };
  // See the single-column family's entryRow comment for why this needs
  // Math.max: the date is drawn after the (possibly 2-line) title, and
  // pdfkit's doc.y would otherwise snap to the date's shorter height.
  const entryRow = (title, dateRange) => {
    const y = doc.y;
    doc.fillColor(textColor).font(headerFont).fontSize(11).text(title, contentX, y, { width: contentWidth - DATE_COL_W });
    const titleEndY = doc.y;
    if (dateRange) doc.font(bodyFont).fontSize(9).fillColor(muted).text(dateRange, contentX, y + 1, { width: contentWidth, align: 'right', lineBreak: false });
    doc.y = Math.max(titleEndY, doc.y) + 2;
  };

  // Each labeled row: label drawn in the narrow left column, content in the
  // wide right column, starting at the SAME y — then doc.y advances to
  // whichever column ended up taller before the next row begins. extraGap
  // is added ONCE per row here — entries inside a row use a fixed gap
  // (below) so a 2-entry Education row doesn't get a bonus on top of this.
  const row = (title, renderContent) => {
    const startY = doc.y;
    label(title);
    const labelEndY = doc.y;
    doc.y = startY;
    renderContent();
    const contentEndY = doc.y;
    doc.y = Math.max(labelEndY, contentEndY) + 16 + extraGap;
  };

  if (draft.profile_summary) {
    row('Profile', () => doc.font(bodyFont).fontSize(10).fillColor(textColor).text(draft.profile_summary, contentX, doc.y, { width: contentWidth, lineGap: 3 }));
  }

  // Professional entry style — bold primary line + right-aligned dates +
  // italic subline, no "Label:" prefixes (see single-column family's note).
  const workEntry = (e) => {
    entryRow([e.role, e.organization].filter(Boolean).join(', ') || '—', e.duration || '');
    if (e.location) doc.font(italicFont).fontSize(9.5).fillColor(textColor).text(e.location, contentX, doc.y, { width: contentWidth, paragraphGap: 4 });
    bulletList(e.bullets || []);
    doc.moveDown(0.5);
  };

  if ((draft.education || []).length > 0) {
    row('Education', () => {
      draft.education.forEach((e) => {
        entryRow(e.institution || '—', e.year || '');
        const subline = [e.degree, e.gpa].filter(Boolean).join('   ·   ');
        if (subline) doc.font(italicFont).fontSize(9.5).fillColor(textColor).text(subline, contentX, doc.y, { width: contentWidth, paragraphGap: 4 });
        bulletList([withLabel('Coursework', e.coursework), withLabel('Honors', e.honors)]);
        doc.moveDown(0.5);
      });
    });
  }

  const skills = draft.skills || {};
  const skillLabels = { legal: 'Legal', advocacy: 'Advocacy', research_tools: 'Research Tools', drafting: 'Drafting', software: 'Software', soft_skills: 'Soft Skills' };
  const skillRows = Object.entries(skillLabels).filter(([key]) => (skills[key] || []).length > 0);
  if (skillRows.length > 0) {
    row('Skills', () => {
      skillRows.forEach(([key, skillLabel]) => {
        doc.font(headerFont).fontSize(9.5).fillColor(textColor).text(`${skillLabel}: `, contentX, doc.y, { width: contentWidth, continued: true, paragraphGap: 7 });
        doc.font(bodyFont).fillColor(textColor).text(skills[key].join(', '));
      });
    });
  }

  if ((draft.experience || []).length > 0) {
    row('Experience', () => draft.experience.forEach(workEntry));
  }

  if ((draft.volunteer || []).length > 0) {
    row('Volunteer & Pro Bono', () => draft.volunteer.forEach(workEntry));
  }

  if ((draft.achievements || []).length > 0) {
    row('Achievements', () => bulletList(draft.achievements));
  }

  if ((draft.certifications || []).length > 0) {
    row('Certifications', () => bulletList(draft.certifications));
  }

  if ((draft.bar_admissions || []).length > 0) {
    row('Bar Admissions', () => doc.font(bodyFont).fontSize(9.5).fillColor(textColor).text(draft.bar_admissions.join('  ·  '), contentX, doc.y, { width: contentWidth, lineGap: 3 }));
  }

  if ((draft.languages || []).length > 0) {
    row('Languages', () => doc.font(bodyFont).fontSize(9.5).fillColor(textColor).text(draft.languages.join('  ·  '), contentX, doc.y, { width: contentWidth, lineGap: 3 }));
  }

  // Vertical divider spanning the body content actually rendered.
  doc.moveTo(dividerX, bodyStartY).lineTo(dividerX, doc.y).strokeColor(accent).lineWidth(0.75).stroke();

  doc.moveDown(1.1);
  doc.y += extraGap;
  doc.moveTo(contentX, doc.y).lineTo(contentX + contentWidth, doc.y).strokeColor(muted).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.font(italicFont).fontSize(7.5).fillColor(muted).text('For educational purposes only. Verify with a qualified advocate.', contentX, doc.y, { width: contentWidth, align: 'center' });
};

const renderExecutiveTemplate = (draft, theme, photoBuffer) => {
  const { accent, text: textColor, muted, headerFont, bodyFont } = theme;
  const labelColWidth = 105;
  const dividerOffsetFromMargin = labelColWidth + 15;
  const contentOffsetFromDivider = 15;
  const headerBlockHeight = 68 + 22; // box height + gap before body

  // ── Measuring pass ──
  const measureDoc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  measureDoc.on('data', () => {});
  const measurePageWidth = measureDoc.page.width;
  const measureDividerX = PAGE_MARGIN + dividerOffsetFromMargin;
  const measureContentX = measureDividerX + contentOffsetFromDivider;
  const measureContentWidth = measurePageWidth - measureContentX - PAGE_MARGIN;
  measureDoc.y = PAGE_MARGIN + headerBlockHeight;
  drawExecutiveBody(measureDoc, draft, theme, measureContentX, measureContentWidth, PAGE_MARGIN, labelColWidth, measureDividerX, measureDoc.y, 0);
  const measuredHeight = measureDoc.y;
  const measuredPages = measureDoc.bufferedPageRange().count; // read BEFORE end() — see computeExtraGap's guard note
  measureDoc.end();

  // Fill only up to the BOTTOM margin, not the page edge: pdfkit auto-breaks
  // to a new page the moment y crosses (page.height - margin), so filling to
  // exactly that line reliably pushed the closing rule + disclaimer onto a
  // near-empty page 2 (found in the 2026-07 layout smoke test). The extra
  // PAGE_MARGIN here is the safety band that keeps everything on one page.
  const availableHeight = measureDoc.page.height - PAGE_MARGIN * 2;
  const gapCount = countExecutiveGaps(draft);
  const extraGap = computeExtraGap(availableHeight, measuredHeight, gapCount, measuredPages);

  // ── Real pass ──
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageWidth = doc.page.width;
  const p = draft.personal_info || {};
  const dividerX = PAGE_MARGIN + dividerOffsetFromMargin;
  const contentX = dividerX + contentOffsetFromDivider;
  const contentWidth = pageWidth - contentX - PAGE_MARGIN;

  // Header: photo left, boxed name/title right.
  const hasPhoto = drawCircularPhoto(doc, photoBuffer, PAGE_MARGIN + 32, PAGE_MARGIN + 32, 32);
  const boxX = hasPhoto ? PAGE_MARGIN + 80 : PAGE_MARGIN;
  const boxWidth = pageWidth - boxX - PAGE_MARGIN;
  doc.rect(boxX, PAGE_MARGIN, boxWidth, 68).strokeColor(accent).lineWidth(1.5).stroke();
  doc.fillColor(accent).font(headerFont).fontSize(21).text((p.full_name || 'STUDENT NAME').toUpperCase(), boxX + 14, PAGE_MARGIN + 13, { width: boxWidth - 28 });
  if (p.target_field) doc.font(bodyFont).fontSize(10).fillColor(textColor).text(p.target_field, boxX + 14, doc.y + 3, { width: boxWidth - 28 });
  const contactLine = [p.email, p.phone, p.city_country, p.linkedin].filter(Boolean).join('    |    ');
  if (contactLine) doc.font(bodyFont).fontSize(8.5).fillColor(muted).text(contactLine, boxX + 14, doc.y + 3, { width: boxWidth - 28 });

  doc.y = PAGE_MARGIN + headerBlockHeight;
  const bodyStartY = doc.y;
  drawExecutiveBody(doc, draft, theme, contentX, contentWidth, PAGE_MARGIN, labelColWidth, dividerX, bodyStartY, extraGap);

  doc.end();
  return done;
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE FAMILY 4 — "Charcoal Split": dark full-width header banner with
// photo + name, then a two-column body BELOW the header (not full page
// height like the sidebar family) — a cream-colored left panel for
// Contact/Education/Skills and a white right column for Profile/Experience.
// ═══════════════════════════════════════════════════════════════════════════
// Same measure-then-draw idea as the sidebar family: draws the left cream
// panel's content onto any doc, starting right below the header banner, and
// returns the final y — used once to measure (disposable doc), once for
// real, so the cream panel hugs its actual content instead of always
// stretching to the page bottom on a sparse resume.
const drawLeftPanelContent = (doc, draft, theme, leftWidth, headerHeight) => {
  const { accent, text: textColor, bodyFont, headerFont } = theme;
  const p = draft.personal_info || {};
  let ly = headerHeight + 30;

  const leftHeading = (title) => {
    doc.fillColor(accent).font(headerFont).fontSize(11).text(title.toUpperCase(), 24, ly, { width: leftWidth - 48, characterSpacing: 1 });
    ly = doc.y + 3;
    doc.moveTo(24, ly).lineTo(leftWidth - 24, ly).strokeColor(accent).lineWidth(0.75).stroke();
    ly += 9;
  };
  const leftText = (line) => {
    doc.fillColor(textColor).font(bodyFont).fontSize(9).text(line, 24, ly, { width: leftWidth - 48, lineGap: 1 });
    ly = doc.y + 5;
  };

  leftHeading('Contact');
  [p.email, p.phone, p.city_country, p.linkedin].filter(Boolean).forEach(leftText);
  ly += 7;

  if ((draft.education || []).length > 0) {
    leftHeading('Education');
    draft.education.forEach((e) => {
      leftText(e.institution || '—');
      const subline = [e.degree, e.year].filter(Boolean).join(' · ');
      if (subline) leftText(subline);
      ly += 5;
    });
    ly += 2;
  }

  const skills = draft.skills || {};
  const skillLabels = { legal: 'Legal', advocacy: 'Advocacy', research_tools: 'Research Tools', drafting: 'Drafting', software: 'Software', soft_skills: 'Soft Skills' };
  const skillRows = Object.entries(skillLabels).filter(([key]) => (skills[key] || []).length > 0);
  if (skillRows.length > 0) {
    leftHeading('Skills');
    skillRows.forEach(([key, skillLabel]) => { leftText(`${skillLabel}: ${skills[key].join(', ')}`); ly += 3; });
    ly += 5;
  }

  if ((draft.certifications || []).length > 0) {
    leftHeading('Certifications');
    draft.certifications.forEach(leftText);
    ly += 7;
  }

  if ((draft.bar_admissions || []).length > 0) {
    leftHeading('Bar Admissions');
    draft.bar_admissions.forEach(leftText);
    ly += 7;
  }

  if ((draft.languages || []).length > 0) {
    leftHeading('Languages');
    leftText(draft.languages.join(', '));
  }

  return ly;
};

// Charcoal Split's right column only ever shows Summary/Experience/
// Achievements (everything else lives in the cream left panel).
const countBannerMainGaps = (draft) => {
  let n = 1; // closing rule before the footer disclaimer
  if (draft.profile_summary) n += 1;
  if ((draft.experience || []).length > 0) n += 1 + Math.max(0, draft.experience.length - 1);
  if ((draft.volunteer || []).length > 0) n += 1 + Math.max(0, draft.volunteer.length - 1);
  if ((draft.achievements || []).length > 0) n += 1;
  return n;
};

const drawBannerMainColumn = (doc, draft, theme, mainX, mainWidth, headerHeight, extraGap) => {
  const { accent, text: textColor, muted, headerFont, bodyFont, italicFont } = theme;
  doc.y = headerHeight + 30;
  const sectionHeader = (title) => {
    doc.moveDown(0.6);
    doc.y += extraGap;
    doc.fillColor(accent).font(headerFont).fontSize(13).text(title.toUpperCase(), mainX, doc.y, { width: mainWidth, characterSpacing: 1.2 });
    const y = doc.y + 2;
    doc.moveTo(mainX, y).lineTo(mainX + mainWidth, y).strokeColor(accent).lineWidth(1).stroke();
    doc.moveDown(0.45);
  };
  const bulletList = (items) => {
    items.filter(Boolean).forEach((item) => {
      doc.font(bodyFont).fontSize(10).fillColor(accent).text('•  ', mainX + 8, doc.y, { width: mainWidth - 8, continued: true });
      doc.fillColor(textColor).text(item, { paragraphGap: 6, lineGap: 2.2 });
    });
  };
  // See the single-column family's entryRow comment for why this needs
  // Math.max: the date is drawn after the (possibly 2-line) title, and
  // pdfkit's doc.y would otherwise snap to the date's shorter height.
  const entryRow = (title, dateRange) => {
    const y = doc.y;
    doc.fillColor(textColor).font(headerFont).fontSize(11).text(title, mainX, y, { width: mainWidth - DATE_COL_W });
    const titleEndY = doc.y;
    if (dateRange) doc.font(bodyFont).fontSize(9).fillColor(muted).text(dateRange, mainX, y + 1, { width: mainWidth, align: 'right', lineBreak: false });
    doc.y = Math.max(titleEndY, doc.y) + 2;
  };

  if (draft.profile_summary) {
    sectionHeader('Summary');
    doc.font(bodyFont).fontSize(10).fillColor(textColor).text(draft.profile_summary, mainX, doc.y, { width: mainWidth, lineGap: 3 });
  }

  // Professional entry style — see the single-column family's note.
  const workEntry = (e) => {
    entryRow([e.role, e.organization].filter(Boolean).join(', ') || '—', e.duration || '');
    if (e.location) doc.font(italicFont).fontSize(9.5).fillColor(textColor).text(e.location, mainX, doc.y, { width: mainWidth, paragraphGap: 4 });
    bulletList(e.bullets || []);
  };

  if ((draft.experience || []).length > 0) {
    sectionHeader('Experience');
    draft.experience.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.45);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }

  if ((draft.volunteer || []).length > 0) {
    sectionHeader('Volunteer & Pro Bono');
    draft.volunteer.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.45);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }

  if ((draft.achievements || []).length > 0) {
    sectionHeader('Achievements');
    bulletList(draft.achievements);
  }

  doc.moveDown(1.1);
  doc.y += extraGap;
  doc.moveTo(mainX, doc.y).lineTo(mainX + mainWidth, doc.y).strokeColor(muted).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.font(italicFont).fontSize(7.5).fillColor(muted).text('For educational purposes only. Verify with a qualified advocate.', mainX, doc.y, { width: mainWidth, align: 'center' });
};

const renderBannerSplitTemplate = (draft, theme, photoBuffer) => {
  const { accent, panelBg, headerFont, bodyFont } = theme;
  const headerHeight = 140;
  const leftWidth = 220;

  // ── Measuring pass ──
  const measureDoc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  measureDoc.on('data', () => {});
  const measuredLy = drawLeftPanelContent(measureDoc, draft, theme, leftWidth, headerHeight);
  measureDoc.end();
  const leftPanelHeight = Math.min(measureDoc.page.height, Math.max(headerHeight + 220, measuredLy + 30));

  const measureMainDoc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  measureMainDoc.on('data', () => {});
  const measureMainX = leftWidth + 30;
  const measureMainWidth = measureMainDoc.page.width - measureMainX - 40;
  drawBannerMainColumn(measureMainDoc, draft, theme, measureMainX, measureMainWidth, headerHeight, 0);
  const measuredMainHeight = measureMainDoc.y;
  const measuredMainPages = measureMainDoc.bufferedPageRange().count; // read BEFORE end() — see computeExtraGap's guard note
  measureMainDoc.end();
  const mainAvailableHeight = Math.max(leftPanelHeight, measureMainDoc.page.height - 60);
  const mainGapCount = countBannerMainGaps(draft);
  const mainExtraGap = computeExtraGap(mainAvailableHeight, measuredMainHeight, mainGapCount, measuredMainPages);

  // ── Real pass ──
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageWidth = doc.page.width;
  const mainX = leftWidth + 30;
  const mainWidth = pageWidth - mainX - 40;
  const p = draft.personal_info || {};

  // Header banner
  doc.rect(0, 0, pageWidth, headerHeight).fill(accent);
  const hasPhoto = drawCircularPhoto(doc, photoBuffer, 75, 70, 40);
  const nameX = hasPhoto ? 135 : 40;
  doc.fillColor('#ffffff').font(headerFont).fontSize(26).text(p.full_name || 'STUDENT NAME', nameX, 46, { width: pageWidth - nameX - 40 });
  if (p.target_field) doc.font(bodyFont).fontSize(11.5).fillColor('#ffffff').text(p.target_field, nameX, doc.y + 5, { width: pageWidth - nameX - 40 });

  // Left panel (cream) — Contact / Education / Skills / Bar Admissions / Languages
  doc.rect(0, headerHeight, leftWidth, leftPanelHeight - headerHeight).fill(panelBg);
  drawLeftPanelContent(doc, draft, theme, leftWidth, headerHeight);

  // Right column (white) — Summary / Experience / Achievements
  drawBannerMainColumn(doc, draft, theme, mainX, mainWidth, headerHeight, mainExtraGap);

  doc.end();
  return done;
};

// ── Template family 5-7 shared helper — flatten categorised skills into one
// list of individual skill names (the reference designs these families are
// based on show skills as a flat list with decorative leaders/dashes, not as
// "Category: a, b, c" lines).
const SKILL_ORDER = ['legal', 'advocacy', 'research_tools', 'drafting', 'software', 'soft_skills'];
const flattenSkills = (skills) => {
  const s = skills || {};
  const out = [];
  for (const key of SKILL_ORDER) for (const item of s[key] || []) if (item) out.push(item);
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE FAMILY 5 — "Boxed Monochrome" (based on the classic lawyer
// reference design): light grey header band with circular photo left and the
// name inside a thick-bordered box, a two-column contact strip beneath, then
// a label-column body (section titles left of a vertical divider, content
// right) and skills as dotted-leader rows in two columns. No proficiency
// meters — we don't collect skill levels, and fake precision hurts students
// in interviews.
// ═══════════════════════════════════════════════════════════════════════════
const drawBoxedMonoBody = (doc, draft, theme, labelX, labelW, dividerX, contentX, contentWidth, bodyStartY, extraGap) => {
  const { accent, text: textColor, muted, headerFont, bodyFont, italicFont } = theme;

  const label = (title) => {
    doc.fillColor(textColor).font(headerFont).fontSize(10.5).text(title.toUpperCase(), labelX, doc.y, { width: labelW, characterSpacing: 0.5 });
  };
  const bulletList = (items) => {
    items.filter(Boolean).forEach((item) => {
      doc.font(bodyFont).fontSize(10).fillColor(accent).text('•  ', contentX + 6, doc.y, { width: contentWidth - 6, continued: true });
      doc.fillColor(textColor).text(item, { paragraphGap: 4, lineGap: 1.8 });
    });
  };
  // See the single-column family's entryRow comment for why this needs
  // Math.max: the date is drawn after the (possibly 2-line) title, and
  // pdfkit's doc.y would otherwise snap to the date's shorter height.
  const entryRow = (title, dateRange) => {
    const y = doc.y;
    doc.fillColor(textColor).font(headerFont).fontSize(11).text(title, contentX, y, { width: contentWidth - DATE_COL_W });
    const titleEndY = doc.y;
    if (dateRange) doc.font(bodyFont).fontSize(9).fillColor(muted).text(dateRange, contentX, y + 1, { width: contentWidth, align: 'right', lineBreak: false });
    doc.y = Math.max(titleEndY, doc.y) + 2;
  };
  const workEntry = (e) => {
    entryRow([e.role, e.organization].filter(Boolean).join(', ') || '—', e.duration || '');
    if (e.location) doc.font(italicFont).fontSize(9.5).fillColor(textColor).text(e.location, contentX, doc.y, { width: contentWidth, paragraphGap: 4 });
    bulletList(e.bullets || []);
    doc.moveDown(0.4);
  };
  const row = (title, renderContent) => {
    const startY = doc.y;
    label(title);
    const labelEndY = doc.y;
    doc.y = startY;
    renderContent();
    doc.y = Math.max(labelEndY, doc.y) + 14 + extraGap;
  };

  if (draft.profile_summary) {
    row('Objective', () => doc.font(bodyFont).fontSize(10).fillColor(textColor).text(draft.profile_summary, contentX, doc.y, { width: contentWidth, lineGap: 3 }));
  }
  if ((draft.experience || []).length > 0) {
    row('Experience', () => draft.experience.forEach(workEntry));
  }
  if ((draft.volunteer || []).length > 0) {
    row('Volunteer & Pro Bono', () => draft.volunteer.forEach(workEntry));
  }
  if ((draft.education || []).length > 0) {
    row('Education', () => {
      draft.education.forEach((e) => {
        entryRow(e.institution || '—', e.year || '');
        const subline = [e.degree, e.gpa].filter(Boolean).join('   ·   ');
        if (subline) doc.font(italicFont).fontSize(9.5).fillColor(textColor).text(subline, contentX, doc.y, { width: contentWidth, paragraphGap: 4 });
        bulletList([withLabel('Coursework', e.coursework), withLabel('Honors', e.honors)]);
        doc.moveDown(0.4);
      });
    });
  }
  const flatSkills = flattenSkills(draft.skills);
  if (flatSkills.length > 0) {
    row('Skills', () => {
      // Two-column dotted-leader rows (the reference design's signature look,
      // minus the fake proficiency dots). Manual y tracking — pdfkit has no
      // native multi-column flow.
      const colGap = 24;
      const colW = (contentWidth - colGap) / 2;
      const rowH = 16;
      const startY = doc.y;
      flatSkills.slice(0, 16).forEach((name, i) => {
        const col = i % 2;
        const x = contentX + col * (colW + colGap);
        const y = startY + Math.floor(i / 2) * rowH;
        doc.font(bodyFont).fontSize(9.5).fillColor(textColor).text(name, x, y, { lineBreak: false });
        const nameW = Math.min(doc.widthOfString(name), colW - 30);
        doc.save();
        doc.dash(1.2, { space: 2.4 });
        doc.moveTo(x + nameW + 8, y + 7).lineTo(x + colW, y + 7).strokeColor(muted).lineWidth(1).stroke();
        doc.restore();
        doc.undash();
      });
      doc.y = startY + Math.ceil(Math.min(flatSkills.length, 16) / 2) * rowH;
    });
  }
  if ((draft.achievements || []).length > 0) {
    row('Achievements', () => bulletList(draft.achievements));
  }
  if ((draft.certifications || []).length > 0) {
    row('Certifications', () => bulletList(draft.certifications));
  }
  if ((draft.bar_admissions || []).length > 0) {
    row('Bar Admissions', () => doc.font(bodyFont).fontSize(9.5).fillColor(textColor).text(draft.bar_admissions.join('  ·  '), contentX, doc.y, { width: contentWidth, lineGap: 3 }));
  }
  if ((draft.languages || []).length > 0) {
    row('Languages', () => doc.font(bodyFont).fontSize(9.5).fillColor(textColor).text(draft.languages.join('  ·  '), contentX, doc.y, { width: contentWidth, lineGap: 3 }));
  }

  // Vertical divider spanning the rendered body.
  doc.moveTo(dividerX, bodyStartY - 6).lineTo(dividerX, doc.y - 10 - extraGap).strokeColor(textColor).lineWidth(1).stroke();

  doc.moveTo(labelX, doc.y).lineTo(contentX + contentWidth, doc.y).strokeColor(muted).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.font(italicFont).fontSize(7.5).fillColor(muted).text('For educational purposes only. Verify with a qualified advocate.', labelX, doc.y, { width: contentX + contentWidth - labelX, align: 'center' });
};

const countBoxedMonoGaps = (draft) => {
  let n = 0;
  if (draft.profile_summary) n += 1;
  if ((draft.experience || []).length > 0) n += 1;
  if ((draft.volunteer || []).length > 0) n += 1;
  if ((draft.education || []).length > 0) n += 1;
  if (flattenSkills(draft.skills).length > 0) n += 1;
  if ((draft.achievements || []).length > 0) n += 1;
  if ((draft.certifications || []).length > 0) n += 1;
  if ((draft.bar_admissions || []).length > 0) n += 1;
  if ((draft.languages || []).length > 0) n += 1;
  return n;
};

const renderBoxedMonoTemplate = (draft, theme, photoBuffer) => {
  const { accent, text: textColor, muted, headerFont, bodyFont } = theme;
  const bandHeight = 118;
  const labelX = PAGE_MARGIN;
  // 100 -> 112 and characterSpacing 1 -> 0.5 in the label() helper: at the
  // old metrics the single word CERTIFICATIONS measured ~105pt and pdfkit
  // broke it MID-WORD across two lines ('CERTIFICATION / S'). Multi-word
  // labels (VOLUNTEER & PRO BONO) may still wrap — at spaces only, fine.
  const labelW = 112;
  const dividerX = PAGE_MARGIN + labelW + 12;
  const contentX = dividerX + 16;

  const drawHeader = (doc, withPhoto) => {
    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - contentX - PAGE_MARGIN;
    // Light grey band + photo + thick-bordered name box — the reference
    // design's signature header.
    doc.rect(0, 0, pageWidth, bandHeight).fill('#ececec');
    const hasPhoto = withPhoto ? drawCircularPhoto(doc, withPhoto, 88, bandHeight / 2, 40) : false;
    const boxX = hasPhoto ? 152 : PAGE_MARGIN;
    const boxW = pageWidth - boxX - PAGE_MARGIN;
    doc.rect(boxX, 24, boxW, 62).lineWidth(3).strokeColor(textColor).stroke();
    const p = draft.personal_info || {};
    doc.fillColor(textColor).font(headerFont).fontSize(22).text((p.full_name || 'STUDENT NAME').toUpperCase(), boxX + 16, 38, { width: boxW - 32, characterSpacing: 1 });
    if (p.target_field) doc.font(bodyFont).fontSize(10).fillColor(textColor).text(p.target_field.toUpperCase(), boxX + 16, doc.y + 2, { width: boxW - 32, characterSpacing: 1.5 });
    // Two-column contact strip under the band.
    let cy = bandHeight + 12;
    const half = (pageWidth - PAGE_MARGIN * 2) / 2;
    const contactCell = (txt, col) => {
      if (!txt) return;
      const x = PAGE_MARGIN + col * half;
      doc.circle(x + 3, cy + 4, 2.5).fill(accent);
      doc.fillColor(textColor).font(bodyFont).fontSize(9).text(txt, x + 12, cy, { width: half - 24, lineBreak: false });
      if (col === 1) cy += 14;
    };
    contactCell(p.phone, 0); contactCell(p.email, 1);
    contactCell(p.city_country, 0); contactCell(p.linkedin, 1);
    cy += 8;
    doc.moveTo(PAGE_MARGIN, cy).lineTo(pageWidth - PAGE_MARGIN, cy).strokeColor(textColor).lineWidth(1.5).stroke();
    doc.y = cy + 18;
    return { contentWidth };
  };

  // ── Measuring pass ──
  const measureDoc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  measureDoc.on('data', () => {});
  const { contentWidth: mCW } = drawHeader(measureDoc, null);
  drawBoxedMonoBody(measureDoc, draft, theme, labelX, labelW, dividerX, contentX, mCW, measureDoc.y, 0);
  const measuredHeight = measureDoc.y;
  const measuredPages = measureDoc.bufferedPageRange().count; // read BEFORE end() — see computeExtraGap's guard note
  measureDoc.end();
  const availableHeight = measureDoc.page.height - PAGE_MARGIN * 2;
  const extraGap = computeExtraGap(availableHeight, measuredHeight, countBoxedMonoGaps(draft), measuredPages);

  // ── Real pass ──
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const { contentWidth } = drawHeader(doc, photoBuffer);
  drawBoxedMonoBody(doc, draft, theme, labelX, labelW, dividerX, contentX, contentWidth, doc.y, extraGap);
  doc.end();
  return done;
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE FAMILY 6 — "Olive Professional" (based on the olive right-sidebar
// reference design): white main column with photo + big name top-left,
// icon-dot section headings with light dividers, numbered experience
// bullets; full-height olive sidebar on the right carrying contact, skills
// (with decorative dash accents — NOT proficiency meters), certifications,
// bar admissions and languages in white text.
// ═══════════════════════════════════════════════════════════════════════════
const countOliveMainGaps = (draft) => {
  let n = 1;
  if (draft.profile_summary) n += 1;
  if ((draft.experience || []).length > 0) n += 1 + Math.max(0, draft.experience.length - 1);
  if ((draft.volunteer || []).length > 0) n += 1 + Math.max(0, draft.volunteer.length - 1);
  if ((draft.education || []).length > 0) n += 1;
  if ((draft.achievements || []).length > 0) n += 1;
  return n;
};

const drawOliveMain = (doc, draft, theme, mainX, mainWidth, photoBuffer, extraGap) => {
  const { accent, text: textColor, muted, headerFont, bodyFont, italicFont } = theme;
  const p = draft.personal_info || {};

  // Identity block: photo left, name + role right.
  const hasPhoto = drawCircularPhoto(doc, photoBuffer, mainX + 30, 74, 30);
  const nameX = hasPhoto ? mainX + 74 : mainX;
  doc.fillColor(textColor).font(headerFont).fontSize(25).text((p.full_name || 'STUDENT NAME').toUpperCase(), nameX, 52, { width: mainX + mainWidth - nameX, characterSpacing: 0.5 });
  if (p.target_field) doc.font(headerFont).fontSize(11).fillColor(accent).text(p.target_field, nameX, doc.y + 3, { width: mainX + mainWidth - nameX });
  doc.y = Math.max(doc.y, 118) + 14;

  const sectionHeader = (title) => {
    doc.moveDown(0.5);
    doc.y += extraGap;
    const y = doc.y;
    doc.circle(mainX + 7, y + 6, 7).fill(accent);
    doc.fillColor(textColor).font(headerFont).fontSize(13.5).text(title.toUpperCase(), mainX + 22, y, { width: mainWidth - 22, characterSpacing: 0.5 });
    doc.moveDown(0.4);
  };
  const sectionDivider = () => {
    doc.moveDown(0.5);
    doc.moveTo(mainX, doc.y).lineTo(mainX + mainWidth, doc.y).strokeColor('#d8d8d8').lineWidth(0.75).stroke();
    doc.moveDown(0.2);
  };
  // Numbered bullets — the reference design numbers its experience points.
  const numberedList = (items) => {
    items.filter(Boolean).forEach((item, i) => {
      doc.font(bodyFont).fontSize(10).fillColor(textColor).text(`${i + 1}.  `, mainX + 4, doc.y, { width: mainWidth - 4, continued: true });
      doc.text(item, { paragraphGap: 4, lineGap: 1.8 });
    });
  };
  // See the single-column family's entryRow comment for the doc.y
  // Math.max fix — the same date-drawn-after-title cursor bug applies here,
  // twice per entry (role/duration, then organization/location).
  const workEntry = (e) => {
    const y = doc.y;
    doc.fillColor(textColor).font(headerFont).fontSize(11.5).text(e.role || '—', mainX, y, { width: mainWidth - DATE_COL_W });
    const roleEndY = doc.y;
    if (e.duration) doc.font(bodyFont).fontSize(9).fillColor(muted).text(e.duration, mainX, y + 1, { width: mainWidth, align: 'right', lineBreak: false });
    const orgY = Math.max(roleEndY, doc.y);
    doc.y = orgY;
    if (e.organization) doc.font(headerFont).fontSize(10).fillColor(accent).text(e.organization, mainX, orgY, { width: mainWidth - DATE_COL_W });
    const orgEndY = doc.y;
    if (e.location) doc.font(bodyFont).fontSize(9).fillColor(muted).text(e.location, mainX, orgY + 1, { width: mainWidth, align: 'right', lineBreak: false });
    doc.y = Math.max(orgEndY, doc.y);
    doc.moveDown(0.25);
    numberedList(e.bullets || []);
  };

  if (draft.profile_summary) {
    sectionHeader('Professional Summary');
    doc.font(bodyFont).fontSize(10).fillColor(textColor).text(draft.profile_summary, mainX, doc.y, { width: mainWidth, lineGap: 3 });
    sectionDivider();
  }
  if ((draft.experience || []).length > 0) {
    sectionHeader('Work Experience');
    draft.experience.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.5);
      if (i < arr.length - 1) doc.y += extraGap;
    });
    sectionDivider();
  }
  if ((draft.volunteer || []).length > 0) {
    sectionHeader('Volunteer & Pro Bono');
    draft.volunteer.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.5);
      if (i < arr.length - 1) doc.y += extraGap;
    });
    sectionDivider();
  }
  if ((draft.education || []).length > 0) {
    sectionHeader('Education');
    draft.education.forEach((e) => {
      const y = doc.y;
      doc.fillColor(textColor).font(headerFont).fontSize(11.5).text(e.degree || e.institution || '—', mainX, y, { width: mainWidth - DATE_COL_W });
      const degEndY = doc.y;
      if (e.year) doc.font(bodyFont).fontSize(9).fillColor(muted).text(e.year, mainX, y + 1, { width: mainWidth, align: 'right', lineBreak: false });
      doc.y = Math.max(degEndY, doc.y);
      if (e.degree && e.institution) doc.font(headerFont).fontSize(10).fillColor(accent).text(e.institution, mainX, doc.y, { width: mainWidth });
      const detail = [e.gpa, e.coursework ? `Coursework: ${e.coursework}` : '', e.honors ? `Honors: ${e.honors}` : ''].filter(Boolean).join('  ·  ');
      if (detail) doc.font(bodyFont).fontSize(9.5).fillColor(textColor).text(detail, mainX, doc.y + 2, { width: mainWidth, lineGap: 2 });
      doc.moveDown(0.5);
    });
    sectionDivider();
  }
  if ((draft.achievements || []).length > 0) {
    sectionHeader('Achievements');
    numberedList(draft.achievements);
  }

  doc.moveDown(1);
  doc.y += extraGap;
  doc.font(italicFont).fontSize(7.5).fillColor(muted).text('For educational purposes only. Verify with a qualified advocate.', mainX, doc.y, { width: mainWidth, align: 'center' });
};

const renderOliveProTemplate = (draft, theme, photoBuffer) => {
  const { accent } = theme;
  const sidebarWidth = 185;

  const drawSidebar = (doc) => {
    const pageWidth = doc.page.width;
    const sx = pageWidth - sidebarWidth;
    const tx = sx + 22;
    const tw = sidebarWidth - 44;
    doc.rect(sx, 0, sidebarWidth, doc.page.height).fill(accent);
    let sy = 48;
    const p = draft.personal_info || {};
    const sideText = (line, size = 9) => {
      if (!line) return;
      doc.fillColor('#ffffff').font(theme.bodyFont).fontSize(size).text(line, tx, sy, { width: tw, lineGap: 1.5 });
      sy = doc.y + 6;
    };
    const sideHeading = (title) => {
      sy += 8;
      doc.circle(tx + 6, sy + 6, 6).fill('#ffffff');
      doc.fillColor('#ffffff').font(theme.headerFont).fontSize(12).text(title.toUpperCase(), tx + 19, sy, { width: tw - 19, characterSpacing: 0.5 });
      sy = doc.y + 8;
    };
    const sideRule = () => {
      sy += 4;
      doc.moveTo(tx, sy).lineTo(tx + tw, sy).strokeColor('rgba(255,255,255,0.5)').lineWidth(0.6).stroke();
      sy += 10;
    };
    [p.email, p.phone, p.city_country, p.linkedin].filter(Boolean).forEach((l) => sideText(l, 9.5));
    sideRule();
    const flatSkills = flattenSkills(draft.skills);
    if (flatSkills.length > 0) {
      sideHeading('Skills');
      flatSkills.slice(0, 12).forEach((name) => {
        doc.fillColor('#ffffff').font(theme.bodyFont).fontSize(9.5).text(name, tx, sy, { width: tw });
        sy = doc.y + 4;
        // Decorative dash accent under each skill — echoes the reference
        // design's meter look WITHOUT claiming a proficiency level.
        doc.save();
        doc.dash(9, { space: 4 });
        doc.moveTo(tx, sy).lineTo(tx + tw, sy).strokeColor('rgba(255,255,255,0.85)').lineWidth(2.5).stroke();
        doc.restore();
        doc.undash();
        sy += 12;
      });
      sideRule();
    }
    if ((draft.certifications || []).length > 0) {
      sideHeading('Certifications');
      draft.certifications.forEach((c) => sideText(c));
      sideRule();
    }
    if ((draft.bar_admissions || []).length > 0) {
      sideHeading('Bar Admissions');
      draft.bar_admissions.forEach((b) => sideText(b));
      sideRule();
    }
    if ((draft.languages || []).length > 0) {
      sideHeading('Languages');
      sideText(draft.languages.join(', '));
    }
  };

  const mainX = 46;
  // ── Measuring pass (main column) ──
  const measureDoc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  measureDoc.on('data', () => {});
  const mainWidth = measureDoc.page.width - sidebarWidth - mainX - 26;
  drawOliveMain(measureDoc, draft, theme, mainX, mainWidth, null, 0);
  const measuredHeight = measureDoc.y;
  const measuredPages = measureDoc.bufferedPageRange().count; // read BEFORE end() — see computeExtraGap's guard note
  measureDoc.end();
  const extraGap = computeExtraGap(measureDoc.page.height - 60, measuredHeight, countOliveMainGaps(draft), measuredPages);

  // ── Real pass ──
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  drawSidebar(doc);
  drawOliveMain(doc, draft, theme, mainX, mainWidth, photoBuffer, extraGap);
  doc.end();
  return done;
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE FAMILY 7 — "Slate Chevron" (based on the dark-header reference
// design): full-width slate header with the circular photo over the left
// column and a chevron notch pointing down beneath it, cream left column
// (contact / education / skills / certifications / languages), white right
// column with underlined section headings (Summary / Work Experience / ...).
// ═══════════════════════════════════════════════════════════════════════════
const drawSlateRightColumn = (doc, draft, theme, mainX, mainWidth, startY, extraGap) => {
  const { text: textColor, muted, headerFont, bodyFont, italicFont } = theme;
  doc.y = startY;

  const sectionHeader = (title) => {
    doc.moveDown(0.7);
    doc.y += extraGap;
    doc.fillColor(textColor).font(headerFont).fontSize(15).text(title, mainX, doc.y, { width: mainWidth });
    const y = doc.y + 3;
    doc.moveTo(mainX, y).lineTo(mainX + mainWidth, y).strokeColor(textColor).lineWidth(1).stroke();
    doc.moveDown(0.55);
  };
  const bulletList = (items) => {
    items.filter(Boolean).forEach((item) => {
      doc.font(bodyFont).fontSize(10).fillColor(textColor).text('•  ', mainX + 10, doc.y, { width: mainWidth - 10, continued: true });
      doc.text(item, { paragraphGap: 5, lineGap: 2.2 });
    });
  };
  const workEntry = (e) => {
    doc.fillColor(textColor).font(headerFont).fontSize(11.5).text([e.role, e.organization].filter(Boolean).join(', ') || '—', mainX, doc.y, { width: mainWidth });
    const meta = [e.duration, e.location].filter(Boolean).join('  ·  ');
    if (meta) doc.font(bodyFont).fontSize(9.5).fillColor(muted).text(meta, mainX, doc.y + 1, { width: mainWidth });
    doc.moveDown(0.2);
    bulletList(e.bullets || []);
  };

  if (draft.profile_summary) {
    sectionHeader('Summary');
    doc.font(bodyFont).fontSize(10.5).fillColor(textColor).text(draft.profile_summary, mainX, doc.y, { width: mainWidth, lineGap: 3.5 });
  }
  if ((draft.experience || []).length > 0) {
    sectionHeader('Work Experience');
    draft.experience.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.5);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }
  if ((draft.volunteer || []).length > 0) {
    sectionHeader('Volunteer & Pro Bono');
    draft.volunteer.forEach((e, i, arr) => {
      workEntry(e);
      doc.moveDown(0.5);
      if (i < arr.length - 1) doc.y += extraGap;
    });
  }
  if ((draft.achievements || []).length > 0) {
    sectionHeader('Achievements');
    bulletList(draft.achievements);
  }

  doc.moveDown(1);
  doc.y += extraGap;
  doc.font(italicFont).fontSize(7.5).fillColor(muted).text('For educational purposes only. Verify with a qualified advocate.', mainX, doc.y, { width: mainWidth, align: 'center' });
};

const drawSlateLeftColumn = (doc, draft, theme, leftWidth, startY) => {
  const { text: textColor, bodyFont, headerFont } = theme;
  const tx = 26;
  const tw = leftWidth - 52;
  let ly = startY;
  const p = draft.personal_info || {};

  const heading = (title) => {
    ly += 10;
    doc.fillColor(textColor).font(headerFont).fontSize(13).text(title, tx, ly, { width: tw });
    ly = doc.y + 8;
  };
  const line = (txt, size = 9.5) => {
    if (!txt) return;
    doc.fillColor('#4a4a4a').font(bodyFont).fontSize(size).text(txt, tx, ly, { width: tw, lineGap: 1.5 });
    ly = doc.y + 6;
  };

  heading('Contact Details');
  [p.email, p.phone, p.city_country, p.linkedin].filter(Boolean).forEach((l) => line(l));

  if ((draft.education || []).length > 0) {
    heading('Education');
    draft.education.forEach((e) => {
      doc.circle(tx + 2.5, ly + 4, 2.5).fill(textColor);
      doc.fillColor(textColor).font(headerFont).fontSize(10).text(e.degree || '—', tx + 12, ly, { width: tw - 12 });
      ly = doc.y + 2;
      // Thin vertical rule beside the detail lines — the reference design's
      // timeline-style education entry.
      const railTop = ly;
      if (e.institution) { doc.fillColor('#4a4a4a').font(bodyFont).fontSize(9.5).text(e.institution, tx + 12, ly, { width: tw - 12 }); ly = doc.y + 2; }
      if (e.year) { doc.fillColor('#4a4a4a').font(bodyFont).fontSize(9.5).text(e.year, tx + 12, ly, { width: tw - 12 }); ly = doc.y + 2; }
      if (e.gpa) { doc.fillColor('#4a4a4a').font(bodyFont).fontSize(9.5).text(e.gpa, tx + 12, ly, { width: tw - 12 }); ly = doc.y + 2; }
      doc.moveTo(tx + 2.5, railTop).lineTo(tx + 2.5, ly - 2).strokeColor(textColor).lineWidth(1).stroke();
      ly += 6;
    });
  }

  const flatSkills = flattenSkills(draft.skills);
  if (flatSkills.length > 0) {
    heading('Skills');
    flatSkills.slice(0, 14).forEach((s) => line(s));
  }
  if ((draft.certifications || []).length > 0) {
    heading('Certifications');
    draft.certifications.forEach((c) => line(c));
  }
  if ((draft.bar_admissions || []).length > 0) {
    heading('Bar Admissions');
    draft.bar_admissions.forEach((b) => line(b));
  }
  if ((draft.languages || []).length > 0) {
    heading('Languages');
    line(draft.languages.join(', '));
  }
};

const renderSlateChevronTemplate = (draft, theme, photoBuffer) => {
  const { accent, panelBg, headerFont, bodyFont } = theme;
  const leftWidth = 205;
  const headerHeight = 130;
  const chevronDrop = 45;
  const bodyStartY = headerHeight + chevronDrop + 24;

  // ── Measuring pass (right column) ──
  const measureDoc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  measureDoc.on('data', () => {});
  const mainX = leftWidth + 34;
  const mainWidth = measureDoc.page.width - mainX - 42;
  drawSlateRightColumn(measureDoc, draft, theme, mainX, mainWidth, headerHeight + 30, 0);
  const measuredHeight = measureDoc.y;
  const measuredPages = measureDoc.bufferedPageRange().count; // read BEFORE end() — see computeExtraGap's guard note
  measureDoc.end();
  const extraGap = computeExtraGap(measureDoc.page.height - 60, measuredHeight, countBannerMainGaps(draft), measuredPages);

  // ── Real pass ──
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const pageWidth = doc.page.width;
  const p = draft.personal_info || {};

  // Cream left column, full height.
  doc.rect(0, 0, leftWidth, doc.page.height).fill(panelBg);
  // Slate header band across the full width, with a chevron notch dropping
  // below it under the left column — the reference design's signature shape.
  doc.rect(0, 0, pageWidth, headerHeight).fill(accent);
  doc.moveTo(0, headerHeight).lineTo(leftWidth, headerHeight).lineTo(leftWidth / 2, headerHeight + chevronDrop).closePath().fill(accent);

  drawCircularPhoto(doc, photoBuffer, leftWidth / 2, 78, 44);
  doc.fillColor('#ffffff').font(headerFont).fontSize(27).text(p.full_name || 'Student Name', leftWidth + 34, 42, { width: pageWidth - leftWidth - 76 });
  if (p.target_field) doc.font(bodyFont).fontSize(12).fillColor('#e8e8e8').text(p.target_field, leftWidth + 34, doc.y + 4, { width: pageWidth - leftWidth - 76 });

  drawSlateLeftColumn(doc, draft, theme, leftWidth, bodyStartY);
  drawSlateRightColumn(doc, draft, theme, mainX, mainWidth, headerHeight + 30, extraGap);
  doc.end();
  return done;
};

// ── Template registry — the whitelist the controller validates template_id
// against, and what the frontend's picker is built from ─────────────────────
const TEMPLATES = {
  law_resume_v1: {
    label: 'Classic Maroon',
    render: (draft, photoBuffer) => renderSingleColumnTemplate(draft, {
      accent: '#7B1E3A', text: '#1a1a1a', muted: '#6b6b6b',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
      nameAlign: 'left', banner: false, ruleWeight: 1,
    }, photoBuffer),
  },
  charcoal_modern: {
    label: 'Charcoal Modern',
    render: (draft, photoBuffer) => renderSingleColumnTemplate(draft, {
      accent: '#2b2b2b', text: '#1a1a1a', muted: '#7a7a7a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
      nameAlign: 'left', banner: false, ruleWeight: 0.75,
    }, photoBuffer),
  },
  monochrome_minimal: {
    label: 'Monochrome Minimal',
    render: (draft, photoBuffer) => renderSingleColumnTemplate(draft, {
      accent: '#000000', text: '#222222', muted: '#8a8a8a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
      nameAlign: 'center', banner: false, ruleWeight: 0.5,
    }, photoBuffer),
  },
  emerald_classic: {
    label: 'Emerald Classic',
    render: (draft, photoBuffer) => renderSingleColumnTemplate(draft, {
      accent: '#1B4332', text: '#1a1a1a', muted: '#6b6b6b',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
      nameAlign: 'center', banner: false, ruleWeight: 1,
    }, photoBuffer),
  },
  bold_banner: {
    label: 'Bold Banner',
    render: (draft, photoBuffer) => renderSingleColumnTemplate(draft, {
      accent: '#1B263B', text: '#1a1a1a', muted: '#6b6b6b',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
      nameAlign: 'left', banner: true, ruleWeight: 1,
    }, photoBuffer),
  },
  navy_sidebar: {
    label: 'Navy Sidebar',
    render: (draft, photoBuffer) => renderSidebarTemplate(draft, {
      accent: '#1B263B', text: '#1a1a1a', muted: '#7a7a7a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
      sidebarSide: 'left',
    }, photoBuffer),
  },
  // ── Photo-anchored templates (founder request, matching reference designs) ──
  executive_boxed: {
    label: 'Executive Boxed',
    render: (draft, photoBuffer) => renderExecutiveTemplate(draft, {
      accent: '#1a1a1a', text: '#242424', muted: '#7a7a7a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
    }, photoBuffer),
  },
  olive_sidebar: {
    label: 'Olive Sidebar',
    render: (draft, photoBuffer) => renderSidebarTemplate(draft, {
      accent: '#6B7A3A', text: '#1a1a1a', muted: '#7a7a7a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
      sidebarSide: 'right',
    }, photoBuffer),
  },
  charcoal_split: {
    label: 'Charcoal Split',
    render: (draft, photoBuffer) => renderBannerSplitTemplate(draft, {
      accent: '#2b2b2b', panelBg: '#f0e6dc', text: '#242424', muted: '#7a7a7a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
    }, photoBuffer),
  },
  // ── Reference-design templates (founder request, 2026-07-21): faithful
  // recreations of three approved reference layouts — structure, geometry and
  // palette matched; third-party branding and fake proficiency meters
  // deliberately NOT reproduced. ──
  boxed_monochrome: {
    label: 'Boxed Monochrome',
    render: (draft, photoBuffer) => renderBoxedMonoTemplate(draft, {
      accent: '#1a1a1a', text: '#1a1a1a', muted: '#8a8a8a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
    }, photoBuffer),
  },
  olive_pro: {
    label: 'Olive Professional',
    render: (draft, photoBuffer) => renderOliveProTemplate(draft, {
      accent: '#77803B', text: '#2b2b2b', muted: '#8a8a8a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
    }, photoBuffer),
  },
  slate_chevron: {
    label: 'Slate Chevron',
    render: (draft, photoBuffer) => renderSlateChevronTemplate(draft, {
      accent: '#3B3B3B', panelBg: '#EFE9E1', text: '#2b2b2b', muted: '#8a8a8a',
      headerFont: 'Helvetica-Bold', bodyFont: 'Helvetica', italicFont: 'Helvetica-Oblique',
    }, photoBuffer),
  },
};
const TEMPLATE_IDS = Object.keys(TEMPLATES);
// Fail loudly at startup if this file's render registry and the shared
// controller-facing whitelist ever drift apart, instead of silently
// falling back to the default template for an id the controller thinks is valid.
const missingRenderers = KNOWN_TEMPLATE_IDS.filter((id) => !TEMPLATE_IDS.includes(id));
if (missingRenderers.length > 0) {
  throw new Error(`resumeTemplates.js lists template id(s) with no renderer in resumeBuilder.worker.js: ${missingRenderers.join(', ')}`);
}

const renderResumePDF = (draft, templateId, photoBuffer) => {
  const template = TEMPLATES[templateId] || TEMPLATES[DEFAULT_TEMPLATE_ID];
  return template.render(draft, photoBuffer);
};

// Downloads the student's uploaded photo from S3, if they uploaded one.
// photo_key is written into personal_info by the frontend right after a
// direct client→S3 PUT (see resumeBuilder.controller.js's getPhotoUploadUrl
// and the project's "PDF/file uploads go client → S3 directly" rule — the
// photo follows that same pattern). A missing/corrupt/deleted photo must
// NEVER fail the whole resume build — worst case, the resume just renders
// without a photo.
const fetchPhotoBuffer = async (photoKey) => {
  if (!photoKey) return null;
  try {
    const obj = await s3.getObject({ Bucket: process.env.S3_BUCKET_FILES, Key: photoKey }).promise();
    return obj.Body;
  } catch (_) {
    return null;
  }
};

// ── Step 4/5/6: upload, persist, log ──────────────────────────────────────────
const processBuild = async (job) => {
  const { doc_id, user_id, college_id, draft, template_id } = job.data;
  const templateId = TEMPLATE_IDS.includes(template_id) ? template_id : DEFAULT_TEMPLATE_ID;

  const { polished, tokensIn, tokensOut } = await polishWithGemini(draft);

  const finalData = {
    ...draft,
    profile_summary: polished.profile_summary || draft.profile_summary,
    experience: (draft.experience || []).map((e, i) => ({
      ...e,
      bullets: polished.experience_bullets?.[i]?.bullets || e.bullets || [],
    })),
    volunteer: (draft.volunteer || []).map((e, i) => ({
      ...e,
      bullets: polished.volunteer_bullets?.[i]?.bullets || e.bullets || [],
    })),
    achievements: polished.achievements?.length ? polished.achievements : draft.achievements,
  };

  // SECURITY (college_id isolation): photo_key is client-supplied — it arrives
  // in the draft the frontend saved, so a crafted /draft body could point it at
  // ANY object in the bucket, including another student's/another college's
  // photo. getPhotoUploadUrl only ever issues keys under this exact prefix, so
  // we refuse to fetch anything outside it. A mismatched/absent key simply
  // renders the resume with no photo (fetchPhotoBuffer already treats null that
  // way) rather than leaking a cross-college object. Prefix uses the trusted
  // college_id/user_id from job.data (set server-side at enqueue), never the draft.
  const requestedPhotoKey = draft.personal_info?.photo_key;
  const allowedPhotoPrefix = `resume-photos/${college_id}/${user_id}/`;
  const safePhotoKey =
    typeof requestedPhotoKey === 'string' && requestedPhotoKey.startsWith(allowedPhotoPrefix)
      ? requestedPhotoKey
      : null;
  const photoBuffer = await fetchPhotoBuffer(safePhotoKey);
  const pdfBuffer = await renderResumePDF(finalData, templateId, photoBuffer);

  const s3Key = `resumes/${college_id}/${user_id}/${doc_id}.pdf`;
  await s3.upload({
    Bucket: process.env.S3_BUCKET_FILES,
    Key: s3Key,
    Body: pdfBuffer,
    ContentType: 'application/pdf',
  }).promise();

  // documents insert stays on the critical path deliberately — without this
  // row the student has no way to retrieve the PDF that was just uploaded to
  // S3, so a failure here correctly fails the job.
  await pool.query(
    `INSERT INTO documents (doc_id, user_id, college_id, feature_name, template_type, s3_key, analysis_json)
     VALUES ($1, $2, $3, 'resume_builder', $4, $5, $6)`,
    [doc_id, user_id, college_id, templateId, s3Key, finalData]
  );

  // ai_usage_log, by contrast, is best-effort accounting and must NOT fail
  // an otherwise-successful build — same non-fatal pattern as the /analyze
  // and /enhance controller endpoints. Previously a blip on this insert
  // would mark a perfectly good build "failed" in BullMQ (PDF already safely
  // in S3, documents row already saved) and force the student to rebuild
  // from scratch for no real reason.
  try {
    await pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'resume_builder', $3, $4, $5)`,
      [user_id, college_id, MODEL_NAME, tokensIn, tokensOut]
    );
  } catch (logErr) {
    console.error('[resume_builder build] ai_usage_log insert failed (non-fatal):', logErr);
  }

  return { doc_id, s3Key, templateId };
};

const worker = new Worker(
  'resume-builder',
  async (job) => {
    try {
      return await processBuild(job);
    } catch (err) {
      try {
        await pool.query(
          `INSERT INTO error_log (college_id, endpoint, error_message) VALUES ($1, $2, $3)`,
          [job.data.college_id, 'worker:resumeBuilder', err.message]
        );
      } catch (_) { /* swallow — the original error below is what matters */ }
      throw err;
    }
  },
  { connection: require('../config/redisConnection') }
);

worker.on('completed', (job) => console.log(`Resume build ${job.id} done`));
worker.on('failed', (job, err) => console.error(`Resume build ${job?.id} failed:`, err.message));

module.exports = worker;
module.exports.renderResumePDF = renderResumePDF; // exported for testing
module.exports.polishWithGemini = polishWithGemini; // exported for testing
module.exports.processBuild = processBuild; // exported for testing
module.exports.TEMPLATES = TEMPLATES; // exported for testing + controller validation
module.exports.TEMPLATE_IDS = TEMPLATE_IDS; // exported for controller validation
