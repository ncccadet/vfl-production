/**
 * AIInterviewerPage.jsx
 * Contract: _contracts/06-ai-interviewer.md
 *
 * Flow: pick difficulty + focus → grant mic & camera → interview (question read
 * aloud, student answers by voice with live transcript + voice-level meter;
 * camera preview stays on for presence) → summary (correctness, efficiency,
 * confidence, clarity, voice level).
 *
 * Speech is browser-native: SpeechRecognition (STT) + speechSynthesis (TTS).
 * Voice level is measured with the Web Audio API. No audio/video leaves the browser.
 * Theme: black/grey serif, responsive.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { getOptions, startSession, getSession, submitAnswer, finishSession } from '../services/aiInterviewer.service';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const POLL_MS = 2000;

export default function AIInterviewerPage() {
  const [phase, setPhase] = useState('setup'); // setup | permissions | preparing | interview | finishing | summary
  const [difficulty, setDifficulty] = useState('easy');
  const [focus, setFocus] = useState('General');
  const [focusAreas, setFocusAreas] = useState(['General']);
  const [error, setError] = useState('');

  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);

  const [sessionId, setSessionId] = useState('');
  const [questions, setQuestions] = useState([]);
  const [idx, setIdx] = useState(0);
  const [answerText, setAnswerText] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(null);

  // refs for media + timing
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const meterRef = useRef({ sum: 0, count: 0 });
  const recognitionRef = useRef(null);
  const answerStartRef = useRef(0);
  const pollRef = useRef(null);

  useEffect(() => {
    getOptions().then(({ data }) => { setFocusAreas(data.focusAreas || ['General']); }).catch(() => {});
    return () => cleanupMedia();
  }, []);

  // Attach the camera stream to the preview whenever it renders.
  useEffect(() => {
    if (videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current;
  });

  const cleanupMedia = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    try { recognitionRef.current && recognitionRef.current.stop(); } catch {}
    try { audioCtxRef.current && audioCtxRef.current.close(); } catch {}
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  };

  // ── permissions ─────────────────────────────────────────────────────────
  const requestMedia = async () => {
    setError('');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      setMicOn(true); setCamOn(true);
    } catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); setMicOn(true); setCamOn(false); }
      catch { setError('Microphone access is required to take the interview. Please allow it and try again.'); return; }
    }
    streamRef.current = stream;
    // set up the voice-level analyser from the audio track
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      audioCtxRef.current = ctx; analyserRef.current = analyser;
    } catch {}
    if (videoRef.current) videoRef.current.srcObject = stream;
  };

  // ── voice metering ──────────────────────────────────────────────────────
  const startMeter = () => {
    meterRef.current = { sum: 0, count: 0 };
    const analyser = analyserRef.current;
    if (!analyser) return;
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const level = Math.min(100, Math.round(rms * 320)); // scale RMS → 0-100
      setVoiceLevel(level);
      meterRef.current.sum += level; meterRef.current.count += 1;
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };
  const stopMeter = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setVoiceLevel(0);
    const { sum, count } = meterRef.current;
    return count ? Math.round(sum / count) : 0;
  };

  // ── speech recognition ──────────────────────────────────────────────────
  const startRecognition = () => {
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'en-IN'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = (e) => {
      let finalTxt = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalTxt += e.results[i][0].transcript + ' ';
      }
      if (finalTxt) setAnswerText((prev) => (prev ? prev + ' ' : '') + finalTxt.trim());
    };
    rec.onend = () => { if (recordingRef.current) { try { rec.start(); } catch {} } };
    recognitionRef.current = rec;
    try { rec.start(); } catch {}
  };
  const recordingRef = useRef(false);
  const stopRecognition = () => { recordingRef.current = false; try { recognitionRef.current && recognitionRef.current.stop(); } catch {} };

  // ── TTS ─────────────────────────────────────────────────────────────────
  const speak = (text) => {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN'; u.rate = 1;
    window.speechSynthesis.speak(u);
  };

  // ── flow ────────────────────────────────────────────────────────────────
  const onBeginInterview = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await startSession({ difficulty, focus });
      setSessionId(data.sessionId);
      if (data.status === 'active') {
        // hard tier — Q1 already present; fetch it
        const s = await getSession(data.sessionId);
        setQuestions(s.data.questions || []);
        setIdx(0); setPhase('interview'); setAnswerText('');
        speak((s.data.questions || [])[0]);
      } else {
        setPhase('preparing'); pollForQuestions(data.sessionId);
      }
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not start the interview.');
      setPhase('permissions');
    } finally { setBusy(false); }
  };

  const pollForQuestions = (sid) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await getSession(sid);
        if (data.status === 'active') {
          clearInterval(pollRef.current);
          setQuestions(data.questions || []);
          setIdx(0); setPhase('interview'); setAnswerText('');
          speak((data.questions || [])[0]);
        } else if (data.status === 'failed') {
          clearInterval(pollRef.current); setPhase('permissions');
          setError('Could not prepare your interview. Please try again.');
        }
      } catch { clearInterval(pollRef.current); setPhase('permissions'); setError('Connection problem. Please try again.'); }
    }, POLL_MS);
  };

  const toggleRecord = () => {
    if (recording) {
      // stop
      setRecording(false); recordingRef.current = false;
      stopRecognition();
      const avg = stopMeter();
      meterRef.current.avg = avg;
    } else {
      setRecording(true); recordingRef.current = true;
      answerStartRef.current = Date.now();
      startMeter(); startRecognition();
    }
  };

  const onSubmitAnswer = async () => {
    setBusy(true); setError('');
    if (recording) toggleRecord();
    const durationSec = answerStartRef.current ? Math.round((Date.now() - answerStartRef.current) / 1000) : 0;
    const wordCount = answerText.trim().split(/\s+/).filter(Boolean).length;
    const voiceAvg = meterRef.current.avg || 0;
    try {
      const { data } = await submitAnswer({
        session_id: sessionId, index: idx, answer: answerText,
        voiceLevel: voiceAvg, durationSec, wordCount,
      });
      meterRef.current.avg = 0;
      if (data.done) { await onFinish(); return; }
      // advance
      let nextList = questions;
      if (data.nextQuestion) { nextList = [...questions, data.nextQuestion]; setQuestions(nextList); }
      const nextIdx = data.questionIndex;
      setIdx(nextIdx); setAnswerText('');
      speak(nextList[nextIdx]);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not submit your answer.');
    } finally { setBusy(false); }
  };

  const onFinish = async () => {
    setPhase('finishing'); setBusy(true);
    try {
      const { data } = await finishSession(sessionId);
      setSummary(data.result); setPhase('summary');
      cleanupMedia();
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not generate your summary.');
      setPhase('interview');
    } finally { setBusy(false); }
  };

  const restart = () => { cleanupMedia(); setPhase('setup'); setSessionId(''); setQuestions([]); setIdx(0); setAnswerText(''); setSummary(null); setMicOn(false); setCamOn(false); setError(''); };

  const totalQ = 10;
  const currentQuestion = questions[idx] || '';

  return (
    <div className="iv-root">
      <style>{STYLES}</style>
      <div className="iv-container">
        <header className="iv-header">
          <div>
            <h1 className="iv-title">AI Interviewer</h1>
            <p className="iv-subtitle">A live mock legal interview with instant feedback.</p>
          </div>
          <span className="iv-badge">4 interviews / week</span>
        </header>

        {error && <div className="iv-card iv-error" role="alert">{error}</div>}

        {/* SETUP */}
        {phase === 'setup' && (
          <section className="iv-card">
            <h2 className="iv-h2">Choose difficulty</h2>
            <div className="iv-chips">
              {[['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard — adaptive, live']].map(([id, lbl]) => (
                <button key={id} className={`iv-chip ${difficulty === id ? 'sel' : ''}`} onClick={() => setDifficulty(id)}>{lbl}</button>
              ))}
            </div>
            <h2 className="iv-h2">Focus area</h2>
            <div className="iv-chips">
              {focusAreas.map((f) => <button key={f} className={`iv-chip ${focus === f ? 'sel' : ''}`} onClick={() => setFocus(f)}>{f}</button>)}
            </div>
            <p className="iv-muted">Up to 10 questions. The AI reads each question aloud; you answer by voice. We measure your voice level, confidence and clarity.</p>
            <div className="iv-actions"><button className="iv-btn iv-primary" onClick={() => setPhase('permissions')}>Continue →</button></div>
          </section>
        )}

        {/* PERMISSIONS */}
        {phase === 'permissions' && (
          <section className="iv-card">
            <h2 className="iv-h2">Turn on your microphone and camera</h2>
            <p className="iv-muted">The interview needs your microphone to hear your answers, and your camera stays on for presence. Nothing is recorded or uploaded — audio and video stay in your browser.</p>
            <div className="iv-perm">
              <div className="iv-preview">
                {camOn ? <video ref={videoRef} autoPlay muted playsInline className="iv-video" /> : <div className="iv-video iv-video-off">Camera preview</div>}
              </div>
              <div className="iv-perm-status">
                <div className={`iv-pill ${micOn ? 'ok' : ''}`}>{micOn ? '✓ Microphone on' : 'Microphone off'}</div>
                <div className={`iv-pill ${camOn ? 'ok' : ''}`}>{camOn ? '✓ Camera on' : 'Camera off'}</div>
                {!SR && <p className="iv-muted">Note: your browser doesn’t support speech-to-text; you can type your answers instead.</p>}
              </div>
            </div>
            <div className="iv-actions">
              {!micOn ? <button className="iv-btn iv-primary" onClick={requestMedia}>Allow mic & camera</button>
                      : <button className="iv-btn iv-primary" onClick={onBeginInterview} disabled={busy}>{busy ? 'Starting…' : 'Start interview →'}</button>}
              <button className="iv-btn iv-ghost" onClick={() => setPhase('setup')} disabled={busy}>Back</button>
            </div>
          </section>
        )}

        {/* PREPARING */}
        {phase === 'preparing' && (
          <section className="iv-card iv-status"><span className="iv-spinner" />Preparing your {difficulty} interview…</section>
        )}

        {/* INTERVIEW */}
        {phase === 'interview' && (
          <section className="iv-card">
            <div className="iv-qbar">
              <span className="iv-qnum">Question {idx + 1}{difficulty !== 'hard' ? ` of ${questions.length}` : ` / up to ${totalQ}`}</span>
              {camOn && <video ref={videoRef} autoPlay muted playsInline className="iv-video-mini" />}
            </div>
            <p className="iv-question">{currentQuestion}</p>
            <div className="iv-answer-tools">
              <button className={`iv-btn ${recording ? 'iv-rec' : 'iv-primary'}`} onClick={toggleRecord} disabled={busy}>
                {recording ? '⏹ Stop' : '🎤 Start answering'}
              </button>
              <button className="iv-btn iv-ghost iv-small" onClick={() => speak(currentQuestion)} disabled={busy}>🔊 Repeat question</button>
              {recording && (
                <div className="iv-meter" title="voice level"><div className="iv-meter-fill" style={{ width: `${voiceLevel}%` }} /></div>
              )}
            </div>
            <textarea className="iv-textarea" rows={5} value={answerText} placeholder={SR ? 'Your spoken answer appears here — you can edit it.' : 'Type your answer here.'} onChange={(e) => setAnswerText(e.target.value)} />
            <div className="iv-actions">
              <button className="iv-btn iv-primary" onClick={onSubmitAnswer} disabled={busy || !answerText.trim()}>
                {busy ? 'Working…' : (idx + 1 >= totalQ ? 'Submit & finish →' : 'Submit answer →')}
              </button>
              <button className="iv-btn iv-ghost" onClick={onFinish} disabled={busy}>Finish now</button>
            </div>
          </section>
        )}

        {/* FINISHING */}
        {phase === 'finishing' && (
          <section className="iv-card iv-status"><span className="iv-spinner" />Analysing your interview…</section>
        )}

        {/* SUMMARY */}
        {phase === 'summary' && summary && (
          <section className="iv-results">
            <div className="iv-card iv-overall">
              <div className="iv-score"><span className="iv-score-n">{summary.overallScore}</span><span className="iv-score-d">/100</span></div>
              <p className="iv-summary">{summary.summary}</p>
            </div>
            <div className="iv-card">
              <h2 className="iv-h2">Your metrics</h2>
              <div className="iv-metrics">
                {[['Correctness', summary.correctness], ['Efficiency', summary.efficiency], ['Confidence', summary.confidence], ['Clarity', summary.clarity]].map(([k, v]) => (
                  <div key={k} className="iv-metric">
                    <div className="iv-metric-head"><span>{k}</span><span className="iv-metric-v">{v}</span></div>
                    <div className="iv-bar"><div className="iv-bar-fill" style={{ width: `${v}%` }} /></div>
                  </div>
                ))}
              </div>
              <p className="iv-muted" style={{ marginTop: 12 }}>Voice level: <strong>{summary.voiceLevel}</strong> · Speaking pace: <strong>{summary.speechPaceWpm} wpm</strong></p>
            </div>
            {summary.feedback?.length > 0 && (
              <div className="iv-card">
                <h2 className="iv-h2">Feedback</h2>
                {summary.feedback.map((f, i) => (
                  <div key={i} className="iv-fb"><div className="iv-fb-area">{f.area}</div><div className="iv-fb-comment">{f.comment}</div></div>
                ))}
              </div>
            )}
            <p className="iv-disclaimer">{summary.disclaimer}</p>
            <div className="iv-actions"><button className="iv-btn iv-primary" onClick={restart}>New interview →</button></div>
          </section>
        )}
      </div>
    </div>
  );
}

const STYLES = `
.iv-root{--bg:#0e0e0e;--surface:#1a1a1a;--surface-2:#242424;--border:#343434;--text:#ededed;--muted:#9a9a9a;--accent:#d8d8d8;--rec:#c96b6b;
  min-height:100vh;background:var(--bg);color:var(--text);font-family:Georgia,'Times New Roman','Noto Serif',serif;line-height:1.5;}
.iv-container{max-width:900px;margin:0 auto;padding:clamp(16px,4vw,40px);}
.iv-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:18px;}
.iv-title{font-size:clamp(24px,5vw,34px);margin:0 0 6px;font-weight:700;}
.iv-subtitle{margin:0;color:var(--muted);font-size:clamp(14px,2.5vw,16px);}
.iv-badge{border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:4px 12px;font-size:12px;white-space:nowrap;background:var(--surface);}
.iv-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(16px,3vw,24px);margin-bottom:18px;}
.iv-h2{font-size:16px;margin:0 0 12px;font-weight:700;}
.iv-error{color:#e6bcbc;border-color:#5a3a3a;}
.iv-chips{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;}
.iv-chip{font-family:inherit;font-size:15px;padding:10px 18px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;}
.iv-chip.sel{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.iv-muted{color:var(--muted);font-size:14px;}
.iv-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px;}
.iv-btn{font-family:inherit;font-size:15px;border-radius:10px;padding:12px 22px;cursor:pointer;border:1px solid var(--border);}
.iv-btn:disabled{opacity:.5;cursor:not-allowed;}
.iv-primary{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.iv-ghost{background:transparent;color:var(--text);}
.iv-small{padding:10px 14px;font-size:13px;}
.iv-rec{background:var(--rec);color:#fff;border-color:var(--rec);font-weight:700;}
.iv-perm{display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin:14px 0;}
.iv-preview{flex:1;min-width:240px;}
.iv-video{width:100%;max-width:360px;aspect-ratio:4/3;background:#000;border:1px solid var(--border);border-radius:10px;object-fit:cover;transform:scaleX(-1);}
.iv-video-off{display:flex;align-items:center;justify-content:center;color:var(--muted);transform:none;}
.iv-perm-status{display:flex;flex-direction:column;gap:10px;min-width:180px;}
.iv-pill{border:1px solid var(--border);border-radius:999px;padding:8px 14px;font-size:14px;color:var(--muted);background:var(--surface-2);}
.iv-pill.ok{color:#bfe3bf;border-color:#3f5f3f;}
.iv-status{display:flex;align-items:center;gap:12px;color:var(--muted);}
.iv-spinner{width:20px;height:20px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:iv-spin .8s linear infinite;}
@keyframes iv-spin{to{transform:rotate(360deg);}}
.iv-qbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;}
.iv-qnum{color:var(--muted);font-size:13px;}
.iv-video-mini{width:96px;aspect-ratio:4/3;border-radius:8px;border:1px solid var(--border);object-fit:cover;transform:scaleX(-1);background:#000;}
.iv-question{font-size:clamp(17px,3vw,20px);margin:0 0 16px;line-height:1.45;}
.iv-answer-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;}
.iv-meter{flex:1;min-width:120px;height:8px;background:var(--surface-2);border-radius:999px;overflow:hidden;}
.iv-meter-fill{height:100%;background:linear-gradient(90deg,#6f6f6f,#e2e2e2);transition:width .1s;}
.iv-textarea{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:Georgia,serif;font-size:15px;line-height:1.6;padding:14px;resize:vertical;}
.iv-textarea:focus{outline:none;border-color:var(--accent);}
.iv-overall{display:flex;align-items:center;gap:24px;flex-wrap:wrap;}
.iv-score{display:flex;align-items:baseline;}
.iv-score-n{font-size:clamp(40px,11vw,60px);font-weight:700;line-height:1;}
.iv-score-d{font-size:18px;color:var(--muted);margin-left:4px;}
.iv-summary{margin:0;color:var(--muted);flex:1;min-width:220px;}
.iv-metrics{display:grid;grid-template-columns:1fr;gap:14px;}
@media(min-width:640px){.iv-metrics{grid-template-columns:1fr 1fr;}}
.iv-metric-head{display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;}
.iv-metric-v{color:var(--accent);font-weight:700;}
.iv-bar{height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden;}
.iv-bar-fill{height:100%;background:linear-gradient(90deg,#6f6f6f,#e2e2e2);}
.iv-fb{border-top:1px solid var(--border);padding:12px 0;}
.iv-fb:first-of-type{border-top:none;}
.iv-fb-area{font-weight:700;font-size:14px;margin-bottom:4px;}
.iv-fb-comment{color:var(--muted);font-size:14px;}
.iv-disclaimer{text-align:center;color:var(--muted);font-style:italic;font-size:13px;border-top:1px solid var(--border);padding-top:16px;}
`;
