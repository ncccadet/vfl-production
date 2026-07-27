# Contract: Court Simulation (v2)
**Status:** Draft
**Week:** Week 4
**Limit:** 4 sessions/WEEK (weekly Redis window, per-college staggered — replaces 2/day)
**Estimated Cost (350 students):** ~₹63K/month max — RECALCULATE with revised token limits + weekly cadence

---

## v2 Changes vs Original
- Flow UNCHANGED: student argues → LLM analyses → judge/opponent responds → summary at turn 8
- Session limit is WEEKLY (4/week) — `featureLimitWeekly` in Redis, per-college staggered reset (Monday RPM spike prevention)
- **Token limits per turn revised — final numbers TBD. Fill in here before any code: Max tokens in: ___ /turn · Max tokens out: ___ /turn**
- Model: Gemini 2.5 Flash (Flash-Lite degrades on multi-turn legal reasoning past turn 6)

## Definition of Done
> unchanged from Founder Playbook Part 5 — 8-turn session, summary at end, double-protected limit (Redis + DB)

## Files
Unchanged: courtSimulation.{routes,controller}.js, CourtSimulationPage.jsx, courtSimulation.service.js, sessions model

## Pre-Deploy Checklist
- [ ] Normal / [ ] Stupid / [ ] Access
- [ ] Limit — 5th session in a week blocked; message states weekly reset, not midnight
- [ ] Cost — ai_usage_log per-session token totals vs contract estimate
