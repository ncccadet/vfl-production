/**
 * DraftingLabPage.jsx
 * TODO: Build UI here.
 * Use the corresponding service file for all API calls — never call axios/fetch directly in a page.
 * See _contracts/ for the full API contract before building.
 */
import { useState, useEffect } from 'react';
import { getTemplates, getTemplate, verifyBlanks, generateCase, submitCaseDraft, getCaseResult } from '../services/draftingLab.service';

export default function DraftingLabPage() {
  const [activeTab, setActiveTab] = useState('templates'); // 'templates', 'ai'
  
  const [templates, setTemplates] = useState([]);
  const [loadingT, setLoadingT] = useState(false);

  const [caseStudy, setCaseStudy] = useState(null);
  const [draftText, setDraftText] = useState('');
  const [aiScore, setAiScore] = useState(null);
  const [scoring, setScoring] = useState(false);

  useEffect(() => {
    if (activeTab === 'templates') fetchTemplates();
  }, [activeTab]);

  const fetchTemplates = async () => {
    setLoadingT(true);
    try {
      const data = await getTemplates();
      setTemplates(data.templates || []);
    } catch (err) {
      console.error(err);
    }
    setLoadingT(false);
  };

  const handleGenerateCase = async () => {
    setScoring(true);
    setCaseStudy(null);
    setAiScore(null);
    try {
      const data = await generateCase({ filters: { topic: 'Civil' } });
      setCaseStudy(data);
    } catch(err) {
      console.error(err);
    }
    setScoring(false);
  };

  const handleSubmitDraft = async () => {
    if (!caseStudy?.caseId || !draftText) return;
    setScoring(true);
    try {
      await submitCaseDraft({ case_id: caseStudy.caseId, draft_text: draftText });
      const interval = setInterval(async () => {
        try {
          const res = await getCaseResult(caseStudy.caseId);
          if (res.status === 'complete') {
            setAiScore(res);
            setScoring(false);
            clearInterval(interval);
          }
        } catch (e) {
          clearInterval(interval);
          setScoring(false);
        }
      }, 2000);
    } catch (err) {
      console.error(err);
      setScoring(false);
    }
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', color: 'var(--text-primary)' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', background: 'linear-gradient(45deg, #fff, #888)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        Drafting Lab
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Master legal drafting with AI-powered feedback.</p>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
        {['templates', 'ai'].map(tab => (
          <button 
            key={tab} 
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '0.75rem 1.5rem',
              background: activeTab === tab ? 'var(--accent-color)' : 'var(--surface-color)',
              border: `1px solid ${activeTab === tab ? 'var(--accent-color)' : 'var(--border-color)'}`,
              color: 'var(--text-primary)',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 'bold',
              transition: 'all 0.2s'
            }}>
            {tab === 'templates' ? 'Template Library' : 'AI Case Simulator'}
          </button>
        ))}
      </div>

      {activeTab === 'templates' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1.5rem' }}>
          {loadingT ? <p>Loading templates...</p> : templates.length === 0 ? <p>No templates found.</p> : (
            templates.map(t => (
              <div key={t.template_id} style={{ background: 'var(--surface-color)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <h3>{t.name || t.template_type}</h3>
                <p style={{ color: 'var(--text-secondary)' }}>Language: {t.language}</p>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'ai' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {!caseStudy ? (
            <div style={{ background: 'var(--surface-color)', padding: '3rem', borderRadius: '12px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
              <h3>Generate a Custom Case Study</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>AI will generate a unique client scenario for you to draft a response.</p>
              <button 
                onClick={handleGenerateCase}
                disabled={scoring}
                style={{ padding: '0.75rem 2rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
                {scoring ? 'Generating...' : 'Generate Case'}
              </button>
            </div>
          ) : (
            <>
              <div style={{ background: 'var(--surface-color)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <h3 style={{ marginBottom: '1rem' }}>Case Details</h3>
                <p style={{ lineHeight: '1.6' }}>{caseStudy.caseText}</p>
                <small style={{ color: 'var(--text-secondary)', display: 'block', marginTop: '1rem' }}>{caseStudy.disclaimer}</small>
              </div>
              
              <div>
                <h3 style={{ marginBottom: '1rem' }}>Your Draft</h3>
                <textarea 
                  value={draftText}
                  onChange={e => setDraftText(e.target.value)}
                  placeholder="Draft your legal response here..."
                  style={{ width: '100%', height: '300px', padding: '1rem', background: 'var(--surface-color)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '12px', fontFamily: 'monospace', resize: 'vertical' }}
                />
              </div>

              <button 
                onClick={handleSubmitDraft}
                disabled={scoring || !draftText}
                style={{ padding: '0.75rem 2rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', alignSelf: 'flex-start' }}>
                {scoring ? 'Scoring Draft with AI...' : 'Submit Draft'}
              </button>

              {aiScore && (
                <div style={{ background: 'var(--surface-color)', padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--accent-color)', marginTop: '2rem' }}>
                  <h2 style={{ color: 'var(--accent-color)', marginBottom: '1rem' }}>Score: {aiScore.score}/100</h2>
                  <div style={{ marginBottom: '1.5rem' }}>
                    <h4>Feedback:</h4>
                    <ul style={{ paddingLeft: '1.5rem', marginTop: '0.5rem' }}>
                      {aiScore.feedback?.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  </div>
                  <div>
                    <h4>Model Draft:</h4>
                    <p style={{ marginTop: '0.5rem', background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px', fontFamily: 'monospace' }}>
                      {aiScore.modelDraft}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
