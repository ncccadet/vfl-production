/**
 * CourtSimulationPage.jsx
 * Contract: _contracts/05-court-simulation.md
 *
 * Flow: pick case type + position → AI sets the case → argue in a 3-panel
 * courtroom (you = left, judge = centre/raised, opposition = right). Each turn
 * you make a statement (by voice or typing); the judge rules briefly and the
 * opposing counsel rebuts. Aim to conclude by turn 10 (hard cap 15). Then a
 * scored feedback summary.
 *
 * Mic: browser SpeechRecognition; you may speak up to 300 words, then the mic
 * stops and a warning shows ("Real courts don't let you talk too much"); a
 * 100-word buffer allows up to 400, after which the mic is locked for that turn.
 * The judge and opposition are read aloud (browser TTS); the judge speaks
 * slightly faster. While the court is speaking, the student's mic and submit are
 * LOCKED — you cannot interrupt the bench or opposing counsel.
 * Theme: black/grey serif, responsive.
 */
import { useEffect, useRef, useState } from 'react';
import { getCaseTypes, startSession, takeTurn, finishSession } from '../services/courtSimulation.service';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const WARN_WORDS = 300;
const MAX_WORDS = 400; // 300 + 100 buffer

export default function CourtSimulationPage() {
  const [phase, setPhase] = useState('setup'); // setup | starting | court | finishing | summary
  const [caseTypes, setCaseTypes] = useState([]);
  const [caseType, setCaseType] = useState('');
  const [positions, setPositions] = useState([]);
  const [position, setPosition] = useState('');
  const [error, setError] = useState('');

  const [sessionId, setSessionId] = useState('');
  const [label, setLabel] = useState('');
  const [brief, setBrief] = useState('');
  const [turnCount, setTurnCount] = useState(0);
  const [judgeText, setJudgeText] = useState('The court is in session. Counsel, make your opening statement.');
  const [oppText, setOppText] = useState('');
  const [statement, setStatement] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [warn, setWarn] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false); // court is speaking → student mic locked
  const [busy, setBusy] = useState(false);
  const [concluded, setConcluded] = useState(false);
  const [summary, setSummary] = useState(null);

  const streamRef = useRef(null), audioCtxRef = useRef(null), analyserRef = useRef(null), rafRef = useRef(null);
  const meterRef = useRef({ sum: 0, count: 0, avg: 0 });
  const recRef = useRef(null), recordingRef = useRef(false), startRef = useRef(0);

  useEffect(() => {
    getCaseTypes().then(({ data }) => setCaseTypes(data.caseTypes || [])).catch(() => setError('Could not load case types.'));
    return cleanup;
  }, []);

  const cleanup = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    try { recRef.current && recRef.current.stop(); } catch {}
    try { audioCtxRef.current && audioCtxRef.current.close(); } catch {}
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  };

  const wordCount = statement.trim().split(/\s+/).filter(Boolean).length;

  const pickCase = (c) => { setCaseType(c.id); setPositions(c.positions); setPosition(c.positions[0]); };

  // Speak the judge then the opposition in sequence. While speaking, the mic is
  // locked (aiSpeaking = true). A watchdog clears the lock even if a browser
  // fails to fire onend, so the student is never stuck unable to respond.
  const speakSequence = (items) => {
    const list = (items || []).filter((x) => x && x.text);
    if (!list.length) return;
    if (recordingRef.current) stopRec(); // stop the student mid-word if they were talking
    if (!window.speechSynthesis) return; // no TTS: don't lock the UI
    window.speechSynthesis.cancel();
    setAiSpeaking(true);
    const totalChars = list.reduce((a, x) => a + x.text.length, 0);
    const watchdog = setTimeout(() => { try { window.speechSynthesis.cancel(); } catch {} setAiSpeaking(false); }, Math.min(120000, totalChars * 70 + 4000));
    let i = 0;
    const next = () => {
      if (i >= list.length) { clearTimeout(watchdog); setAiSpeaking(false); return; }
      const { text, fast } = list[i++];
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-IN'; u.rate = fast ? 1.2 : 1.0;
      u.onend = next; u.onerror = next;
      window.speechSynthesis.speak(u);
    };
    next();
  };

  // ── mic + voice meter ─────────────────────────────────────────────────────
  const ensureMic = async () => {
    if (streamRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC(); const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      audioCtxRef.current = ctx; analyserRef.current = an;
      return true;
    } catch { setError('Microphone access is needed to speak. You can type your statement instead.'); return false; }
  };
  const meterTick = () => {
    const an = analyserRef.current; if (!an) return;
    const buf = new Uint8Array(an.fftSize); an.getByteTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    const level = Math.min(100, Math.round(Math.sqrt(s / buf.length) * 320));
    setVoiceLevel(level); meterRef.current.sum += level; meterRef.current.count += 1;
    rafRef.current = requestAnimationFrame(meterTick);
  };

  const startRec = async () => {
    if (wordCount >= MAX_WORDS || aiSpeaking) return; // can't speak while the court speaks
    if (!(await ensureMic())) return;
    meterRef.current = { sum: 0, count: 0, avg: meterRef.current.avg || 0 };
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
    startRef.current = startRef.current || Date.now();
    meterTick();
    if (SR) {
      const rec = new SR(); rec.lang = 'en-IN'; rec.continuous = true; rec.interimResults = true;
      rec.onresult = (e) => {
        let fin = '';
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) fin += e.results[i][0].transcript + ' ';
        if (fin) setStatement((prev) => {
          const merged = (prev ? prev + ' ' : '') + fin.trim();
          const words = merged.trim().split(/\s+/).filter(Boolean);
          if (words.length >= WARN_WORDS) { setWarn(true); stopRec(); } // auto-stop at 300
          return words.slice(0, MAX_WORDS).join(' ');
        });
      };
      rec.onend = () => { if (recordingRef.current) { try { rec.start(); } catch {} } };
      recRef.current = rec; recordingRef.current = true; try { rec.start(); } catch {}
    }
    setRecording(true);
  };
  const stopRec = () => {
    recordingRef.current = false; setRecording(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current); setVoiceLevel(0);
    try { recRef.current && recRef.current.stop(); } catch {}
    const { sum, count } = meterRef.current; if (count) meterRef.current.avg = Math.round(sum / count);
  };
  const toggleRec = () => (recording ? stopRec() : startRec());

  // ── flow ──────────────────────────────────────────────────────────────────
  const onStart = async () => {
    if (!caseType) { setError('Choose a case type.'); return; }
    setError(''); setBusy(true); setPhase('starting');
    try {
      const { data } = await startSession({ caseType, position });
      setSessionId(data.sessionId); setLabel(data.label); setBrief(data.brief);
      setTurnCount(0); setJudgeText(`The court is in session for this ${data.label}. Counsel for the ${data.position}, make your opening statement.`);
      setOppText(''); setStatement(''); setConcluded(false); setPhase('court');
    } catch (e) { setPhase('setup'); setError(e?.response?.data?.error || 'Could not start the hearing.'); }
    finally { setBusy(false); }
  };

  const onSubmitTurn = async () => {
    if (!statement.trim()) { setError('Make your statement first.'); return; }
    if (recording) stopRec();
    setError(''); setBusy(true);
    const durationSec = startRef.current ? Math.round((Date.now() - startRef.current) / 1000) : 0;
    try {
      const { data } = await takeTurn({
        session_id: sessionId, statement,
        voiceLevel: meterRef.current.avg || 0, durationSec, wordCount,
      });
      setJudgeText(data.judge); setOppText(data.opposition);
      setTurnCount(data.turnNumber); setStatement(''); setWarn(false);
      startRef.current = 0; meterRef.current.avg = 0;
      // The court speaks (judge first, quicker; then opposition) — mic locked meanwhile.
      speakSequence([{ text: data.judge, fast: true }, { text: data.opposition, fast: false }]);
      if (data.concluded) { setConcluded(true); await onFinish(); }
    } catch (e) { setError(e?.response?.data?.error || 'The court could not respond.'); }
    finally { setBusy(false); }
  };

  const onFinish = async () => {
    setPhase('finishing'); setBusy(true); cleanup();
    try { const { data } = await finishSession(sessionId); setSummary(data.result); setPhase('summary'); }
    catch (e) { setError(e?.response?.data?.error || 'Could not generate feedback.'); setPhase('court'); }
    finally { setBusy(false); }
  };

  const restart = () => { cleanup(); setPhase('setup'); setSessionId(''); setSummary(null); setStatement(''); setError(''); setCaseType(''); setPositions([]); };

  return (
    <div className="cs-root">
      <style>{STYLES}</style>
      <div className="cs-container">
        <header className="cs-header">
          <div>
            <h1 className="cs-title">Court Simulation</h1>
            <p className="cs-subtitle">Argue a live case against an AI bench and opposing counsel.</p>
          </div>
          <span className="cs-badge">4 sessions / week</span>
        </header>

        {error && <div className="cs-card cs-error" role="alert">{error}</div>}

        {/* SETUP */}
        {phase === 'setup' && (
          <section className="cs-card">
            <h2 className="cs-h2">Choose a case type</h2>
            <div className="cs-chips">
              {caseTypes.map((c) => <button key={c.id} className={`cs-chip ${caseType === c.id ? 'sel' : ''}`} onClick={() => pickCase(c)}>{c.label}</button>)}
            </div>
            {positions.length > 0 && (
              <>
                <h2 className="cs-h2">Your position</h2>
                <div className="cs-chips">
                  {positions.map((p) => <button key={p} className={`cs-chip ${position === p ? 'sel' : ''}`} onClick={() => setPosition(p)}>{p}</button>)}
                </div>
              </>
            )}
            <div className="cs-actions"><button className="cs-btn cs-primary" onClick={onStart} disabled={busy || !caseType}>Enter the courtroom →</button></div>
          </section>
        )}

        {phase === 'starting' && <section className="cs-card cs-status"><span className="cs-spinner" />Setting up the case…</section>}

        {/* COURTROOM */}
        {phase === 'court' && (
          <>
            <details className="cs-card cs-brief"><summary>Case brief — {label}</summary><p>{brief}</p></details>
            <div className="cs-turnbar">Turn {turnCount} · aim to conclude by 10 {concluded && '· concluded'}</div>

            <div className="cs-arena">
              <div className="cs-panel cs-student">
                <div className="cs-panel-h">You — {position}</div>
                <textarea className="cs-textarea" rows={7} value={statement} disabled={busy || aiSpeaking}
                  placeholder={aiSpeaking ? 'The court is speaking…' : (SR ? 'Speak or type your statement…' : 'Type your statement…')}
                  onChange={(e) => { const w = e.target.value.trim().split(/\s+/).filter(Boolean); setStatement(w.slice(0, MAX_WORDS).join(' ') + (e.target.value.endsWith(' ') ? ' ' : '')); if (w.length >= WARN_WORDS) setWarn(true); }} />
                <div className="cs-answer-tools">
                  <button className={`cs-btn ${recording ? 'cs-rec' : 'cs-primary'} cs-small`} onClick={toggleRec} disabled={busy || wordCount >= MAX_WORDS || aiSpeaking}>
                    {recording ? '⏹ Stop' : '🎤 Speak'}
                  </button>
                  <span className={`cs-wc ${wordCount >= WARN_WORDS ? 'over' : ''}`}>{wordCount}/{WARN_WORDS} words</span>
                  {recording && <div className="cs-meter"><div className="cs-meter-fill" style={{ width: `${voiceLevel}%` }} /></div>}
                </div>
                {aiSpeaking && <p className="cs-speaking">🔊 The court is speaking — wait for your turn, counsel.</p>}
                {warn && !aiSpeaking && <p className="cs-warn">⚖ Real courts don’t let you talk too much — keep it tight, counsel.</p>}
                <div className="cs-actions">
                  <button className="cs-btn cs-primary" onClick={onSubmitTurn} disabled={busy || !statement.trim() || aiSpeaking}>{busy ? 'The court listens…' : 'Submit statement →'}</button>
                  <button className="cs-btn cs-ghost cs-small" onClick={onFinish} disabled={busy || aiSpeaking}>Rest my case</button>
                </div>
              </div>

              <div className="cs-panel cs-judge">
                <div className="cs-panel-h">⚖ The Bench</div>
                <p className="cs-speech">{judgeText}</p>
              </div>

              <div className="cs-panel cs-opp">
                <div className="cs-panel-h">Opposing Counsel</div>
                <p className="cs-speech">{oppText || 'Awaiting your statement…'}</p>
              </div>
            </div>
          </>
        )}

        {phase === 'finishing' && <section className="cs-card cs-status"><span className="cs-spinner" />The bench is preparing its feedback…</section>}

        {/* SUMMARY */}
        {phase === 'summary' && summary && (
          <section className="cs-results">
            <div className="cs-card cs-overall">
              <div className="cs-score"><span className="cs-score-n">{summary.overallScore}</span><span className="cs-score-d">/100</span></div>
              <div className="cs-overall-body">
                <span className={`cs-verdict cs-${summary.verdict}`}>{summary.verdict === 'won' ? 'Case won' : summary.verdict === 'lost' ? 'Case lost' : 'Split decision'}</span>
                <p className="cs-summary">{summary.summary}</p>
              </div>
            </div>
            <div className="cs-card">
              <h2 className="cs-h2">Your advocacy</h2>
              <div className="cs-metrics">
                {[['Legal reasoning', summary.legalReasoning], ['Argumentation', summary.argumentation], ['Courtcraft', summary.courtcraft], ['Clarity', summary.clarity]].map(([k, v]) => (
                  <div key={k} className="cs-metric"><div className="cs-metric-h"><span>{k}</span><span className="cs-metric-v">{v}</span></div><div className="cs-bar"><div className="cs-bar-fill" style={{ width: `${v}%` }} /></div></div>
                ))}
              </div>
            </div>
            {summary.feedback?.length > 0 && (
              <div className="cs-card">
                <h2 className="cs-h2">Feedback</h2>
                {summary.feedback.map((f, i) => <div key={i} className="cs-fb"><div className="cs-fb-a">{f.area}</div><div className="cs-fb-c">{f.comment}</div></div>)}
              </div>
            )}
            <p className="cs-disclaimer">{summary.disclaimer}</p>
            <div className="cs-actions"><button className="cs-btn cs-primary" onClick={restart}>New case →</button></div>
          </section>
        )}
      </div>
    </div>
  );
}

const STYLES = `
.cs-root{--bg:#0e0e0e;--surface:#1a1a1a;--surface-2:#242424;--border:#343434;--text:#ededed;--muted:#9a9a9a;--accent:#d8d8d8;--rec:#c96b6b;--judge:#cbb98a;
  min-height:100vh;background:var(--bg);color:var(--text);font-family:Georgia,'Times New Roman','Noto Serif',serif;line-height:1.5;}
.cs-container{max-width:1080px;margin:0 auto;padding:clamp(16px,4vw,40px);}
.cs-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:18px;}
.cs-title{font-size:clamp(24px,5vw,34px);margin:0 0 6px;font-weight:700;}
.cs-subtitle{margin:0;color:var(--muted);font-size:clamp(14px,2.5vw,16px);}
.cs-badge{border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:4px 12px;font-size:12px;white-space:nowrap;background:var(--surface);}
.cs-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(16px,3vw,24px);margin-bottom:18px;}
.cs-h2{font-size:16px;margin:0 0 12px;font-weight:700;}
.cs-error{color:#e6bcbc;border-color:#5a3a3a;}
.cs-chips{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;}
.cs-chip{font-family:inherit;font-size:15px;padding:10px 18px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;}
.cs-chip.sel{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.cs-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;}
.cs-btn{font-family:inherit;font-size:15px;border-radius:10px;padding:12px 22px;cursor:pointer;border:1px solid var(--border);}
.cs-btn:disabled{opacity:.5;cursor:not-allowed;}
.cs-primary{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.cs-ghost{background:transparent;color:var(--text);}
.cs-small{padding:9px 14px;font-size:13px;}
.cs-rec{background:var(--rec);color:#fff;border-color:var(--rec);font-weight:700;}
.cs-status{display:flex;align-items:center;gap:12px;color:var(--muted);}
.cs-spinner{width:20px;height:20px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:cs-spin .8s linear infinite;}
@keyframes cs-spin{to{transform:rotate(360deg);}}
.cs-brief{color:var(--muted);}
.cs-brief summary{cursor:pointer;font-weight:700;color:var(--text);}
.cs-brief p{margin:10px 0 0;}
.cs-turnbar{color:var(--muted);font-size:13px;margin:0 0 34px;text-align:center;}
.cs-arena{display:grid;grid-template-columns:1fr;gap:16px;align-items:start;}
@media(min-width:860px){.cs-arena{grid-template-columns:1fr 1.15fr 1fr;}}
.cs-panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;}
.cs-panel-h{font-weight:700;font-size:14px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);}
.cs-judge{border-color:#5a4f34;background:#191712;}
.cs-judge .cs-panel-h{color:var(--judge);}
@media(min-width:860px){.cs-judge{margin-top:-22px;box-shadow:0 6px 24px rgba(0,0,0,.4);}}
.cs-opp .cs-panel-h{color:#c99a9a;}
.cs-speech{margin:0;font-size:14.5px;white-space:pre-wrap;max-height:340px;overflow:auto;}
.cs-textarea{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:Georgia,serif;font-size:14.5px;line-height:1.6;padding:12px;resize:vertical;}
.cs-textarea:focus{outline:none;border-color:var(--accent);}
.cs-answer-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0;}
.cs-wc{font-size:12px;color:var(--muted);}
.cs-wc.over{color:#e6bcbc;}
.cs-meter{flex:1;min-width:80px;height:7px;background:var(--surface-2);border-radius:999px;overflow:hidden;}
.cs-meter-fill{height:100%;background:linear-gradient(90deg,#6f6f6f,#e2e2e2);transition:width .1s;}
.cs-warn{color:#e0c68a;font-size:13px;margin:0 0 8px;}
.cs-speaking{color:var(--judge);font-size:13px;margin:0 0 8px;font-weight:700;}
.cs-overall{display:flex;align-items:center;gap:24px;flex-wrap:wrap;}
.cs-score{display:flex;align-items:baseline;}
.cs-score-n{font-size:clamp(40px,11vw,60px);font-weight:700;line-height:1;}
.cs-score-d{font-size:18px;color:var(--muted);margin-left:4px;}
.cs-overall-body{flex:1;min-width:220px;}
.cs-verdict{display:inline-block;font-size:12px;padding:3px 12px;border-radius:999px;border:1px solid var(--border);margin-bottom:8px;}
.cs-won{color:#bfe3bf;border-color:#3f5f3f;}
.cs-lost{color:#e6bcbc;border-color:#5a3a3a;}
.cs-split{color:#e0c68a;border-color:#5a4f34;}
.cs-summary{margin:0;color:var(--muted);}
.cs-metrics{display:grid;grid-template-columns:1fr;gap:14px;}
@media(min-width:640px){.cs-metrics{grid-template-columns:1fr 1fr;}}
.cs-metric-h{display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;}
.cs-metric-v{color:var(--accent);font-weight:700;}
.cs-bar{height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden;}
.cs-bar-fill{height:100%;background:linear-gradient(90deg,#6f6f6f,#e2e2e2);}
.cs-fb{border-top:1px solid var(--border);padding:12px 0;}
.cs-fb:first-of-type{border-top:none;}
.cs-fb-a{font-weight:700;font-size:14px;margin-bottom:4px;}
.cs-fb-c{color:var(--muted);font-size:14px;}
.cs-disclaimer{text-align:center;color:var(--muted);font-style:italic;font-size:13px;border-top:1px solid var(--border);padding-top:16px;}
`;
