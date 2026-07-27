/**
 * api.js — Shared axios instance
 *
 * withCredentials: true is REQUIRED for httpOnly cookies to be sent.
 * Without it, the auth cookie is stripped from every request.
 *
 * All service files import this — never create a second axios instance.
 */
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
  withCredentials: true, // Critical: sends httpOnly cookie on every request
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const originalRequest = err.config;
    if (err.response?.status === 401 && !originalRequest._retry) {
      // If the refresh itself fails with 401, don't loop
      if (originalRequest.url === '/api/auth/refresh') {
        window.location.href = '/login';
        return Promise.reject(err);
      }
      
      originalRequest._retry = true;
      try {
        // Attempt to refresh the token using httpOnly cookie
        await api.post('/api/auth/refresh');
        // Retry the original request
        return api(originalRequest);
      } catch (refreshErr) {
        window.location.href = '/login';
        return Promise.reject(refreshErr);
      }
    }
    return Promise.reject(err);
  }
);

export default api;
