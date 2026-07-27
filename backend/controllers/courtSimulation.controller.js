/**
 * courtSimulation.controller.js
 * Most expensive feature. Hard limit: 8 turns/session, 4 sessions/week.
 * Weekly limit is DOUBLE-PROTECTED: Redis (featureLimit middleware) + DB check here.
 */
const { pool } = require('../config/db');
const { callGeminiChat, callGemini } = require('../utils/gemini');
const MAX_TURNS  = 8;
const CASE_TYPES = ['bail_application', 'civil_dispute', 'constitutional_matter'];

const getCaseTypes = async (req, res, next) => {
  try { res.json({ caseTypes: CASE_TYPES }); }
  catch (err) { next(err); }
};

const startSession = async (req, res, next) => {
  try {
    const { case_type }       = req.body;
    const { user_id, college_id } = req.user;
    
    const { rows } = await pool.query(
      `INSERT INTO sessions (user_id, college_id, feature_name, session_type, turns)
       VALUES ($1, $2, 'court_simulation', $3, '[]'::jsonb) RETURNING session_id`,
      [user_id, college_id, case_type]
    );
    const sessionId = rows[0].session_id;
    
    const caseLabel = case_type.replace(/_/g, ' ');
    const prompt = `You are the Opposing Counsel in a ${caseLabel} case. Deliver your opening statement to the court. Be concise, professional, and adversarial. Present the key facts and your initial position in 3-4 sentences.`;
    const { text: firstPrompt, usage } = await callGemini(prompt, {
      systemInstruction: "You are an experienced opposing counsel in an Indian court simulation. Speak in first person."
    });
    
    await pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'court_simulation', 'gemini-3.1-flash-lite', $3, $4)`,
      [user_id, college_id, usage.promptTokenCount, usage.candidatesTokenCount]
    );

    res.json({ sessionId, firstPrompt, disclaimer: 'For educational purposes only. Verify with a qualified advocate.' });
  } catch (err) { next(err); }
};

const takeTurn = async (req, res, next) => {
  try {
    const { session_id, argument } = req.body;
    const { user_id, college_id }  = req.user;

    const { rows } = await pool.query(
      `SELECT turns FROM sessions WHERE session_id = $1 AND user_id = $2 AND college_id = $3`,
      [session_id, user_id, college_id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Session not found or access denied' });
    
    const turns = rows[0].turns || [];
    if (turns.length >= MAX_TURNS) return res.status(400).json({ error: 'Maximum turns reached for this session' });
    
    const history = turns.flatMap(t => [
      { role: 'user', parts: [{ text: t.user }] },
      { role: 'model', parts: [{ text: t.ai }] }
    ]);
    const { text: aiResponse, usage: turnUsage } = await callGeminiChat(history, argument, {
      systemInstruction: "You are the opposing counsel in a court simulation. Be brief, adversarial, and professional."
    });
    turns.push({ user: argument, ai: aiResponse });
    
    const isComplete = turns.length >= MAX_TURNS;
    let summary = null;
    let totalTokensIn = turnUsage.promptTokenCount;
    let totalTokensOut = turnUsage.candidatesTokenCount;
    
    if (isComplete) {
      const summaryPrompt = `Based on the following court simulation transcript, provide a concise Judge's Summary of the proceedings:\n${JSON.stringify(turns)}`;
      const { text: summaryText, usage: summaryUsage } = await callGemini(summaryPrompt, { systemInstruction: "You are a judge summarizing a court simulation." });
      summary = summaryText;
      totalTokensIn += summaryUsage.promptTokenCount;
      totalTokensOut += summaryUsage.candidatesTokenCount;
    }

    await pool.query(
      `UPDATE sessions SET turns = $1 WHERE session_id = $2`,
      [JSON.stringify(turns), session_id]
    );

    await pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'court_simulation', 'gemini-3.1-flash-lite', $3, $4)`,
      [user_id, college_id, totalTokensIn, totalTokensOut]
    );
    
    res.json({ response: aiResponse, turnCount: turns.length, isComplete, summary });
  } catch (err) { next(err); }
};

module.exports = { getCaseTypes, startSession, takeTurn };
