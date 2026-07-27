/**
 * JobBoardPage.jsx
 * TODO: Build UI here.
 * Use the corresponding service file for all API calls — never call axios/fetch directly in a page.
 * See _contracts/ for the full API contract before building.
 */
import { useState, useEffect } from 'react';
import { getJobs } from '../services/jobBoard.service';

export default function JobBoardPage() {
  const [jobs, setJobs] = useState([]);
  const [city, setCity] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchJobs = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getJobs(city, type, page);
      setJobs(data.jobs || []);
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setError('Failed to fetch jobs. Please try again later.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
  }, [page]);

  const handleSearch = (e) => {
    e.preventDefault();
    if (page === 1) {
      fetchJobs();
    } else {
      setPage(1); // this will trigger the useEffect
    }
  };

  return (
    <div className="container">
      <h1>Job Board</h1>
      <p>Discover the latest opportunities across courts, law firms, and legal tech.</p>

      <div className="card" style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '10px', width: '100%' }}>
          <input
            type="text"
            placeholder="City (e.g. Delhi, Mumbai)"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            style={{ flex: 1 }}
          />
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: '200px' }}>
            <option value="">All Job Types</option>
            <option value="full_time">Full Time</option>
            <option value="internship">Internship</option>
            <option value="contract">Contract</option>
          </select>
          <button type="submit" disabled={loading}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </div>

      {error && <p className="error">{error}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
        {jobs.length === 0 && !loading && !error && (
          <div className="card" style={{ textAlign: 'center' }}>
            <p>No jobs found. Try adjusting your search filters.</p>
          </div>
        )}

        {jobs.map((job) => (
          <div key={job.job_id} className="card">
            <h3 style={{ marginBottom: '8px' }}>{job.title}</h3>
            <p style={{ margin: '0 0 10px 0', color: 'var(--secondary-color)' }}>
              {job.firm} {job.location && `• ${job.location}`} {job.job_type && `• ${job.job_type.replace('_', ' ')}`}
            </p>
            <p style={{ margin: '0 0 15px 0', fontSize: '14px', color: 'var(--secondary-color)' }}>
              Source: {job.source_api || job.source_type || 'Direct'} 
              {job.fetched_at && ` • Posted: ${new Date(job.fetched_at).toLocaleDateString()}`}
            </p>
            {job.apply_url ? (
              <a href={job.apply_url} target="_blank" rel="noopener noreferrer">
                <button>Apply Now</button>
              </a>
            ) : (
              <button disabled>Application Link Unavailable</button>
            )}
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1 || loading}>
            Previous
          </button>
          <span>Page {page} of {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages || loading}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
