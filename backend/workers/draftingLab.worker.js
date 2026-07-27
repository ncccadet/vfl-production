/**
 * draftingLab.worker.js — NEW in v2
 *
 * WHY THIS FILE EXISTS:
 * Scoring a full student draft + generating a model comparison draft is the
 * heaviest single AI call on the platform (long input + long output). Running
 * it synchronously in the API would hold a request open 15–30s and make a
 * Gemini slowdown look like a platform outage. So it runs here; the frontend
 * polls (same pattern as Resume Analyzer).
 *
 * FLOW per job:
 *   1. Load submission (case text + student draft)
 *   2. Load active prompt from prompt_versions('drafting_lab_score')
 *   3. ONE Gemini call → JSON {score, feedback[], model_draft}
 *   4. Validate JSON shape; retry once on parse failure
 *   5. UPDATE documents SET analysis_json=$1 WHERE doc_id=$2
 *   6. Log tokens to ai_usage_log
 */
const { Worker } = require('bullmq');
const { pool } = require('../config/db');
const { callGemini } = require('../utils/gemini');

const worker = new Worker('drafting-lab', async (job) => {
  const { case_id, draft_text, user_id, college_id } = job.data;
  console.log('Drafting lab scoring job started for case:', case_id);
  
  const prompt = `Analyze this legal draft submission.
Provide a JSON response with exactly this schema:
{
  "score": <number 0-100>,
  "feedback": ["<string>", "<string>"],
  "model_draft": "<string>"
}

Case ID: ${case_id}
Student Draft:
${draft_text}`;

  const { text: responseText, usage } = await callGemini(prompt, {
    isJson: true,
    systemInstruction: "You are an expert legal drafting evaluator."
  });
  
  const resultData = JSON.parse(responseText);
  const { score, feedback, model_draft: modelDraft } = resultData;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { rows } = await client.query(`SELECT analysis_json FROM documents WHERE doc_id = $1`, [case_id]);
    if (!rows.length) throw new Error('Document not found');
    
    const analysis = rows[0].analysis_json || {};
    analysis.status = 'complete';
    analysis.score = score;
    analysis.feedback = feedback;
    analysis.model_draft = modelDraft;
    
    await client.query(`UPDATE documents SET analysis_json = $1 WHERE doc_id = $2`, [JSON.stringify(analysis), case_id]);
    
    await client.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'drafting_lab_score', 'gemini-3.1-flash-lite', $3, $4)`,
      [user_id, college_id, usage.promptTokenCount, usage.candidatesTokenCount]
    );
    
    await client.query('COMMIT');
    console.log('Drafting lab scoring job finished for case:', case_id);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Drafting lab worker failed:', err);
    throw err;
  } finally {
    client.release();
  }
}, { connection: require('../config/redisConnection')() });

module.exports = { worker };
