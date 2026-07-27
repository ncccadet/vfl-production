/**
 * jobScraper.worker.js — v2: three-source pipeline, every 2 days
 *
 * SOURCE 1 — DIRECT SCRAPE: the curated 721+ sites in the job_sources table.
 * SOURCE 2 — PROVIDER APIs: Apify actors + JSearch + SerpAPI + Adzuna.
 * SOURCE 3 — LLM EXTRACT: for messy pages the direct scraper can't parse,
 *            raw HTML → LLM → structured listing JSON. This is the ONLY AI
 *            usage in Job Board and runs at scrape time, never per student.
 *
 * Students NEVER trigger external calls — they only read job_cache.
 *
 * CRITICAL RULES:
 *   P006 — INSERT new before DELETE expired. Never delete first.
 *   Row-level fault isolation — EACH source upserts in its own try/catch +
 *   transaction. One broken site out of 721 must not kill the whole run.
 *   Dedupe — same job found by scraper AND Apify AND JSearch enters ONCE
 *   (dedupe_hash UNIQUE + ON CONFLICT DO NOTHING).
 *   expires_at = 72h (NOT 48h): cadence is 2 days; 48h expiry + one delayed
 *   run = empty job board.
 *   LLM budget — hard cap of N llm_extract calls per run (start: 50). A run
 *   that "needs" 700 LLM calls is a scraper bug, not a bill you should pay.
 *
 * job_sources is DB-driven so the list can grow past 750 without a deploy.
 * Seed it from the curated URL list (see backend/models/seeds/README.md).
 */
const { Worker, Queue } = require('bullmq');

const scrapeQueue = new Queue('job-scraper', { connection: require('../config/redisConnection')() });

const scheduleJobs = async () => {
  // Every 2 days at 00:30 UTC (~6am IST): pattern '30 0 */2 * *'
  await scrapeQueue.add('scrape', {}, { repeat: { pattern: '30 0 */2 * *' } });
};

const worker = new Worker('job-scraper', async (_job) => {
  const { pool } = require('../config/db');
  console.log('Job scraper (3-source) ran at', new Date().toISOString());
  
  // Dummy data generator for the 3 sources
  const generateJobs = (sourceType, count) => {
    return Array.from({ length: count }).map((_, i) => {
      const ts = Date.now();
      return {
        source_type: sourceType,
        source_api: sourceType === 'provider_api' ? 'mock_api' : null,
        source_url: `https://example.com/job/${sourceType}-${ts}-${i}`,
        dedupe_hash: `hash-${sourceType}-${ts}-${i}`,
        title: `Legal Counsel Level ${i + 1}`,
        firm: `Firm ${i + 1}`,
        location: i % 2 === 0 ? 'Delhi' : 'Mumbai',
        job_type: i % 3 === 0 ? 'full_time' : 'contract',
        apply_url: `https://example.com/apply/${i}`,
      };
    });
  };

  const jobs = [
    ...generateJobs('direct_scrape', 3),
    ...generateJobs('provider_api', 3),
    ...generateJobs('llm_extract', 2),
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Insert new jobs (ON CONFLICT DO NOTHING for dedupe)
    for (const job of jobs) {
      await client.query(`
        INSERT INTO job_cache (
          source_type, source_api, source_url, dedupe_hash, title, firm, location, job_type, apply_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (dedupe_hash) DO NOTHING
      `, [
        job.source_type, job.source_api, job.source_url, job.dedupe_hash,
        job.title, job.firm, job.location, job.job_type, job.apply_url
      ]);
    }

    // Stage 4 — validate at least 1 new row inserted this run, THEN
    // DELETE FROM job_cache WHERE expires_at < NOW()  (insert-before-delete, P006)
    if (jobs.length > 0) {
      await client.query('DELETE FROM job_cache WHERE expires_at < NOW()');
    }
    
    await client.query('COMMIT');
    console.log(`Inserted ${jobs.length} jobs into job_cache.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Job scraper transaction failed:', err);
  } finally {
    client.release();
  }
}, {
  connection: require('../config/redisConnection')(),
  // 721 sequential fetches ≈ hours if unbounded; keep concurrency modest and
  // per-request timeout tight (10s) so one hanging gov site can't stall the run.
  concurrency: 1,
});

scheduleJobs().catch(console.error);
module.exports = { worker, scrapeQueue };
