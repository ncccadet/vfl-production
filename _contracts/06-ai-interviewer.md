# Contract: AI Interviewer (v2)
**Status:** Draft
**Week:** Week 4
**Limit:** 4 sessions/WEEK (weekly Redis window, per-college staggered reset — NOT daily)
**Estimated Cost (350 students):** ~₹25K/month max — RECALCULATE: 8–10 questions/session (was 5) ≈ 2x calls per session

---

## v2 Changes vs Original
- Student selects **difficulty tier** (easy | medium | hard) + filters (filter list TBD — served by `GET /options` so frontend never hardcodes)
- Optional **resume upload**: interview grounded in the student's own resume
- Questions are **LLM-generated per session** (8–10) via ONE system-prompt call in `aiInterviewer.worker.js` — no more fixed question bank
- **TTS**: third-party provider, proxied via `POST /tts` (key stays server-side)
- **STT**: browser Web Speech API — zero backend, zero cost

## Definition of Done
Student picks difficulty (+ optional resume) → receives 8–10 tailored questions one by one with TTS audio → per-answer feedback → overall summary; resume PDF never touches the API process.

## API Endpoints
| Method | Path | Notes |
|---|---|---|
| GET  | /api/ai-interviewer/options | difficulties + filters |
| POST | /api/ai-interviewer/start | {difficulty, filters, resume_doc_id?} → 202 {sessionId, status:'preparing'} |
| GET  | /api/ai-interviewer/session/:id | poll while worker generates questions |
| POST | /api/ai-interviewer/answer | {session_id, answer} → feedback / summary |
| POST | /api/ai-interviewer/tts | {text} → audio stream (server-side provider proxy) |

## DB
sessions (difficulty, filters, questions, resume_doc_id, status), documents (resume), prompt_versions, ai_usage_log

## Files
| File | Owner | Done? |
|------|-------|-------|
| frontend/src/pages/AIInterviewerPage.jsx | | [ ] |
| frontend/src/services/aiInterviewer.service.js | | [ ] |
| backend/routes/aiInterviewer.routes.js | | [ ] |
| backend/controllers/aiInterviewer.controller.js | | [ ] |
| backend/workers/aiInterviewer.worker.js | | [ ] |

## Pre-Deploy Checklist
- [ ] Normal — full session with and without resume
- [ ] Stupid — invalid difficulty, empty answers, wrong-format resume, double-click start
- [ ] Access — attach another student's resume_doc_id → must 403 without leaking existence
- [ ] Limit — 5th session in a week blocked; confirm weekly (not midnight) reset message
- [ ] Cost — ai_usage_log shows exactly 1 generation call + N answer calls per session
