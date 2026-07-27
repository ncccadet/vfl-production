/**
 * resumeAnalyzer.worker.js — BullMQ worker
 *
 * Why a worker? A malicious PDF can crash the parser. Isolating in a worker
 * means the main API process stays alive even if this crashes.
 *
 * Flow: download PDF from S3 → extract text → call Gemini → save to documents table
 *
 * NOTE: S3 download + PDF extraction is not yet implemented. For now, the
 * worker expects `resume_text` to be passed in the job data by the controller.
 * Once real S3 is wired up, replace this with actual PDF download + parsing.
 */
const { Worker } = require('bullmq');
const { pool } = require('../config/db');
const { callGemini } = require('../utils/gemini');

const worker = new Worker('resume-analysis', async (job) => {
  const { doc_id, s3Key, user_id, college_id, resume_text } = job.data;
  console.log(`Processing resume for user ${user_id}`);
  
  const textToAnalyze = resume_text || 'No resume text provided. Please re-upload.';

  const prompt = `Analyze the following resume text and provide a JSON response with exactly this schema:
{
  "score": <number 0-100>,
  "categories": {
    "formatting": "<string>",
    "impact": "<string>",
    "brevity": "<string>",
    "grammar": "<string>",
    "relevance": "<string>"
  }
}

Resume Text:
${textToAnalyze}`;

  const { text: responseText, usage } = await callGemini(prompt, {
    isJson: true,
    systemInstruction: "You are an expert legal resume analyzer."
  });

  const resultData = JSON.parse(responseText);

  const analysisResult = {
    status: 'complete',
    result: resultData
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(
      `UPDATE documents SET analysis_json = $1 WHERE doc_id = $2`,
      [JSON.stringify(analysisResult), doc_id]
    );

    await client.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'resume_analyzer', 'gemini-3.1-flash-lite', $3, $4)`,
      [user_id, college_id, usage.promptTokenCount, usage.candidatesTokenCount]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}, { connection: require('../config/redisConnection')() });

worker.on('completed', (job) => console.log(`Resume job ${job.id} done`));
worker.on('failed',    (job, err) => console.error(`Resume job ${job.id} failed:`, err));

module.exports = worker;
