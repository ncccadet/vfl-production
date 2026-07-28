/**
 * resumeAnalyzer.service.js
 * All API calls for the Resume Analyzer feature. Pages import from here — never
 * call axios/fetch for our own API directly in a component.
 * Contract: _contracts/02-resume-analyzer.md
 */
import api from './api';

// Client-side guard rails (the worker re-validates everything server-side).
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MIN_FILE_BYTES = 10 * 1024;       // 10 KB

/**
 * Validate the chosen file before we even ask for an upload URL.
 * Returns an error string, or null if the file looks OK.
 */
export const validateFile = (file) => {
  if (!file) return 'Please choose a PDF file.';
  const isPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) return 'Only PDF résumés are accepted.';
  if (file.size > MAX_FILE_BYTES) return 'That file is larger than 5 MB. Please upload a smaller PDF.';
  if (file.size < MIN_FILE_BYTES) return 'That file looks too small to be a résumé.';
  return null;
};

// 1. Ask our API for a short-lived presigned S3 PUT URL.
export const getUploadUrl = () => api.get('/api/resume-analyzer/upload-url');

// 2. Upload the PDF straight to S3 (NOT through our API — no auth cookie needed).
//    The Content-Type MUST match the one the presigned URL was signed with.
export const uploadToS3 = async (uploadUrl, file) => {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: file,
  });
  if (!res.ok) throw new Error('Upload to storage failed. Please try again.');
};

// 3. Tell our API the upload is done → creates the pending analysis + enqueues the worker.
export const analyze = (s3Key) => api.post('/api/resume-analyzer/analyze', { s3Key });

// 4. Poll the result by doc_id.
export const getResult = (docId) => api.get(`/api/resume-analyzer/result/${docId}`);

// 5. List past analyses (metadata only).
export const getHistory = () => api.get('/api/resume-analyzer/history');
