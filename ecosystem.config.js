module.exports = {
  apps: [
    {
      name: 'voxera-api',
      script: './backend/app.js',
      env_production: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'voxera-workers',
      script: './backend/worker.js',
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
