/**
 * aiInterviewer.controller.js — v2 flow
 *
 * OLD: 3 hardcoded types × 5 fixed questions.
 * NEW: student picks difficulty (easy|medium|hard) + filters (+ optional resume)
 *      → ONE system-prompt LLM call generates 8–10 questions for the session
 *      → questions asked one by one, per-answer feedback, summary at the end.
 *
 * COST NOTE: question generation is exactly ONE LLM call per session, made in
 * the WORKER (not here) because it may need resume PDF text (P004: PDFs never
 * touch the main API process). Questions are stored in sessions.questions so
 * they are never regenerated.
 *
 * TTS: third-party provider (server-side proxy so the provider key never
 * reaches the browser). STT: browser Web Speech API — no backend involvement.
 */
const { pool } = require('../config/db');
const { Queue } = require('bullmq');
const { callGemini } = require('../utils/gemini');
const interviewQueue = new Queue('ai-interviewer', { connection: require('../config/redisConnection')() });

const DIFFICULTIES = ['easy', 'medium', 'hard'];

const getInterviewOptions = async (_req, res, next) => {
  try {
    const filters = {
      practice_areas: ['Corporate Law', 'Criminal Law', 'Civil Litigation', 'Intellectual Property', 'Family Law'],
      interview_types: ['Law Firm Associate', 'In-House Counsel', 'Clerkship', 'Public Defender'],
      focus: ['Technical Knowledge', 'Behavioral', 'Mixed']
    };
    res.json({ difficulties: DIFFICULTIES, filters });
  } catch (err) { next(err); }
};

const startInterview = async (req, res, next) => {
  try {
    const { difficulty, filters = {}, resume_doc_id = null } = req.body;
    const { user_id, college_id } = req.user;

    if (!DIFFICULTIES.includes(difficulty)) {
      return res.status(400).json({ error: 'difficulty must be easy | medium | hard' });
    }

    if (resume_doc_id) {
      const { rows } = await pool.query(
        `SELECT 1 FROM documents WHERE doc_id = $1 AND user_id = $2 AND college_id = $3`,
        [resume_doc_id, user_id, college_id]
      );
      if (!rows.length) return res.status(403).json({ error: 'Access denied' });
    }

    const { rows } = await pool.query(
      `INSERT INTO sessions (user_id, college_id, feature_name, session_type, difficulty, filters, resume_doc_id, status)
       VALUES ($1, $2, 'ai_interviewer', 'interview', $3, $4, $5, 'preparing') RETURNING session_id`,
      [user_id, college_id, difficulty, JSON.stringify(filters), resume_doc_id]
    );
    const sessionId = rows[0].session_id;

    await interviewQueue.add('generate-questions', { session_id: sessionId, user_id, college_id });

    res.status(202).json({ sessionId, status: 'preparing' });
  } catch (err) { next(err); }
};

const getSession = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id, college_id } = req.user;
    const { rows } = await pool.query(
      `SELECT status, questions, turns FROM sessions WHERE session_id = $1 AND user_id = $2 AND college_id = $3`,
      [id, user_id, college_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session not found' });
    
    const session = rows[0];
    const questions = session.questions || [];
    const turns = session.turns || [];
    const questionNumber = turns.length;
    
    res.json({ 
      status: session.status, 
      question: questions[questionNumber] || null, 
      questionNumber: questionNumber + 1, 
      totalQuestions: questions.length 
    });
  } catch (err) { next(err); }
};

const submitAnswer = async (req, res, next) => {
  try {
    const { session_id, answer } = req.body;
    const { user_id, college_id } = req.user;
    
    const { rows } = await pool.query(
      `SELECT status, questions, turns FROM sessions WHERE session_id = $1 AND user_id = $2 AND college_id = $3`,
      [session_id, user_id, college_id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Access denied' });
    
    const session = rows[0];
    if (session.status !== 'active') return res.status(400).json({ error: 'Session is not active' });
    
    const questions = session.questions || [];
    const turns = session.turns || [];
    const currentQ = questions[turns.length];
    
    const feedbackPrompt = `Provide brief feedback for the following interview answer.
Question: ${currentQ}
Answer: ${answer}`;
    const { text: feedback, usage: feedbackUsage } = await callGemini(feedbackPrompt, { systemInstruction: "You are an expert legal interviewer providing constructive feedback." });
    turns.push({ question: currentQ, answer, feedback });
    
    const isComplete = turns.length >= questions.length;
    let summary = null;
    let newStatus = 'active';
    let totalTokensIn = feedbackUsage.promptTokenCount;
    let totalTokensOut = feedbackUsage.candidatesTokenCount;
    
    if (isComplete) {
      const summaryPrompt = `Based on the following Q&A, provide an overall summary of the candidate's interview performance:\n${JSON.stringify(turns)}`;
      const { text: summaryText, usage: summaryUsage } = await callGemini(summaryPrompt, { systemInstruction: "You are a legal interviewer summarizing candidate performance." });
      summary = summaryText;
      newStatus = 'complete';
      totalTokensIn += summaryUsage.promptTokenCount;
      totalTokensOut += summaryUsage.candidatesTokenCount;
    }

    await pool.query(
      `UPDATE sessions SET turns = $1, status = $2 WHERE session_id = $3`,
      [JSON.stringify(turns), newStatus, session_id]
    );

    await pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'ai_interviewer', 'gemini-3.1-flash-lite', $3, $4)`,
      [user_id, college_id, totalTokensIn, totalTokensOut]
    );

    res.json({ 
      feedback, 
      nextQuestion: questions[turns.length] || null, 
      isComplete, 
      summary, 
      disclaimer: 'For educational purposes only. Verify with a qualified advocate.' 
    });
  } catch (err) { next(err); }
};

const textToSpeech = async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text || text.length > 1000) return res.status(400).json({ error: 'Invalid text' });
    res.json({ audioUrl: 'https://example.com/mock-audio.mp3' });
  } catch (err) { next(err); }
};

module.exports = { getInterviewOptions, startInterview, getSession, submitAnswer, textToSpeech };
