import api from './api';
export const getJobs = (city, type, page) => api.get('/api/jobs', { params: { city, type, page } }).then(r => r.data);
