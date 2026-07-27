# Decisions Log

Add one line after every non-obvious architecture or cost decision.

## Format
`YYYY-MM-DD: Decided [X] over [Y] for [feature]. Reason: [why].`

## Examples
```
2026-06-01: Decided Gemini 2.0 Flash over GPT-4. Reason: 3x cheaper per token.
2026-06-02: Decided 2 sessions/day for Court Simulation. Reason: 2×350×₹3 = ₹2,100/day max.
2026-06-03: Decided to cache jobs twice daily not real-time. Reason: cuts API cost 90%.
2026-06-04: Decided PDF always via BullMQ worker. Reason: crash isolation from main API.
2026-06-05: Decided to launch with PCS-J and APO exams first. Reason: client confirmation.
```

---
<!-- Add real decisions below this line -->

## 2026-07-12 — v2 Feature Revision (scaffold update)
- Job Board rearchitected: three sources (721+ direct scrape targets in new job_sources DB table, provider APIs incl. Apify/Adzuna, capped LLM extraction). Reason: single-API design too narrow; DB-driven source list grows without deploys.
- job_cache expiry 48h→72h. Reason: refresh cadence is now every 2 days; expiry must exceed cadence.
- AI Interviewer: fixed question bank → per-session LLM-generated 8–10 questions with difficulty tiers, optional resume, third-party TTS (server proxy) + browser STT. Question generation moved to a worker because resume PDFs never touch the API process (P004).
- Drafting Lab: split into 3 modes; AI removed from Modes 1–2 (view + deterministic fill-the-blanks via new draft_templates table); Mode 3 is AI case study with scored draft + comparing model draft, scored async in a worker.
- Exam Prep: added long_form questions with pre-authored comparing answer sheets (model_answer) and exam_attempts table for analytics. Still zero AI at query time.
- Law News: AI-only sourcing, 1 LLM call/week shared across colleges; hallucination guard added (P014).
- Court Simulation & AI Interviewer limits: 2/day → 4/WEEK via new featureLimitWeekly (weekly Redis window, per-college staggered reset to prevent Monday RPM spike).
- Added prompt_versions and ai_usage_log tables platform-wide (Model Selection Playbook Gaps 2 & 6).
