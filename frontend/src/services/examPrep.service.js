import api from './api';
export const getQuestions = (params) => api.get('/api/exam/questions', { params }).then(r => r.data);
export const submitAttempt = (payload) => api.post('/api/exam/submit', payload).then(r => r.data);
export const getAnalytics = () => api.get('/api/exam/analytics').then(r => r.data);
