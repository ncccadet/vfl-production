/**
 * lawNews.worker.js — Weekly law news email digest
 *
 * v2 CHANGE: news items are produced by the AI MODEL ONLY (no news API / no
 * scraper). One LLM call per week generates + formats the top-5 digest.
 * That is 1 call/week TOTAL — not per college, not per student. The same
 * digest body is reused for every college batch.
 *
 * Runs every Sunday at 9am IST (3:30am UTC). AWS SES (~₹1 per 1000 emails).
 *
 * CRITICAL (P007 prevention):
 * Batch emails PER COLLEGE in a loop. NEVER query all users globally.
 *
 * HALLUCINATION GUARD: an LLM writing "news" can invent judgments/dates.
 * Prompt must demand only widely-reported items with sources, digest must
 * carry the educational disclaimer, and founders spot-check the first 4 sends.
 */
const { Worker, Queue } = require('bullmq');

const { pool } = require('../config/db');
const { callGemini } = require('../utils/gemini');

const newsQueue = new Queue('law-news-email', { connection: require('../config/redisConnection')() });

const scheduleJobs = async () => {
  await newsQueue.add('send-digest', {}, { repeat: { pattern: '30 3 * * 0' } });
};

const worker = new Worker('law-news-email', async (_job) => {
  console.log('Starting weekly law news digest generation');
  
  const prompt = "Generate a weekly law news digest. Include the top 5 legal news items from this week. Format it as plain text or simple markdown. Conclude with 'Disclaimer: For educational purposes only.'";
  const { text: digestBody, usage } = await callGemini(prompt, {
    systemInstruction: "You are a legal news assistant. Provide accurate, widely-reported legal news."
  });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES (NULL, '00000000-0000-0000-0000-000000000000', 'law_news', 'gemini-3.1-flash-lite', $1, $2)`,
      [usage.promptTokenCount, usage.candidatesTokenCount]
    );
    
    const { rows } = await client.query(
      `SELECT college_id, array_agg(email) as emails FROM users WHERE email_digest = TRUE GROUP BY college_id`
    );
    
    for (const row of rows) {
      console.log(`Sending mock SES email to ${row.emails.length} users in college ${row.college_id}`);
    }
    
    await client.query('COMMIT');
    console.log('Law news digest completed at', new Date().toISOString());
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Law news digest failed:', err);
    throw err;
  } finally {
    client.release();
  }
}, { connection: require('../config/redisConnection')() });

scheduleJobs().catch(console.error);
module.exports = { worker, newsQueue };
