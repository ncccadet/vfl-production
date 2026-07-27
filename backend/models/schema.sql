-- schema.sql — Full Voxera For Law database schema (v2 — July 2026 feature revision)
--
-- THE RULE: every table with student data MUST have college_id
--           every query MUST include WHERE college_id = ?
--           enforced TWICE: Row Level Security + application code
--
-- Run order: colleges → users → feature_usage → documents → sessions
--            → job_sources → job_cache → exam_content → exam_attempts
--            → draft_templates → embeddings → prompt_versions → ai_usage_log → error_log

CREATE TABLE IF NOT EXISTS colleges (
  college_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  plan_tier     TEXT NOT NULL DEFAULT 'standard',
  max_students  INT NOT NULL DEFAULT 350,
  contact_email TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  user_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id             UUID NOT NULL REFERENCES colleges(college_id) ON DELETE CASCADE,
  email                  TEXT NOT NULL UNIQUE,
  hashed_password        TEXT NOT NULL,   -- ALWAYS bcrypt — never plain text
  role                   TEXT NOT NULL DEFAULT 'student',
  email_digest           BOOLEAN NOT NULL DEFAULT TRUE,
  active_session_version INTEGER NOT NULL DEFAULT 1,  -- incremented on login / password change for single-device enforcement
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_college ON users(college_id);

CREATE TABLE IF NOT EXISTS password_resets (
  reset_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  otp_hash    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS feature_usage (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  college_id    UUID NOT NULL,
  feature_name  TEXT NOT NULL,
  used_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  count         INT NOT NULL DEFAULT 1,
  score         INT,
  UNIQUE(user_id, feature_name, used_date)
);
CREATE INDEX idx_usage_college ON feature_usage(college_id);

CREATE TABLE IF NOT EXISTS documents (
  doc_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  college_id    UUID NOT NULL,
  feature_name  TEXT NOT NULL,
  template_type TEXT,
  s3_key        TEXT NOT NULL,      -- File lives on S3; only pointer in DB
  analysis_json JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_docs_user    ON documents(user_id, feature_name);
CREATE INDEX idx_docs_college ON documents(college_id);

-- v2 CHANGE: sessions extended for the new AI Interviewer flow.
--   difficulty      — easy | medium | hard (interviewer tiers)
--   filters         — JSONB of the extra filters chosen at start (shape TBD; JSONB so no migration when filters are finalised)
--   questions       — the 8–10 questions the LLM generated ONCE at session start.
--                     Stored so we never re-generate (cost) and can replay/audit the session.
--   resume_doc_id   — optional pointer to documents row if student attached a resume
CREATE TABLE IF NOT EXISTS sessions (
  session_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  college_id    UUID NOT NULL,
  feature_name  TEXT NOT NULL,      -- court_simulation | ai_interviewer
  session_type  TEXT NOT NULL,
  difficulty    TEXT,               -- ai_interviewer only: easy | medium | hard
  filters       JSONB NOT NULL DEFAULT '{}',
  questions     JSONB NOT NULL DEFAULT '[]',
  resume_doc_id UUID REFERENCES documents(doc_id),
  turns         JSONB NOT NULL DEFAULT '[]',
  turn_count    INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',  -- preparing | active | complete (preparing = worker still generating questions)
  is_complete   BOOLEAN NOT NULL DEFAULT FALSE,
  summary       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sessions_user    ON sessions(user_id, feature_name);
CREATE INDEX idx_sessions_college ON sessions(college_id);

-- v2 NEW TABLE: the curated 721+ scrape targets live in the DB, not in code.
-- WHY: the list will grow past 750. A DB table lets you add/disable sources
-- without a deploy, and lets the worker record per-source health.
-- No college_id: sources are shared platform infrastructure.
CREATE TABLE IF NOT EXISTS job_sources (
  source_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,
  category        TEXT NOT NULL,     -- portal | aggregator | government | law_firm | court | ngo | edtech
  scrape_method   TEXT NOT NULL DEFAULT 'direct',  -- direct | apify | api_jsearch | api_serpapi | api_adzuna | llm_extract
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_scraped_at TIMESTAMPTZ,
  last_status     TEXT,              -- ok | failed | empty
  fail_count      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sources_active ON job_sources(is_active, last_scraped_at);

-- No college_id: jobs are shared across all colleges
-- v2 CHANGES:
--   source_type — which of the 3 pipelines produced this row (direct_scrape | provider_api | llm_extract)
--   source_url  — provenance: where the listing came from
--   dedupe_hash — md5(title+firm+apply_url); UNIQUE + ON CONFLICT DO NOTHING stops
--                 the same job entering 3x when scraper, Apify AND an API all find it
--   expires_at default raised 48h → 72h because refresh cadence is now every 2 days.
--                 48h expiry + 48h cadence = a delayed run leaves students an EMPTY board (P006 variant).
CREATE TABLE IF NOT EXISTS job_cache (
  job_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,        -- direct_scrape | provider_api | llm_extract
  source_api  TEXT,                 -- jsearch | serpapi | adzuna | apify | NULL for direct
  source_url  TEXT,
  dedupe_hash TEXT UNIQUE,
  title       TEXT NOT NULL,
  firm        TEXT,
  location    TEXT,
  job_type    TEXT,
  apply_url   TEXT,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '72 hours'
);
CREATE INDEX idx_jobs_expires ON job_cache(expires_at);

-- No college_id: exam content is shared
-- v2 CHANGES:
--   question_format — mcq | long_form (long-form written answers are new)
--   options_json / correct_answer now nullable (long_form questions have neither)
--   model_answer    — pre-written comparing answer sheet for long_form questions
--   content_source  — pyq | generated (if WE generated the paper, a model_answer MUST exist)
CREATE TABLE IF NOT EXISTS exam_content (
  question_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_type       TEXT NOT NULL,
  question_format TEXT NOT NULL DEFAULT 'mcq',   -- mcq | long_form
  question        TEXT NOT NULL,
  options_json    JSONB,                          -- NULL for long_form
  correct_answer  TEXT,                           -- NULL for long_form
  model_answer    TEXT,                           -- comparing answer sheet (long_form; required when content_source='generated')
  explanation     TEXT,                           -- Pre-generated offline — zero AI cost at query time
  content_source  TEXT NOT NULL DEFAULT 'pyq',    -- pyq | generated
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_exam_type ON exam_content(exam_type, question_format);

-- v2 NEW TABLE: long-form exam attempts.
-- feature_usage only stores a single daily score int — long-form answers need
-- the full written text so the student can view their answer next to the model
-- answer sheet, and so analytics can be computed later.
CREATE TABLE IF NOT EXISTS exam_attempts (
  attempt_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  college_id  UUID NOT NULL,
  exam_type   TEXT NOT NULL,
  answers     JSONB NOT NULL DEFAULT '[]',  -- [{question_id, answer_text | selected_option}]
  score       INT,                          -- MCQ auto-score; NULL for pure long-form papers
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_attempts_user    ON exam_attempts(user_id, exam_type);
CREATE INDEX idx_attempts_college ON exam_attempts(college_id);

-- v2 NEW TABLE: Drafting Lab pre-fed templates (Modes 1 and 2 — no AI).
-- No college_id: templates are shared platform content.
--   language     — multi-language support (en | hi | mr to start)
--   full_text    — Mode 1: complete draft for viewing
--   blanks_json  — Mode 2: [{blank_id, position, hint}] — the fill-in-the-blank slots
--   answer_key   — Mode 2: {blank_id: [accepted answers]} — deterministic cross-verification, NO AI call
CREATE TABLE IF NOT EXISTS draft_templates (
  template_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_type TEXT NOT NULL,      -- legal_notice | affidavit | bail_application | vakalatnama | rti_application | ...
  language      TEXT NOT NULL DEFAULT 'en',
  full_text     TEXT NOT NULL,
  blanks_json   JSONB NOT NULL DEFAULT '[]',
  answer_key    JSONB NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_templates_type ON draft_templates(template_type, language) WHERE is_active;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_doc  TEXT NOT NULL,        -- ipc | crpc | evidence_act | cpc | constitution
  chunk_text  TEXT NOT NULL,
  embedding   vector(768),          -- Gemini text-embedding-004 dimension
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- v2 NEW TABLE: prompt version control (Model Selection Playbook, Gap 6).
-- System prompts (interviewer persona, case-study generator, judge persona)
-- live HERE, not as hardcoded strings. Roll back a bad prompt without a deploy.
CREATE TABLE IF NOT EXISTS prompt_versions (
  prompt_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_name TEXT NOT NULL,
  version      INT NOT NULL,
  prompt_text  TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(feature_name, version)
);

-- v2 NEW TABLE: per-call AI token log (Model Selection Playbook, Gap 2).
-- Provider dashboards lag and don't split by feature/user. This table is the
-- source of truth for the Cost Path check and the ₹20K budget alert.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID,
  college_id   UUID,
  feature_name TEXT NOT NULL,
  model        TEXT NOT NULL,
  tokens_in    INT NOT NULL,
  tokens_out   INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ai_usage_day ON ai_usage_log(feature_name, created_at);

CREATE TABLE IF NOT EXISTS error_log (
  id             BIGSERIAL PRIMARY KEY,
  college_id     UUID,              -- Nullable: error may occur before auth
  endpoint       TEXT,
  error_message  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Row Level Security — second enforcement layer
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_users ON users FOR ALL USING (college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid);
CREATE POLICY tenant_isolation_feature_usage ON feature_usage FOR ALL USING (college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid);
CREATE POLICY tenant_isolation_documents ON documents FOR ALL USING (college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid);
CREATE POLICY tenant_isolation_sessions ON sessions FOR ALL USING (college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid);
CREATE POLICY tenant_isolation_exam_attempts ON exam_attempts FOR ALL USING (college_id = NULLIF(current_setting('app.current_college_id', true), '')::uuid);

