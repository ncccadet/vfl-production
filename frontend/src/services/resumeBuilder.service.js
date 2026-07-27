import api from './api';
export const buildResume = (payload) => api.post('/api/resume-builder/build', payload).then(r => r.data);
export const getResume = () => api.get('/api/resume-builder/download').then(r => r.data);
