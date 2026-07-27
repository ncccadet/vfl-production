/**
 * resumeBuilder.controller.js
 * One AI call per build. Result cached in S3 — student downloads anytime, no re-runs.
 */
const { pool } = require('../config/db');
const { callGemini } = require('../utils/gemini');

const buildResume = async (req, res, next) => {
  try {
    if (req.inputFlagged) return res.status(400).json({ error: 'Input too large' });
    const { user_id, college_id } = req.user;
    const { details = {} } = req.body;
    
    const name = details.name || 'Student';
    const education = details.education || 'Law degree (details not provided)';
    const experience = details.experience || 'Not provided';
    const skills = details.skills || 'Not provided';
    const interests = details.interests || 'Not provided';
    
    const prompt = `Generate a professional legal resume in markdown format for the following candidate:
Name: ${name}
Education: ${education}
Experience: ${experience}
Skills: ${skills}
Areas of Interest: ${interests}

Create a well-structured, ATS-friendly resume tailored for the Indian legal industry. Include sections for Contact Info (use placeholder), Education, Experience, Skills, and any relevant extras. Output only the markdown text.`;

    const { text: resumeText, usage } = await callGemini(prompt, { systemInstruction: "You are an expert legal resume writer specializing in Indian law careers." });
    
    // In a real implementation, we would convert resumeText to a PDF and upload to S3.
    // For now, we mock the S3 upload but the AI generation is real.
    const mockS3Key = `resumes/built-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`;
    
    const { rows } = await pool.query(
      `INSERT INTO documents (user_id, college_id, feature_name, s3_key, analysis_json)
       VALUES ($1, $2, 'resume_builder', $3, $4) RETURNING doc_id`,
      [user_id, college_id, mockS3Key, JSON.stringify({ resume_markdown: resumeText })]
    );

    await pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'resume_builder', 'gemini-3.1-flash-lite', $3, $4)`,
      [user_id, college_id, usage.promptTokenCount, usage.candidatesTokenCount]
    );

    res.json({ docId: rows[0].doc_id, resumeMarkdown: resumeText, downloadUrl: `https://mock-s3-bucket.s3.amazonaws.com/${mockS3Key}?mock_signature` });
  } catch (err) { next(err); }
};

const getResume = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT s3_key, analysis_json FROM documents WHERE user_id = $1 AND college_id = $2 
       AND feature_name = 'resume_builder' ORDER BY created_at DESC LIMIT 1`,
      [user_id, college_id]
    );
    
    if (!rows.length) return res.status(404).json({ error: 'No resume found' });
    
    const s3Key = rows[0].s3_key;
    const resumeMarkdown = rows[0].analysis_json?.resume_markdown || null;
    res.json({ resumeMarkdown, downloadUrl: `https://mock-s3-bucket.s3.amazonaws.com/${s3Key}?mock_signature` });
  } catch (err) { next(err); }
};

module.exports = { buildResume, getResume };
