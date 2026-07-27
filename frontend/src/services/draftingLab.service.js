import api from './api';
export const getTemplates = (params) => api.get('/api/drafting-lab/templates', { params }).then(r => r.data);
export const getTemplate = (id) => api.get(`/api/drafting-lab/templates/${id}`).then(r => r.data);
export const verifyBlanks = (payload) => api.post('/api/drafting-lab/verify-blanks', payload).then(r => r.data);
export const generateCase = (payload) => api.post('/api/drafting-lab/case-study', payload).then(r => r.data);
export const submitCaseDraft = (payload) => api.post('/api/drafting-lab/case-study/submit', payload).then(r => r.data);
export const getCaseResult = (id) => api.get(`/api/drafting-lab/case-study/result/${id}`).then(r => r.data);
export const getHistory = () => api.get('/api/drafting-lab/history').then(r => r.data);
