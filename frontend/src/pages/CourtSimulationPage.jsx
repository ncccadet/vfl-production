/**
 * CourtSimulationPage.jsx
 * TODO: Build UI here.
 * Use the corresponding service file for all API calls — never call axios/fetch directly in a page.
 * See _contracts/ for the full API contract before building.
 */
import { useState, useEffect, useRef } from 'react';
import { getSession, startSession, getHistory, submitArgument } from '../services/courtSimulation.service';

export default function CourtSimulationPage() {
  const [activeSession, setActiveSession] = useState(null);
  const [history, setHistory] = useState([]);
  const [topic, setTopic] = useState('');
  const [side, setSide] = useState('plaintiff');
  const [loading, setLoading] = useState(false);
  const [argument, setArgument] = useState('');
  const chatEndRef = useRef(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.turns]);

  const fetchHistory = async () => {
    try {
      const data = await getHistory();
      setHistory(data.history || []);
    } catch(e) { console.error(e); }
  };

  const handleStart = async () => {
    if (!topic) return;
    setLoading(true);
    try {
      const data = await startSession({ topic, side });
      setActiveSession(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleResume = async (sessionId) => {
    setLoading(true);
    try {
      const data = await getSession(sessionId);
      setActiveSession(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleSubmitArg = async (e) => {
    e.preventDefault();
    if (!argument.trim() || !activeSession || loading) return;
    setLoading(true);
    try {
      const res = await submitArgument({ session_id: activeSession.session_id, argument });
      const updatedTurns = [...(activeSession.turns || []), { speaker: 'user', text: argument }];
      
      if (res.judge_interjection) {
        updatedTurns.push({ speaker: 'judge', text: res.judge_interjection });
      }
      if (res.ai_response) {
        updatedTurns.push({ speaker: 'ai', text: res.ai_response });
      }
      
      setActiveSession({
        ...activeSession,
        turns: updatedTurns,
        status: res.status || activeSession.status,
        judge_summary: res.judge_summary || null
      });
      setArgument('');
    } catch(err) {
      console.error(err);
    }
    setLoading(false);
  };

  if (activeSession) {
    const isComplete = activeSession.status === 'complete' || (activeSession.turns?.length || 0) >= 8;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', maxWidth: '1000px', margin: '0 auto', padding: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2>Courtroom: <span style={{ color: 'var(--accent-color)' }}>{activeSession.topic}</span></h2>
          <button onClick={() => setActiveSession(null)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', padding: '0.5rem 1rem', borderRadius: '8px', cursor: 'pointer' }}>Exit Simulation</button>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ flex: 1, height: '6px', borderRadius: '3px', background: i < (activeSession.turns?.length || 0) ? 'var(--accent-color)' : 'var(--border-color)' }} />
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--surface-color)', borderRadius: '12px', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', border: '1px solid var(--border-color)' }}>
          {(!activeSession.turns || activeSession.turns.length === 0) && (
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontStyle: 'italic', marginTop: '2rem' }}>The Judge has entered the courtroom. You may present your opening statement.</p>
          )}
          {activeSession.turns?.map((turn, i) => (
            <div key={i} style={{ 
              alignSelf: turn.speaker === 'user' ? 'flex-end' : 'flex-start',
              background: turn.speaker === 'user' ? 'var(--accent-color)' : turn.speaker === 'judge' ? '#444' : 'rgba(255,255,255,0.05)',
              color: turn.speaker === 'user' ? '#fff' : 'var(--text-primary)',
              padding: '1rem',
              borderRadius: '12px',
              maxWidth: '80%',
              border: turn.speaker === 'judge' ? '1px solid #666' : 'none'
            }}>
              <small style={{ display: 'block', marginBottom: '0.5rem', opacity: 0.7, textTransform: 'uppercase', fontWeight: 'bold' }}>
                {turn.speaker === 'user' ? 'You' : turn.speaker === 'judge' ? 'The Honorable Judge' : 'Opposing Counsel (AI)'}
              </small>
              <p style={{ lineHeight: '1.5' }}>{turn.text}</p>
            </div>
          ))}
          {activeSession.judge_summary && (
            <div style={{ alignSelf: 'center', background: 'var(--surface-color)', border: '2px solid var(--accent-color)', padding: '1.5rem', borderRadius: '12px', width: '90%', marginTop: '2rem' }}>
              <h3 style={{ color: 'var(--accent-color)', marginBottom: '1rem', textAlign: 'center' }}>Final Ruling</h3>
              <p style={{ lineHeight: '1.6' }}>{activeSession.judge_summary}</p>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {!isComplete && (
          <form onSubmit={handleSubmitArg} style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
            <input 
              type="text" 
              value={argument}
              onChange={e => setArgument(e.target.value)}
              placeholder="Present your legal argument..."
              style={{ flex: 1, padding: '1rem', background: 'var(--surface-color)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '1rem' }}
            />
            <button type="submit" disabled={loading || !argument.trim()} style={{ padding: '0 2rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
              {loading ? 'Presenting...' : 'Argue'}
            </button>
          </form>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', color: 'var(--text-primary)' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', background: 'linear-gradient(45deg, #fff, #888)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        Virtual Court Simulation
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Practice your litigation skills against an AI opposing counsel in front of an AI Judge.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '2rem' }}>
        <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <h2 style={{ marginBottom: '1.5rem' }}>Start New Simulation</h2>
          
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Case Topic / Fact Pattern</label>
          <textarea 
            value={topic}
            onChange={e => setTopic(e.target.value)}
            placeholder="E.g., Breach of contract regarding late delivery of goods..."
            style={{ width: '100%', height: '100px', padding: '1rem', background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', marginBottom: '1.5rem', resize: 'vertical' }}
          />

          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Your Role</label>
          <select value={side} onChange={e => setSide(e.target.value)} style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', marginBottom: '2rem' }}>
            <option value="plaintiff">Plaintiff (Prosecution)</option>
            <option value="defendant">Defendant (Defense)</option>
          </select>

          <button onClick={handleStart} disabled={loading || !topic} style={{ width: '100%', padding: '1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1rem' }}>
            {loading ? 'Entering Courtroom...' : 'Start Simulation'}
          </button>
        </div>

        <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <h2 style={{ marginBottom: '1.5rem' }}>Past Sessions</h2>
          {history.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No past sessions found.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {history.map(s => (
                <div key={s.session_id} style={{ padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h4 style={{ marginBottom: '0.25rem' }}>{s.topic}</h4>
                    <small style={{ color: 'var(--text-secondary)' }}>Role: {s.side} • Status: {s.status}</small>
                  </div>
                  <button onClick={() => handleResume(s.session_id)} style={{ padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', borderRadius: '6px', cursor: 'pointer' }}>
                    {s.status === 'active' ? 'Resume' : 'View'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
