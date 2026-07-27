require('dotenv').config();

console.log('Starting background workers...');

require('./workers/resumeAnalyzer.worker');
require('./workers/draftingLab.worker');
require('./workers/aiInterviewer.worker');
require('./workers/lawNews.worker');
require('./workers/otp.worker');
require('./workers/jobScraper.worker');

console.log('All background workers started successfully.');
