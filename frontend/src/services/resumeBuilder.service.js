/**
 * resumeBuilder.service.js
 * All API calls for the resumeBuilder feature go here.
 * Pages import from this file — never call api directly in a page component.
 *
 * No daily limit on buildResume() — callable as many times as the student
 * wants (see _contracts/07-resume-builder.md). saveDraft() is free/unlimited
 * and was always that way (never an AI call).
 */
import api from './api';

export const getTemplates = () =>
  api.get('/api/resume-builder/templates').then((res) => res.data);

export const getDraft = () =>
  api.get('/api/resume-builder/draft').then((res) => res.data);

export const saveDraft = (draft) =>
  api.post('/api/resume-builder/draft', draft).then((res) => res.data);

// Template is chosen at Build time, not up front — same saved draft can be
// rendered into any template without re-filling the form.
export const buildResume = (templateId) =>
  api.post('/api/resume-builder/build', { template_id: templateId }).then((res) => res.data);

export const getBuildResult = (buildId) =>
  api.get(`/api/resume-builder/result/${buildId}`).then((res) => res.data);

export const downloadResume = () =>
  api.get('/api/resume-builder/download').then((res) => res.data);

// ── Profile photo — client → S3 direct upload (project rule: uploads never
// pass through the API process). Two-step: ask the backend for a short-lived
// presigned PUT URL, then PUT the raw file straight to S3 with plain fetch
// (NOT the `api` axios instance — this call goes to S3, not our backend, so
// it must not carry our auth cookie or JSON headers).
export const getPhotoUploadUrl = (file) => {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const contentType = file.type || 'image/jpeg';
  return api
    .get(`/api/resume-builder/photo-upload-url?ext=${encodeURIComponent(ext)}&contentType=${encodeURIComponent(contentType)}`)
    .then((res) => res.data);
};

export const uploadPhotoToS3 = async (file) => {
  const { uploadUrl, photoKey } = await getPhotoUploadUrl(file);
  const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
  if (!putRes.ok) throw new Error('Photo upload failed.');
  return photoKey;
};

// Per-field "AI Enhance" button — sends ONE text box's current value, gets
// back a professionally rewritten version. No daily limit (same feature-wide
// policy); the backend caps input at 1,500 chars and output at 350 tokens.
export const enhanceText = (text) =>
  api.post('/api/resume-builder/enhance', { text }).then((res) => res.data);

// "AI Enhance All" — sends the WHOLE current draft and gets back the same draft
// with every free-text field rewritten into professional phrasing (summary,
// experience & volunteer bullets, achievements, education coursework/honors,
// skill formatting). Hard facts are never changed. No daily limit (same
// feature-wide policy). The page drops the returned draft straight back into
// the form fields. Replaces the old analyzeResume() score-and-tips call.
export const enhanceAll = (draftWire) =>
  api.post('/api/resume-builder/enhance-all', draftWire).then((res) => res.data);
