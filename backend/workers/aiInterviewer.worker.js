/**
 * aiInterviewer.worker.js — NEW in v2
 *
 * WHY THIS FILE EXISTS:
 * Question generation may need resume text extracted from a PDF.
 * P004 rule: PDFs NEVER touch the main API process. So the whole
 * "system prompt → LLM → 8–10 questions" step runs here.
 *
 * FLOW per job:
 *   1. Load session (difficulty, filters, resume_doc_id)
 *   2. If resume_doc_id: fetch PDF from S3, extract text (cap 1500 tokens — same cap as Resume Analyzer)
 *   3. Load active system prompt from prompt_versions (feature_name='ai_interviewer')
 *   4. ONE Gemini call → JSON array of 8–10 questions
 *   5. Validate: 8 <= questions.length <= 10, each non-empty. If invalid → retry once → mark session 'failed'
 *   6. UPDATE sessions SET questions=$1, status='active'
 *   7. Log tokens to ai_usage_log
 */
const { Worker } = require('bullmq');
const { pool } = require('../config/db');
const { callGemini } = require('../utils/gemini');

const worker = new Worker('ai-interviewer', async (job) => {
  const { session_id, user_id, college_id } = job.data;
  console.log('AI interviewer question generation for session', session_id);
  
  const prompt = `Generate an array of exactly 8-10 interview questions for a law student/lawyer.
Return ONLY a JSON array of strings, for example: ["Question 1", "Question 2"]
Session ID: ${session_id}`;
  const { text: responseText, usage } = await callGemini(prompt, {
    isJson: true,
    systemInstruction: "You are an expert legal interviewer."
  });
  let questions = JSON.parse(responseText);
  if (!Array.isArray(questions) || questions.length < 8) {
    throw new Error('Invalid questions format from AI');
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(
      `UPDATE sessions SET questions = $1, status = 'active' WHERE session_id = $2`,
      [JSON.stringify(questions), session_id]
    );
    
    if (user_id && college_id) {
      await client.query(
        `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
         VALUES ($1, $2, 'ai_interviewer', 'gemini-3.1-flash-lite', $3, $4)`,
        [user_id, college_id, usage.promptTokenCount, usage.candidatesTokenCount]
      );
    }
    
    await client.query('COMMIT');
    console.log('AI interviewer session prepared:', session_id);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('AI interviewer worker failed:', err);
    throw err;
  } finally {
    client.release();
  }
}, { connection: require('../config/redisConnection')() });

module.exports = { worker };
