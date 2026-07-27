const request = require('supertest');
const app = require('../app');
const { pool } = require('../config/db');

describe('Health Check', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('should return 200 on /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });
});
