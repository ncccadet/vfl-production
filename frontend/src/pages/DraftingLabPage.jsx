/**
 * DraftingLabPage.jsx
 * Contract: _contracts/04-drafting-lab.md
 *
 * Flow: pick a draft type → AI generates a case → student fills the blanks of that
 * draft (guided by the case) with a live preview → download the completed draft.
 * No model draft, no comparison. All API calls go through draftingLab.service.js.
 * Theme: black/grey serif, mobile-responsive.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { getTypes, generateCase, getResult, assembleDraft, downloadDoc } from '../services/draftingLab.service';

const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 90000;

export default function DraftingLabPage() {
  const [types, setTypes] = useState([]);
  const [draftType, setDraftType] = useState('');
  const [phase, setPhase] = useState('choose'); // choose | generating | fill
  const [label, setLabel] = useState('');
  const [caseObj, setCaseObj] = useState(null);
  const [template, setTemplate] = useState('');
  const [blanks, setBlanks] = useState([]);
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState('');

  const pollRef = useRef(null);
  const pollStartRef = useRef(0);
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  useEffect(() => {
    getTypes().then(({ data }) => setTypes(data.types || [])).catch(() => setError('Could not load draft types.'));
    return stopPolling;
  }, []);

  const beginPolling = useCallback((docId) => {
    stopPolling();
    pollStartRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling(); setPhase('choose'); setError('This is taking too long. Please try again.');
        return;
      }
      try {
        const { data } = await getResult(docId);
        if (data.status === 'complete') {
          stopPolling();
          setLabel(data.label); setCaseObj(data.case); setTemplate(data.template);
          setBlanks(data.blanks || []); setAnswers({}); setPhase('fill');
        } else if (data.status === 'failed') {
          stopPolling(); setPhase('choose'); setError(data.message || 'Could not generate a case.');
        }
      } catch { stopPolling(); setPhase('choose'); setError('Could not fetch your case.'); }
    }, POLL_MS);
  }, []);

  const onGenerate = async () => {
    if (!draftType) { setError('Please choose a draft type.'); return; }
    setError(''); setPhase('generating'); setCaseObj(null);
    try {
      const { data } = await generateCase(draftType);
      beginPolling(data.docId);
    } catch (e) {
      setPhase('choose');
      setError(e?.response?.data?.error || 'Could not start. Please try again.');
    }
  };

  const setAnswer = (id, v) => setAnswers((a) => ({ ...a, [id]: v }));
  const startOver = () => { stopPolling(); setPhase('choose'); setCaseObj(null); setAnswers({}); setError(''); };

  const assembled = assembleDraft(template, answers);
  const filledCount = blanks.filter((b) => (answers[b.id] || '').trim()).length;

  return (
    <div className="dl-root">
      <style>{STYLES}</style>
      <div className="dl-container">
        <header className="dl-header">
          <div>
            <h1 className="dl-title">Drafting Lab</h1>
            <p className="dl-subtitle">Pick a draft, get an AI case, and fill in the blanks.</p>
          </div>
          <span className="dl-badge">3 cases / day</span>
        </header>

        <ol className="dl-steps">
          {['Choose a draft', 'Fill in the blanks'].map((s, i) => {
            const on = (i === 0 && phase !== 'fill') || (i === 1 && phase === 'fill');
            return <li key={s} className={`dl-step ${on ? 'on' : ''}`}><span className="dl-step-n">{i + 1}</span>{s}</li>;
          })}
        </ol>

        {error && <div className="dl-card dl-error" role="alert">{error}</div>}

        {/* STEP 1 — choose */}
        {(phase === 'choose' || phase === 'generating') && (
          <section className="dl-card">
            <h2 className="dl-h2">Choose the draft you want to practise</h2>
            <div className="dl-types">
              {types.map((t) => (
                <button key={t.id} className={`dl-type ${draftType === t.id ? 'sel' : ''}`}
                        onClick={() => setDraftType(t.id)} disabled={phase === 'generating'}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="dl-actions">
              <button className="dl-btn dl-primary" onClick={onGenerate} disabled={phase === 'generating' || !draftType}>
                {phase === 'generating' ? 'Generating case…' : 'Generate case →'}
              </button>
            </div>
            {phase === 'generating' && <div className="dl-status"><span className="dl-spinner" />Preparing a case for you…</div>}
          </section>
        )}

        {/* STEP 2 — case + fill in the blanks + live preview */}
        {phase === 'fill' && (
          <>
            {caseObj && (
              <section className="dl-card dl-case">
                <h2 className="dl-h2">{caseObj.title}</h2>
                <p className="dl-case-facts">{caseObj.facts}</p>
                <p className="dl-case-task"><strong>Your task:</strong> read the facts above and fill in the blanks of the {label} below.</p>
              </section>
            )}

            <div className="dl-grid2">
              <section className="dl-card">
                <div className="dl-fill-head">
                  <h2 className="dl-h2">Fill in the blanks</h2>
                  <span className="dl-muted">{filledCount}/{blanks.length}</span>
                </div>
                {blanks.map((b) => (
                  <div key={b.id} className="dl-field">
                    <label className="dl-flabel" htmlFor={`f-${b.id}`}>{b.label}</label>
                    {b.id === 'facts' || b.id === 'statements' || b.id === 'grounds' || b.id === 'apprehension_grounds' || b.id === 'demand' || b.id === 'purpose' || b.id === 'prayer' || b.id === 'subject'
                      ? <textarea id={`f-${b.id}`} className="dl-input dl-ta" rows={2} value={answers[b.id] || ''} placeholder={b.hint} onChange={(e) => setAnswer(b.id, e.target.value)} />
                      : <input id={`f-${b.id}`} className="dl-input" value={answers[b.id] || ''} placeholder={b.hint} onChange={(e) => setAnswer(b.id, e.target.value)} />}
                  </div>
                ))}
              </section>

              <section className="dl-card">
                <div className="dl-fill-head">
                  <h2 className="dl-h2">Preview</h2>
                  <button className="dl-btn dl-small" onClick={() => downloadDoc(label.replace(/\s+/g, '-').toLowerCase(), label, assembled)}>Download</button>
                </div>
                <pre className="dl-pre">{assembled}</pre>
              </section>
            </div>

            <p className="dl-disclaimer">For educational purposes only. Verify with a qualified advocate.</p>
            <div className="dl-actions"><button className="dl-btn dl-ghost" onClick={startOver}>← Choose another draft</button></div>
          </>
        )}
      </div>
    </div>
  );
}

const STYLES = `
.dl-root{--bg:#0e0e0e;--surface:#1a1a1a;--surface-2:#242424;--border:#343434;--text:#ededed;--muted:#9a9a9a;--accent:#d8d8d8;
  min-height:100vh;background:var(--bg);color:var(--text);font-family:Georgia,'Times New Roman','Noto Serif',serif;line-height:1.5;}
.dl-container{max-width:1000px;margin:0 auto;padding:clamp(16px,4vw,40px);}
.dl-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:18px;}
.dl-title{font-size:clamp(24px,5vw,34px);margin:0 0 6px;font-weight:700;}
.dl-subtitle{margin:0;color:var(--muted);font-size:clamp(14px,2.5vw,16px);}
.dl-badge{border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:4px 12px;font-size:12px;white-space:nowrap;background:var(--surface);}
.dl-steps{display:flex;gap:8px;flex-wrap:wrap;list-style:none;padding:0;margin:0 0 18px;}
.dl-step{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px;padding:6px 12px;border:1px solid var(--border);border-radius:999px;}
.dl-step.on{color:var(--text);border-color:var(--accent);}
.dl-step-n{display:inline-flex;width:20px;height:20px;border-radius:50%;background:var(--surface-2);align-items:center;justify-content:center;font-size:12px;}
.dl-step.on .dl-step-n{background:var(--accent);color:#111;}
.dl-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(16px,3vw,24px);margin-bottom:18px;}
.dl-h2{font-size:16px;margin:0 0 12px;font-weight:700;}
.dl-error{color:#e6bcbc;border-color:#5a3a3a;}
.dl-types{display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:18px;}
@media(min-width:640px){.dl-types{grid-template-columns:1fr 1fr;}}
.dl-type{font-family:inherit;font-size:15px;text-align:left;padding:14px 16px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;}
.dl-type.sel{border-color:var(--accent);background:#2c2c2c;}
.dl-type:disabled{opacity:.5;cursor:not-allowed;}
.dl-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;}
.dl-btn{font-family:inherit;font-size:15px;border-radius:10px;padding:12px 22px;cursor:pointer;border:1px solid var(--border);}
.dl-btn:disabled{opacity:.5;cursor:not-allowed;}
.dl-primary{background:var(--accent);color:#111;border-color:var(--accent);font-weight:700;}
.dl-ghost{background:transparent;color:var(--text);}
.dl-small{padding:8px 14px;font-size:13px;background:var(--surface-2);color:var(--text);}
.dl-status{display:flex;align-items:center;gap:12px;color:var(--muted);margin-top:14px;}
.dl-spinner{width:20px;height:20px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:dl-spin .8s linear infinite;}
@keyframes dl-spin{to{transform:rotate(360deg);}}
.dl-case{border-left:3px solid var(--accent);}
.dl-case-facts{color:var(--text);margin:0 0 10px;}
.dl-case-task{color:var(--muted);margin:0;}
.dl-grid2{display:grid;grid-template-columns:1fr;gap:18px;}
@media(min-width:820px){.dl-grid2{grid-template-columns:1fr 1fr;}}
.dl-fill-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;}
.dl-fill-head .dl-h2{margin:0;}
.dl-field{margin-bottom:12px;}
.dl-flabel{display:block;font-size:13px;color:var(--muted);margin-bottom:4px;}
.dl-input{width:100%;box-sizing:border-box;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:Georgia,serif;font-size:14px;padding:10px 12px;}
.dl-input:focus{outline:none;border-color:var(--accent);}
.dl-ta{resize:vertical;line-height:1.5;}
.dl-pre{white-space:pre-wrap;word-break:break-word;font-family:Georgia,serif;font-size:13.5px;color:var(--text);margin:0;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:14px;min-height:300px;max-height:560px;overflow:auto;}
.dl-muted{color:var(--muted);font-size:13px;}
.dl-disclaimer{text-align:center;color:var(--muted);font-style:italic;font-size:13px;border-top:1px solid var(--border);padding-top:16px;}
`;
