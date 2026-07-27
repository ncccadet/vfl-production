# Contract: Drafting Lab (v2 — three modes)
**Status:** Draft
**Week:** Week 3
**Daily Limit:** 3/day — applies ONLY to Mode 3 (AI case study). Modes 1–2 unlimited (no AI).
**Estimated Cost (350 students):** RECALCULATE — Mode 3 = 2 AI calls per exercise (case gen + score/model draft), both long-output

---

## v2 Changes vs Original
- **Mode 1 — View (no AI):** pre-fed templates, multiple languages, read-only, from `draft_templates`
- **Mode 2 — Practice (no AI):** same templates with blanks; deterministic cross-verification against server-side `answer_key` (never sent to browser)
- **Mode 3 — Case Study (AI):** filters (TBD) → AI generates a fresh case → student writes full draft → worker scores it + generates a **comparing model draft**
- Old "template + variables → Gemini fills language" flow is REMOVED

## Definition of Done
Student can view/practice templates in ≥2 languages with instant deterministic blank-checking, and complete an AI case-study cycle (generate → draft → score + model draft) within 3/day.

## API Endpoints
| Method | Path | AI? |
|---|---|---|
| GET  | /api/drafting-lab/templates?language=&template_type= | No |
| GET  | /api/drafting-lab/templates/:id | No (answer_key never returned) |
| POST | /api/drafting-lab/verify-blanks | No |
| POST | /api/drafting-lab/case-study | Yes — counts against 3/day |
| POST | /api/drafting-lab/case-study/submit | Yes (worker) — 1 free submit per generated case |
| GET  | /api/drafting-lab/case-study/result/:id | No (poll) |
| GET  | /api/drafting-lab/history | No |

## DB
draft_templates (NEW), documents, prompt_versions, ai_usage_log

## Files
| File | Owner | Done? |
|------|-------|-------|
| frontend/src/pages/DraftingLabPage.jsx | | [ ] |
| frontend/src/services/draftingLab.service.js | | [ ] |
| backend/routes/draftingLab.routes.js | | [ ] |
| backend/controllers/draftingLab.controller.js | | [ ] |
| backend/workers/draftingLab.worker.js (NEW) | | [ ] |

## Pre-Deploy Checklist
- [ ] Normal — all three modes end to end
- [ ] Stupid — gibberish blanks, 50-page draft paste (must reject BEFORE billing), double submit
- [ ] Access — poll another student's result id → 403
- [ ] Limit — 4th case-study of the day blocked; verify submit doesn't bypass via re-submitting old cases
- [ ] Cost — ai_usage_log: exactly 2 calls per completed exercise
