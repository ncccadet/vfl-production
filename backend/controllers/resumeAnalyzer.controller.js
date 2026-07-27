/**
 * resumeAnalyzer.controller.js
 * PDF NEVER processed in main API — always via BullMQ worker (crash isolation).
 * Flow: client → S3 directly → controller enqueues job → worker processes → result cached in documents
 */
const { Queue } = require('bullmq');
const { pool } = require('../config/db');
const resumeQueue = new Queue('resume-analysis', { connection: require('../config/redisConnection')() });

const getUploadUrl = async (req, res, next) => {
  try {
    const mockS3Key = `resumes/${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`;
    res.json({ uploadUrl: `https://mock-s3-bucket.s3.amazonaws.com/${mockS3Key}?mock_signature`, s3Key: mockS3Key });
  } catch (err) { next(err); }
};

const analyzeResume = async (req, res, next) => {
  try {
    const { s3Key, resume_text } = req.body;
    const { user_id, college_id } = req.user;
    
    const { rows } = await pool.query(
      `INSERT INTO documents (user_id, college_id, feature_name, s3_key, analysis_json)
       VALUES ($1, $2, 'resume_analyzer', $3, '{"status": "pending"}') RETURNING doc_id`,
      [user_id, college_id, s3Key]
    );
    const docId = rows[0].doc_id;

    const job = await resumeQueue.add('analyze', { doc_id: docId, s3Key, user_id, college_id, resume_text });
    res.json({ jobId: job.id, docId });
  } catch (err) { next(err); }
};


const getResult = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT analysis_json FROM documents 
       WHERE user_id = $1 AND college_id = $2 AND feature_name = 'resume_analyzer'
       ORDER BY created_at DESC LIMIT 1`,
      [user_id, college_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No analysis found' });
    
    const analysis = rows[0].analysis_json || {};
    res.json({ status: analysis.status || 'pending', result: analysis.result || null });
  } catch (err) { next(err); }
};

const getHistory = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT doc_id, s3_key, created_at, analysis_json FROM documents 
       WHERE user_id = $1 AND college_id = $2 AND feature_name = 'resume_analyzer'
       ORDER BY created_at DESC LIMIT 50`,
      [user_id, college_id]
    );
    res.json({ history: rows });
  } catch (err) { next(err); }
};

module.exports = { getUploadUrl, analyzeResume, getResult, getHistory };
