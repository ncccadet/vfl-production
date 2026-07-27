/**
 * ResumeBuilderPage.jsx
 * TODO: Build UI here.
 * Use the corresponding service file for all API calls — never call axios/fetch directly in a page.
 * See _contracts/ for the full API contract before building.
 */
import { useState, useEffect } from 'react';
import { buildResume, getResume } from '../services/resumeBuilder.service';

export default function ResumeBuilderPage() {
  const [formData, setFormData] = useState({
    personal_info: { name: '', email: '', phone: '', linkedin: '' },
    education: '',
    experience: '',
    skills: '',
    achievements: ''
  });
  
  const [loading, setLoading] = useState(false);
  const [resumeUrl, setResumeUrl] = useState(null);

  useEffect(() => {
    fetchExistingResume();
  }, []);

  const fetchExistingResume = async () => {
    try {
      const data = await getResume();
      if (data.downloadUrl) {
        setResumeUrl(data.downloadUrl);
      }
    } catch(e) { console.error(e); }
  };

  const handleInputChange = (section, field, value) => {
    if (section === 'personal_info') {
      setFormData(prev => ({
        ...prev,
        personal_info: { ...prev.personal_info, [field]: value }
      }));
    } else {
      setFormData(prev => ({ ...prev, [section]: value }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await buildResume(formData);
      setResumeUrl(data.downloadUrl);
      alert("Resume built successfully!");
    } catch(err) {
      console.error(err);
      alert(err.response?.data?.error || "Failed to build resume.");
    }
    setLoading(false);
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', color: 'var(--text-primary)' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', background: 'linear-gradient(45deg, #fff, #888)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        AI Resume Builder
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Input your details and let AI format it into a professional legal resume.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '2rem' }}>
        <form onSubmit={handleSubmit} style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          <div>
            <h3 style={{ marginBottom: '1rem', color: 'var(--accent-color)' }}>Personal Information</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <input type="text" placeholder="Full Name" required value={formData.personal_info.name} onChange={e => handleInputChange('personal_info', 'name', e.target.value)} style={inputStyle} />
              <input type="email" placeholder="Email" required value={formData.personal_info.email} onChange={e => handleInputChange('personal_info', 'email', e.target.value)} style={inputStyle} />
              <input type="tel" placeholder="Phone" value={formData.personal_info.phone} onChange={e => handleInputChange('personal_info', 'phone', e.target.value)} style={inputStyle} />
              <input type="text" placeholder="LinkedIn URL" value={formData.personal_info.linkedin} onChange={e => handleInputChange('personal_info', 'linkedin', e.target.value)} style={inputStyle} />
            </div>
          </div>

          <div>
            <h3 style={{ marginBottom: '1rem', color: 'var(--accent-color)' }}>Education</h3>
            <textarea placeholder="List your degrees, university, and graduation year..." required value={formData.education} onChange={e => handleInputChange('education', null, e.target.value)} style={textareaStyle} />
          </div>

          <div>
            <h3 style={{ marginBottom: '1rem', color: 'var(--accent-color)' }}>Experience</h3>
            <textarea placeholder="List your work experience, internships, or clerkships..." required value={formData.experience} onChange={e => handleInputChange('experience', null, e.target.value)} style={textareaStyle} />
          </div>

          <div>
            <h3 style={{ marginBottom: '1rem', color: 'var(--accent-color)' }}>Skills & Achievements</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <textarea placeholder="Legal research, drafting, negotiation..." required value={formData.skills} onChange={e => handleInputChange('skills', null, e.target.value)} style={{...textareaStyle, height: '100px'}} />
              <textarea placeholder="Moot court winner, published papers..." value={formData.achievements} onChange={e => handleInputChange('achievements', null, e.target.value)} style={{...textareaStyle, height: '100px'}} />
            </div>
          </div>

          <button type="submit" disabled={loading} style={{ padding: '1rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1rem', marginTop: '1rem' }}>
            {loading ? 'Building Resume with AI...' : 'Generate AI Resume'}
          </button>
        </form>

        <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}>
          {resumeUrl ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: '80px', height: '80px', background: 'rgba(255,255,255,0.1)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
                <span style={{ fontSize: '2.5rem' }}>📄</span>
              </div>
              <h2 style={{ marginBottom: '1rem' }}>Your Resume is Ready</h2>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>AI has formatted your details into a professional layout.</p>
              <a href={resumeUrl} target="_blank" rel="noreferrer" style={{ padding: '1rem 3rem', background: 'var(--accent-color)', color: '#fff', textDecoration: 'none', borderRadius: '8px', fontWeight: 'bold', display: 'inline-block' }}>
                Download PDF
              </a>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
              <span style={{ fontSize: '3rem', opacity: 0.5, display: 'block', marginBottom: '1rem' }}>📝</span>
              <p>Fill out the form to generate your AI resume.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '1rem',
  background: 'rgba(0,0,0,0.2)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: '8px',
  fontSize: '1rem'
};

const textareaStyle = {
  ...inputStyle,
  height: '150px',
  resize: 'vertical',
  fontFamily: 'inherit'
};
