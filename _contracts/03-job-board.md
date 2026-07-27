# Contract: Job Board (v2 — three-source pipeline)
**Status:** Draft
**Week:** Week 3
**Daily Limit:** None for students (they only read job_cache). Scrape-time LLM extraction hard-capped at LLM_EXTRACT_MAX_PER_RUN (start: 50).
**Estimated Cost (350 students):** APIs (JSearch/SerpAPI/Adzuna/Apify) + small LLM-extract budget — RECALCULATE once Apify actor pricing is known

---

## v2 Architecture (replaces JSearch+SerpAPI-only design)
**Source 1 — Direct scrapers:** 721+ curated sites (courts, NALSA, firms, portals) in the `job_sources` DB table. Refresh every 2 days.
**Source 2 — Provider APIs:** Apify actors + JSearch + SerpAPI + Adzuna.
**Source 3 — LLM extraction:** raw HTML → LLM → structured listing, only for sources marked `llm_extract`, hard-capped per run.

## Non-negotiable worker rules
- Insert-before-delete (P006)
- Per-source transaction + try/catch (one dead site of 721 ≠ dead run); auto-disable after 5 consecutive failures
- Dedupe across all three sources via `dedupe_hash` UNIQUE
- `expires_at = 72h` (cadence is 2 days; 48h expiry risks an empty board)
- Students NEVER trigger external calls

## Definition of Done
Students see a deduplicated, filterable list refreshed every 2 days from all three sources; a full-run failure leaves yesterday's jobs visible, never an empty board.

## API Endpoints
| Method | Path |
|---|---|
| GET | /api/jobs?city=&type=&page= |
| GET | /health/job-board (planned — UptimeRobot scrape-health check) |

## DB
job_sources (NEW — seed from curated PDF lists, see backend/models/seeds/README.md), job_cache (+source_type, source_url, dedupe_hash), ai_usage_log

## Open item
State filter for the 677 district-court sources (61 pages unfiltered is a known UX gap).

## Pre-Deploy Checklist
- [ ] Normal / [ ] Stupid / [ ] Access
- [ ] Limit — LLM-extract cap enforced (kill-switch test: mark 100 sources llm_extract, confirm run stops at cap)
- [ ] Cost — one full run's API + LLM cost measured on staging BEFORE production
