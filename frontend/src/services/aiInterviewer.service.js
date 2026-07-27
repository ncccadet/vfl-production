import api from './api';
export const getOptions = () => api.get('/api/ai-interviewer/options').then(r => r.data);
export const startSession = (payload) => api.post('/api/ai-interviewer/start', payload).then(r => r.data);
export const getSession = (sessionId) => api.get(`/api/ai-interviewer/session/${sessionId}`).then(r => r.data);
export const submitAnswer = (payload) => api.post('/api/ai-interviewer/answer', payload).then(r => r.data);
export const getTTS = (text) => api.post('/api/ai-interviewer/tts', { text }, { responseType: 'blob' });
