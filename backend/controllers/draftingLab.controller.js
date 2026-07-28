/**
 * draftingLab.controller.js
 * Contract: _contracts/04-drafting-lab.md
 *
 * Flow (fill-in-the-blanks):
 *   1. GET  /types                         → student picks a draft type
 *   2. POST /case-study { draftType }      → AI generates a case (worker, 3/day)
 *   3. GET  /case-study/result/:docId      → poll → returns case + the draft template + its blanks
 *   4. Student fills the blanks in the browser and downloads the completed draft.
 *   5. GET  /history                       → past generated cases
 *
 * The draft templates and their blanks live INLINE in this file (DRAFT_TYPES) —
 * no separate seed/table is required. college_id filters every documents query.
 * featureLimit('drafting_lab', 3) is applied to /case-study in the route file.
 */
const { Pool } = require('pg');
const { Queue } = require('bullmq');
const redis = require('../config/redisConnection');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const draftQueue = new Queue('drafting-lab', { connection: require('../config/redisConnection') });

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDateKey = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const limitKey = (user_id) => `feature_limit:${user_id}:drafting_lab:${istDateKey()}`;

// ── The draft templates. Each template body uses {{blank_id}} tokens; the student
//    fills each blank (guided by the AI-generated case) and downloads the result. ──
const DRAFT_TYPES = {
  bail_application: {
    label: 'Bail Application (S.483 BNSS)',
    blanks: [
      { id: 'court_name', label: 'Court', hint: 'e.g. The Sessions Judge, ____' },
      { id: 'fir_number', label: 'FIR No.', hint: 'e.g. 145/2026' },
      { id: 'police_station', label: 'Police Station', hint: '' },
      { id: 'offence_sections', label: 'Offence sections (BNS)', hint: 'e.g. 115(2), 351(2) BNS' },
      { id: 'accused_name', label: 'Accused name', hint: '' },
      { id: 'accused_address', label: 'Accused address', hint: '' },
      { id: 'arrest_date', label: 'Date of arrest', hint: '' },
      { id: 'grounds', label: 'Main ground for bail', hint: 'one or two sentences' },
      { id: 'prayer', label: 'Prayer', hint: 'the relief sought' },
      { id: 'place', label: 'Place', hint: '' },
      { id: 'date', label: 'Date', hint: '' },
    ],
    template:
`BAIL APPLICATION UNDER SECTION 483 BNSS, 2023
IN THE COURT OF {{court_name}}
Bail Application No. ______ of 2026
(Arising out of FIR No. {{fir_number}}, P.S. {{police_station}}, for offences u/s {{offence_sections}})

IN THE MATTER OF:
{{accused_name}}, R/o {{accused_address}} ..... Applicant / Accused
VERSUS
State ..... Respondent

MOST RESPECTFULLY SHOWETH:
1. That the applicant was arrested on {{arrest_date}} and has been in judicial custody since then.
2. That the applicant is innocent and has been falsely implicated in the present case.
3. That {{grounds}}.
4. That the applicant undertakes to cooperate with the trial and shall not tamper with the evidence or influence any witness.

PRAYER: {{prayer}}

Place: {{place}}                                  Applicant, through Counsel
Date: {{date}}`,
  },

  anticipatory_bail: {
    label: 'Anticipatory Bail (S.482 BNSS)',
    blanks: [
      { id: 'court_name', label: 'Court', hint: 'e.g. The Sessions Judge, ____' },
      { id: 'fir_number', label: 'FIR No.', hint: '' },
      { id: 'police_station', label: 'Police Station', hint: '' },
      { id: 'offence_sections', label: 'Offence sections (BNS)', hint: '' },
      { id: 'applicant_name', label: 'Applicant name', hint: '' },
      { id: 'applicant_address', label: 'Applicant address', hint: '' },
      { id: 'apprehension_grounds', label: 'Why arrest is apprehended', hint: 'the ground of apprehension' },
      { id: 'prayer', label: 'Prayer', hint: '' },
      { id: 'place', label: 'Place', hint: '' },
      { id: 'date', label: 'Date', hint: '' },
    ],
    template:
`APPLICATION FOR ANTICIPATORY BAIL UNDER SECTION 482 BNSS, 2023
IN THE COURT OF {{court_name}}
Anticipatory Bail Application No. ______ of 2026
(FIR No. {{fir_number}}, P.S. {{police_station}}, u/s {{offence_sections}})

{{applicant_name}}, R/o {{applicant_address}} ..... Applicant
VERSUS   State ..... Respondent

MOST RESPECTFULLY SHOWETH:
1. That the applicant apprehends arrest because {{apprehension_grounds}}.
2. That the applicant is innocent and has been falsely implicated.
3. That the applicant is ready and willing to cooperate with the investigation.
4. That there is no likelihood of the applicant absconding or tampering with the evidence.

PRAYER: {{prayer}}

Place: {{place}}                                  Applicant, through Counsel
Date: {{date}}`,
  },

  vakalatnama: {
    label: 'Vakalatnama',
    blanks: [
      { id: 'court_name', label: 'Court', hint: '' },
      { id: 'case_number', label: 'Case No.', hint: '' },
      { id: 'party_name', label: 'Party (executant) name', hint: '' },
      { id: 'party_capacity', label: 'Party capacity', hint: 'Plaintiff / Defendant / Accused / Petitioner' },
      { id: 'advocate_name', label: 'Advocate name', hint: '' },
      { id: 'advocate_enrolment', label: 'Advocate enrolment no.', hint: '' },
      { id: 'place', label: 'Place', hint: '' },
      { id: 'date', label: 'Date', hint: '' },
    ],
    template:
`VAKALATNAMA
IN THE COURT OF {{court_name}}
Case No. {{case_number}}

I, {{party_name}}, the {{party_capacity}} in the above case, do hereby appoint and retain
{{advocate_name}} (Enrolment No. {{advocate_enrolment}}), Advocate, to appear, act and plead
on my behalf in the above-noted matter, and authorise the said Advocate to file and receive
documents and pleadings, to deposit and withdraw money and grant valid receipts, and to do all
lawful acts necessary for the conduct of the case. I agree to ratify all such lawful acts.

Place: {{place}}                                  {{party_name}} (Executant)
Date: {{date}}                                    Accepted: {{advocate_name}}, Advocate`,
  },

  legal_notice: {
    label: 'Legal Notice',
    blanks: [
      { id: 'advocate_name', label: 'Advocate name', hint: '' },
      { id: 'advocate_address', label: 'Advocate address', hint: '' },
      { id: 'notice_date', label: 'Date of notice', hint: '' },
      { id: 'recipient_name', label: 'Recipient name', hint: '' },
      { id: 'recipient_address', label: 'Recipient address', hint: '' },
      { id: 'client_name', label: 'Client name', hint: '' },
      { id: 'subject', label: 'Subject', hint: 'one line' },
      { id: 'facts', label: 'Facts / grievance', hint: 'what happened' },
      { id: 'demand', label: 'Demand', hint: 'what the recipient must do' },
      { id: 'compliance_days', label: 'Days to comply', hint: 'e.g. 15' },
    ],
    template:
`LEGAL NOTICE
{{advocate_name}}, Advocate — {{advocate_address}}
Dated: {{notice_date}}

To,
{{recipient_name}}, {{recipient_address}}

Sub: {{subject}}

Under instructions from and on behalf of my client, {{client_name}}, I hereby serve upon you the following notice:
1. That {{facts}}.
2. That despite demand you have failed to comply, causing loss to my client.
3. You are called upon to {{demand}} within {{compliance_days}} days of receipt of this notice, failing
   which my client shall be constrained to initiate appropriate legal proceedings at your risk as to costs.

(({{advocate_name}}) — Advocate, for the client)`,
  },

  affidavit: {
    label: 'Affidavit',
    blanks: [
      { id: 'authority', label: 'Sworn before', hint: 'e.g. Notary Public, ____' },
      { id: 'deponent_name', label: 'Deponent name', hint: '' },
      { id: 'deponent_parentage', label: 'Parentage', hint: 'S/o, D/o, W/o ____' },
      { id: 'deponent_age', label: 'Age', hint: '' },
      { id: 'deponent_address', label: 'Address', hint: '' },
      { id: 'statements', label: 'Statement(s) of fact', hint: 'what you are declaring' },
      { id: 'purpose', label: 'Purpose', hint: 'why this affidavit is made' },
      { id: 'place', label: 'Place', hint: '' },
      { id: 'date', label: 'Date', hint: '' },
    ],
    template:
`AFFIDAVIT
Sworn before {{authority}}

I, {{deponent_name}}, {{deponent_parentage}}, aged about {{deponent_age}} years, R/o {{deponent_address}},
do hereby solemnly affirm and declare on oath as under:
1. That {{statements}}.
2. That this affidavit is made for the purpose of {{purpose}}.

VERIFICATION: Verified at {{place}} on {{date}} that the contents of this affidavit are true and correct
to my knowledge, and nothing material has been concealed therefrom.

{{deponent_name}} — Deponent`,
  },
};

const publicType = (id) => ({ id, label: DRAFT_TYPES[id].label });

// ── 1. list the draft types a student can pick ──────────────────────────────
const listTypes = (_req, res) => {
  res.json({ types: Object.keys(DRAFT_TYPES).map(publicType) });
};

// ── 2. generate a case for the chosen draft type (AI, via worker; 3/day) ─────
const generateCaseStudy = async (req, res, next) => {
  const { user_id, college_id } = req.user;
  try {
    const draftType = String(req.body.draftType || '');
    if (!DRAFT_TYPES[draftType]) {
      await redis.decr(limitKey(user_id)).catch(() => {}); // bad input never uses a daily slot
      return res.status(400).json({ error: 'Please choose a valid draft type.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO documents (user_id, college_id, feature_name, s3_key, status, analysis_json)
       VALUES ($1,$2,'drafting_lab','n/a','pending',$3) RETURNING doc_id`,
      [user_id, college_id, JSON.stringify({ draftType })]
    );
    const docId = rows[0].doc_id;

    await draftQueue.add(
      'generate-case',
      { docId, draftType, label: DRAFT_TYPES[draftType].label, user_id, college_id, dateKey: istDateKey() },
      { removeOnComplete: 100, removeOnFail: 100, attempts: 1 }
    );

    res.json({ docId, status: 'generating' });
  } catch (err) {
    await redis.decr(limitKey(user_id)).catch(() => {});
    next(err);
  }
};

// ── 3. poll: returns the case + the template and its blanks to fill ─────────
const getCaseResult = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT status, analysis_json FROM documents
        WHERE doc_id = $1 AND user_id = $2 AND college_id = $3 AND feature_name = 'drafting_lab'`,
      [req.params.docId, user_id, college_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found.' });

    const { status, analysis_json } = rows[0];
    if (status === 'pending') return res.json({ status: 'generating', case: null });
    if (status === 'failed') {
      return res.json({ status: 'failed', case: null, message: analysis_json?.message || 'Could not generate a case. Please try again.' });
    }
    const draftType = analysis_json.draftType;
    const def = DRAFT_TYPES[draftType] || {};
    return res.json({
      status: 'complete',
      draftType,
      label: def.label,
      case: analysis_json.case,
      template: def.template,
      blanks: def.blanks,
      disclaimer: 'For educational purposes only. Verify with a qualified advocate.',
    });
  } catch (err) { next(err); }
};

// ── 4. history ──────────────────────────────────────────────────────────────
const getHistory = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT doc_id, status, analysis_json->>'draftType' AS draft_type, created_at
         FROM documents
        WHERE user_id = $1 AND college_id = $2 AND feature_name = 'drafting_lab'
        ORDER BY created_at DESC LIMIT 50`,
      [user_id, college_id]
    );
    res.json({ history: rows.map((r) => ({ docId: r.doc_id, status: r.status, draftType: r.draft_type, created_at: r.created_at })) });
  } catch (err) { next(err); }
};

module.exports = { listTypes, generateCaseStudy, getCaseResult, getHistory };
