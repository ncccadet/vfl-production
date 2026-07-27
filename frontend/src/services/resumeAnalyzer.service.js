import api from './api';
export const getUploadUrl = () => api.get('/api/resume-analyzer/upload-url').then(r => r.data);
export const analyzeResume = (payload) => api.post('/api/resume-analyzer/analyze', payload).then(r => r.data);
export const getResult = (id) => api.get(`/api/resume-analyzer/result/${id}`).then(r => r.data);
export const getHistory = () => api.get('/api/resume-analyzer/history').then(r => r.data);
