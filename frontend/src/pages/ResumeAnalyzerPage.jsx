/**
 * ResumeAnalyzerPage.jsx
 * TODO: Build UI here.
 * Use the corresponding service file for all API calls — never call axios/fetch directly in a page.
 * See _contracts/ for the full API contract before building.
 */
import { useState, useEffect } from 'react';
import { getUploadUrl, analyzeResume, getResult, getHistory } from '../services/resumeAnalyzer.service';

export default function ResumeAnalyzerPage() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeAnalysis, setActiveAnalysis] = useState(null);
  const [uploadingStatus, setUploadingStatus] = useState('');

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      const data = await getHistory();
      setHistory(data.history || []);
    } catch(e) { console.error(e); }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.type !== 'application/pdf') {
      alert("Please upload a PDF file.");
      return;
    }

    setLoading(true);
    setUploadingStatus('Getting upload URL...');
    setActiveAnalysis(null);

    try {
      const { uploadUrl, s3Key } = await getUploadUrl();
      
      setUploadingStatus('Uploading PDF...');
      await new Promise(res => setTimeout(res, 1000));
      
      setUploadingStatus('Analyzing with AI...');
      const { jobId, docId } = await analyzeResume({ s3Key });
      
      const interval = setInterval(async () => {
        try {
          const res = await getResult(jobId || docId); 
          if (res.status === 'complete') {
            setActiveAnalysis(res.result);
            setLoading(false);
            setUploadingStatus('');
            fetchHistory();
            clearInterval(interval);
          }
        } catch (err) {
          console.error(err);
          clearInterval(interval);
          setLoading(false);
        }
      }, 2000);

    } catch (err) {
      console.error(err);
      setLoading(false);
      setUploadingStatus('');
    }
  };

  const handleViewHistoryItem = (item) => {
    if (item.analysis_json?.status === 'complete') {
      setActiveAnalysis(item.analysis_json.result);
    } else {
      alert("This analysis is still pending or failed.");
    }
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', color: 'var(--text-primary)' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', background: 'linear-gradient(45deg, #fff, #888)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        Resume Analyzer
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Upload your PDF resume to receive a comprehensive AI-driven review across 5 critical categories.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '2rem' }}>
        <div style={{ background: 'var(--surface-color)', padding: '3rem', borderRadius: '12px', border: '2px dashed var(--border-color)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '300px' }}>
          {loading ? (
            <div>
              <h3 style={{ color: 'var(--accent-color)', marginBottom: '1rem' }}>{uploadingStatus}</h3>
              <div style={{ width: '40px', height: '40px', border: '4px solid var(--border-color)', borderTop: '4px solid var(--accent-color)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
              <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
            </div>
          ) : (
            <>
              <h2 style={{ marginBottom: '1rem' }}>Upload Resume (PDF)</h2>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Drag and drop, or click to browse.</p>
              <label style={{ padding: '1rem 3rem', background: 'var(--accent-color)', color: '#fff', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
                Select File
                <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={handleFileUpload} />
              </label>
            </>
          )}
        </div>

        <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)', maxHeight: '400px', overflowY: 'auto' }}>
          <h2 style={{ marginBottom: '1.5rem' }}>Analysis History</h2>
          {history.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No past analyses found.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {history.map(h => (
                <div key={h.doc_id} onClick={() => handleViewHistoryItem(h)} style={{ padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid var(--border-color)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{new Date(h.created_at).toLocaleDateString()}</span>
                  <span style={{ color: h.analysis_json?.status === 'complete' ? 'var(--accent-color)' : 'var(--text-secondary)' }}>
                    {h.analysis_json?.status || 'Pending'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {activeAnalysis && (
        <div style={{ marginTop: '3rem', background: 'var(--surface-color)', padding: '3rem', borderRadius: '12px', border: '1px solid var(--accent-color)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '2rem' }}>Analysis Report</h2>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: activeAnalysis.score >= 80 ? 'green' : activeAnalysis.score >= 60 ? 'orange' : 'red' }}>
              {activeAnalysis.score} / 100
            </div>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem' }}>
            {Object.entries(activeAnalysis.categories || {}).map(([key, val]) => (
              <div key={key} style={{ background: 'rgba(0,0,0,0.2)', padding: '1.5rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <h4 style={{ textTransform: 'capitalize', color: 'var(--accent-color)', marginBottom: '0.5rem' }}>{key}</h4>
                <p style={{ lineHeight: '1.5', color: 'var(--text-secondary)' }}>{val}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
