/**
 * examPrep.controller.js — v2: MCQ + long-form written answers
 *
 * STILL ZERO AI COST AT QUERY TIME:
 * - MCQ explanations pre-generated offline (unchanged)
 * - Long-form "comparing answer sheets" (model_answer) are pre-written and
 *   stored in exam_content. When WE generate our own papers (content_source=
 *   'generated'), the model answer is generated OFFLINE at authoring time —
 *   never per student, never per attempt.
 * - Analytics computed from exam_attempts by SQL, no AI.
 */
const { pool } = require('../config/db');

const getQuestions = async (req, res, next) => {
  try {
    const { exam_type, format = 'mcq' } = req.query; // format: mcq | long_form | mixed
    let query = `
      SELECT question_id, question_format, question, options_json
      FROM exam_content 
      WHERE exam_type = $1
    `;
    const params = [exam_type];
    
    if (format !== 'mixed') {
      query += ` AND question_format = $2`;
      params.push(format);
    }
    
    query += ` ORDER BY RANDOM() LIMIT 10`;
    
    const { rows } = await pool.query(query, params);
    res.json({ questions: rows });
  } catch (err) { next(err); }
};

const submitAttempt = async (req, res, next) => {
  try {
    const { exam_type, answers } = req.body; // [{question_id, selected_option | answer_text}]
    const { user_id, college_id } = req.user;
    
    if (!answers || answers.length === 0) return res.json({ attemptId: null, score: 0, results: [] });
    const questionIds = answers.map(a => a.question_id);

    const { rows: questions } = await pool.query(
      `SELECT question_id, question_format, correct_answer, model_answer, explanation 
       FROM exam_content WHERE question_id = ANY($1::uuid[])`,
      [questionIds]
    );

    const questionMap = questions.reduce((acc, q) => {
      acc[q.question_id] = q;
      return acc;
    }, {});

    let score = 0;
    const results = answers.map(a => {
      const q = questionMap[a.question_id];
      if (!q) return null;

      let isCorrect = null;
      if (q.question_format === 'mcq') {
        isCorrect = (a.selected_option === q.correct_answer);
        if (isCorrect) score++;
      }
      return {
        question_id: a.question_id,
        is_correct: isCorrect,
        correct_answer: q.correct_answer,
        model_answer: q.model_answer,
        explanation: q.explanation,
        user_answer: a.selected_option || a.answer_text
      };
    }).filter(Boolean);

    const { rows: attemptRows } = await pool.query(
      `INSERT INTO exam_attempts (user_id, college_id, exam_type, answers, score) 
       VALUES ($1, $2, $3, $4, $5) RETURNING attempt_id`,
      [user_id, college_id, exam_type, JSON.stringify(results), score]
    );

    await pool.query(
      `INSERT INTO feature_usage (user_id, college_id, feature_name, used_date, count, score)
       VALUES ($1, $2, 'exam_prep', CURRENT_DATE, 1, $3)
       ON CONFLICT (user_id, feature_name, used_date)
       DO UPDATE SET count = feature_usage.count + 1, score = GREATEST(feature_usage.score, $3)`,
      [user_id, college_id, score]
    );

    res.json({ attemptId: attemptRows[0].attempt_id, score, results });
  } catch (err) { next(err); }
};

const getAnalytics = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const { rows: typeRows } = await pool.query(
      `SELECT exam_type, COUNT(*) as attempts, MAX(score) as best_score, ROUND(AVG(score), 2) as avg_score 
       FROM exam_attempts WHERE user_id = $1 AND college_id = $2 GROUP BY exam_type`,
      [user_id, college_id]
    );

    const { rows: trendRows } = await pool.query(
      `SELECT DATE(created_at) as date, ROUND(AVG(score), 2) as daily_avg 
       FROM exam_attempts WHERE user_id = $1 AND college_id = $2 
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [user_id, college_id]
    );

    res.json({
      attempts: typeRows.reduce((sum, row) => sum + parseInt(row.attempts), 0),
      byExamType: typeRows,
      trend: trendRows
    });
  } catch (err) { next(err); }
};

module.exports = { getQuestions, submitAttempt, getAnalytics };
