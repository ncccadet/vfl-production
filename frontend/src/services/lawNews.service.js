import api from './api';
export const getNews = (params) => api.get('/api/law-news', { params }).then(r => r.data);
export const getNewsArticle = (id) => api.get(`/api/law-news/${id}`).then(r => r.data);
