/**
 * ExamPrepPage.jsx
 * TODO: Build UI here.
 * Use the corresponding service file for all API calls — never call axios/fetch directly in a page.
 * See _contracts/ for the full API contract before building.
 */
import { useState, useEffect } from 'react';
import { getQuestions, submitAttempt, getAnalytics } from '../services/examPrep.service';

export default function ExamPrepPage() {
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analytics, setAnalytics] = useState(null);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      const data = await getAnalytics();
      setAnalytics(data);
    } catch (e) { console.error(e); }
  };

  const handleStartExam = async (format) => {
    setLoading(true);
    setResults(null);
    setAnswers({});
    try {
      const data = await getQuestions({ exam_type: 'AIBE', format });
      setQuestions(data.questions || []);
    } catch(err) {
      console.error(err);
    }
    setLoading(false);
  };

  const handleSelectAnswer = (qId, option) => {
    setAnswers(prev => ({ ...prev, [qId]: { selected_option: option } }));
  };

  const handleTextAnswer = (qId, text) => {
    setAnswers(prev => ({ ...prev, [qId]: { answer_text: text } }));
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const formattedAnswers = Object.entries(answers).map(([qId, data]) => ({
        question_id: qId,
        ...data
      }));
      const data = await submitAttempt({ exam_type: 'AIBE', answers: formattedAnswers });
      setResults(data);
      fetchAnalytics();
    } catch(err) {
      console.error(err);
    }
    setLoading(false);
  };

  if (results) {
    return (
      <div style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', color: 'var(--text-primary)' }}>
        <h2 style={{ color: 'var(--accent-color)' }}>Exam Results</h2>
        <h3 style={{ marginBottom: '2rem' }}>Score: {results.score}</h3>
        {results.results?.map(r => (
          <div key={r.question_id} style={{ background: 'var(--surface-color)', padding: '1.5rem', borderRadius: '12px', marginBottom: '1.5rem', border: `1px solid ${r.is_correct === true ? 'green' : r.is_correct === false ? 'red' : 'var(--border-color)'}` }}>
            <p><strong>Your Answer:</strong> {r.user_answer}</p>
            {r.correct_answer && <p><strong>Correct Answer:</strong> {r.correct_answer}</p>}
            {r.explanation && <p style={{ color: 'var(--text-secondary)' }}><strong>Explanation:</strong> {r.explanation}</p>}
            {r.model_answer && <p style={{ color: 'var(--text-secondary)' }}><strong>Model Answer:</strong> {r.model_answer}</p>}
          </div>
        ))}
        <button onClick={() => setResults(null)} style={{ padding: '0.75rem 2rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  if (questions.length > 0) {
    return (
      <div style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', color: 'var(--text-primary)' }}>
        <h2 style={{ marginBottom: '2rem', color: 'var(--text-primary)' }}>Exam in Progress</h2>
        {questions.map((q, idx) => (
          <div key={q.question_id} style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', marginBottom: '1.5rem', border: '1px solid var(--border-color)' }}>
            <h4 style={{ marginBottom: '1rem' }}>{idx + 1}. {q.question}</h4>
            {q.question_format === 'mcq' && q.options_json ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {q.options_json.map(opt => (
                  <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', padding: '0.5rem', borderRadius: '4px', background: answers[q.question_id]?.selected_option === opt ? 'rgba(255,255,255,0.1)' : 'transparent' }}>
                    <input 
                      type="radio" 
                      name={q.question_id} 
                      value={opt} 
                      checked={answers[q.question_id]?.selected_option === opt}
                      onChange={() => handleSelectAnswer(q.question_id, opt)} 
                    />
                    {opt}
                  </label>
                ))}
              </div>
            ) : (
              <textarea 
                placeholder="Type your answer here..."
                value={answers[q.question_id]?.answer_text || ''}
                onChange={e => handleTextAnswer(q.question_id, e.target.value)}
                style={{ width: '100%', height: '150px', padding: '1rem', background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', fontFamily: 'inherit' }}
              />
            )}
          </div>
        ))}
        <button onClick={handleSubmit} disabled={loading} style={{ padding: '1rem 3rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1.1rem', width: '100%' }}>
          {loading ? 'Submitting...' : 'Submit Exam'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto', color: 'var(--text-primary)' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', background: 'linear-gradient(45deg, #fff, #888)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        Exam Prep
      </h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Practice MCQs and Long-Form questions for your upcoming exams.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem' }}>
        <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '1rem' }}>Take a Test</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <button onClick={() => handleStartExam('mcq')} style={{ padding: '1rem', background: 'rgba(255,255,255,0.1)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer' }}>Start MCQ Test</button>
            <button onClick={() => handleStartExam('long_form')} style={{ padding: '1rem', background: 'rgba(255,255,255,0.1)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer' }}>Start Long-Form Test</button>
            <button onClick={() => handleStartExam('mixed')} style={{ padding: '1rem', background: 'rgba(255,255,255,0.1)', color: '#fff', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer' }}>Start Mixed Test</button>
          </div>
        </div>

        <div style={{ background: 'var(--surface-color)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <h2 style={{ marginBottom: '1rem' }}>Your Analytics</h2>
          {analytics ? (
            <div>
              <p style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>Total Attempts: <strong>{analytics.attempts}</strong></p>
              <div style={{ marginTop: '1.5rem' }}>
                <h4 style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>Performance by Exam</h4>
                {analytics.byExamType?.map(type => (
                  <div key={type.exam_type} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', marginBottom: '0.5rem' }}>
                    <span>{type.exam_type}</span>
                    <span style={{ color: 'var(--accent-color)', fontWeight: 'bold' }}>Avg: {type.avg_score || 0}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p>Loading analytics...</p>
          )}
        </div>
      </div>
    </div>
  );
}
