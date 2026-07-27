/**
 * AIInterviewerPage.jsx
 * TODO: Build UI here.
 * Use the corresponding service file for all API calls — never call axios/fetch directly in a page.
 * See _contracts/ for the full API contract before building.
 */
import { useState, useEffect, useRef } from 'react';
import { getOptions, startSession, getSession, submitAnswer, getTTS } from '../services/aiInterviewer.service';

export default function AIInterviewerPage() {
  const [options, setOptions] = useState(null);
  const [difficulty, setDifficulty] = useState('medium');
  const [selectedPracticeArea, setSelectedPracticeArea] = useState('');
  
  const [activeSession, setActiveSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  
  const recognitionRef = useRef(null);
  const chatEndRef = useRef(null);

  useEffect(() => {
    fetchOptions();
    
    if ('webkitSpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      
      recognitionRef.current.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        setAnswerText(transcript);
      };
      
      recognitionRef.current.onerror = (event) => {
        console.error('Speech recognition error', event.error);
        setIsRecording(false);
      };
    }
  }, []);

  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession]);

  const fetchOptions = async () => {
    try {
      const data = await getOptions();
      setOptions(data);
      if (data.filters?.practice_areas?.length) {
        setSelectedPracticeArea(data.filters.practice_areas[0]);
      }
    } catch(e) { console.error(e); }
  };

  const handleStart = async () => {
    setLoading(true);
    try {
      const data = await startSession({ difficulty, filters: { practice_area: selectedPracticeArea } });
      
      const interval = setInterval(async () => {
        try {
          const res = await getSession(data.session_id);
          if (res.status === 'active') {
            setActiveSession(res);
            clearInterval(interval);
            setLoading(false);
            if (res.questions && res.questions[0]) {
              playTTS(res.questions[0]);
            }
          }
        } catch (e) {
          clearInterval(interval);
          setLoading(false);
        }
      }, 2000);
    } catch(e) { 
      console.error(e); 
      setLoading(false);
    }
  };

  const toggleRecording = () => {
    if (!recognitionRef.current) return alert("Speech recognition not supported in this browser.");
    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
    } else {
      setAnswerText(''); 
      recognitionRef.current.start();
      setIsRecording(true);
    }
  };

  const handleSubmitAnswer = async () => {
    if (!answerText.trim() || !activeSession || loading) return;
    if (isRecording) toggleRecording();
    
    setLoading(true);
    try {
      const res = await submitAnswer({ session_id: activeSession.session_id, answer: answerText });
      
      const updatedTurns = [...(activeSession.turns || []), { speaker: 'user', text: answerText }];
      if (res.feedback) {
        updatedTurns.push({ speaker: 'ai', text: res.feedback });
      }
      
      const newSession = {
        ...activeSession,
        turns: updatedTurns,
        status: res.isComplete ? 'complete' : 'active',
        summary: res.summary || null
      };
      
      setActiveSession(newSession);
      setAnswerText('');
      
      if (res.nextQuestion && !res.isComplete) {
        playTTS(res.nextQuestion);
      }
      
    } catch(err) {
      console.error(err);
    }
    setLoading(false);
  };

  const playTTS = async (text) => {
    try {
      const res = await getTTS(text);
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const audio = new Audio(url);
      audio.play();
    } catch (e) {
      console.error("TTS failed", e);
    }
  };

  if (activeSession) {
    const isComplete = activeSession.status === 'complete';
    const currentQuestionIndex = (activeSession.turns?.filter(t => t.speaker === 'user')?.length || 0);
    const currentQuestion = activeSession.questions?.[currentQuestionIndex];

    return (
      <div style={{ padding: '2rem', maxWidth: '1000px', margin: '0 auto', color: 'var(--text-primary)', height: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
          <h2>AI Interview <span style={{ color: 'var(--accent-color)', fontSize: '1rem' }}>({selectedPracticeArea})</span></h2>
          <button onClick={() => setActiveSession(null)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', padding: '0.5rem 1rem', borderRadius: '8px', cursor: 'pointer' }}>End Interview</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.5rem', marginBottom: '2rem' }}>
          {activeSession.turns?.map((turn, i) => (
            <div key={i} style={{ 
              alignSelf: turn.speaker === 'user' ? 'flex-end' : 'flex-start',
              background: turn.speaker === 'user' ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
              color: turn.speaker === 'user' ? '#fff' : 'var(--text-primary)',
              padding: '1.5rem',
              borderRadius: '12px',
              maxWidth: '80%',
              border: turn.speaker === 'ai' ? '1px solid var(--border-color)' : 'none'
            }}>
              <small style={{ display: 'block', marginBottom: '0.5rem', opacity: 0.7, textTransform: 'uppercase', fontWeight: 'bold' }}>
                {turn.speaker === 'user' ? 'Your Answer' : 'Feedback'}
              </small>
              <p style={{ lineHeight: '1.6' }}>{turn.text}</p>
            </div>
          ))}

          {isComplete && activeSession.summary && (
            <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '2px solid var(--accent-color)', marginTop: '2rem', textAlign: 'center' }}>
              <h2 style={{ color: 'var(--accent-color)', marginBottom: '1rem' }}>Interview Complete!</h2>
              <p style={{ lineHeight: '1.6' }}>{activeSession.summary}</p>
            </div>
          )}

          {!isComplete && currentQuestion && (
            <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--accent-color)' }}>
              <small style={{ color: 'var(--accent-color)', fontWeight: 'bold', textTransform: 'uppercase' }}>Current Question {currentQuestionIndex + 1} / {activeSession.questions?.length}</small>
              <h3 style={{ marginTop: '0.5rem', fontSize: '1.5rem', lineHeight: '1.4' }}>{currentQuestion}</h3>
              <button onClick={() => playTTS(currentQuestion)} style={{ marginTop: '1rem', background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Listen to question</button>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {!isComplete && (
          <div style={{ background: 'var(--surface-color)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <textarea 
                value={answerText}
                onChange={e => setAnswerText(e.target.value)}
                placeholder="Type your answer, or use the microphone to speak..."
                style={{ flex: 1, height: '100px', padding: '1rem', background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', resize: 'vertical' }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <button 
                  onClick={toggleRecording} 
                  style={{ padding: '1rem', background: isRecording ? '#ff4444' : 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', width: '120px' }}>
                  {isRecording ? 'Stop Mic' : 'Start Mic'}
                </button>
                <button 
                  onClick={handleSubmitAnswer} 
                  disabled={loading || !answerText.trim()} 
                  style={{ padding: '1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', width: '120px' }}>
                  {loading ? 'Sending...' : 'Submit'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', color: 'var(--text-primary)' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', background: 'linear-gradient(45deg, #fff, #888)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        AI Interviewer
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Practice oral arguments and interview questions using voice or text.</p>

      {options ? (
        <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)', maxWidth: '600px' }}>
          <h2 style={{ marginBottom: '1.5rem' }}>Setup Interview</h2>
          
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Practice Area</label>
          <select value={selectedPracticeArea} onChange={e => setSelectedPracticeArea(e.target.value)} style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', marginBottom: '1.5rem' }}>
            {options.filters?.practice_areas?.map(pa => (
              <option key={pa} value={pa}>{pa}</option>
            ))}
          </select>

          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Difficulty</label>
          <select value={difficulty} onChange={e => setDifficulty(e.target.value)} style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', marginBottom: '2rem' }}>
            {options.difficulties?.map(d => (
              <option key={d} value={d}>{d.toUpperCase()}</option>
            ))}
          </select>

          <button onClick={handleStart} disabled={loading} style={{ width: '100%', padding: '1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1rem' }}>
            {loading ? 'Preparing Questions via AI...' : 'Start Interview'}
          </button>
        </div>
      ) : (
        <p>Loading interview options...</p>
      )}
    </div>
  );
}
