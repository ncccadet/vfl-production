import api from './api';
export const startSession = (payload) => api.post('/api/court-simulation/start', payload).then(r => r.data);
export const submitArgument = (payload) => api.post('/api/court-simulation/turn', payload).then(r => r.data);
export const getSession = (id) => api.get(`/api/court-simulation/session/${id}`).then(r => r.data);
export const getHistory = () => api.get('/api/court-simulation/history').then(r => r.data);
