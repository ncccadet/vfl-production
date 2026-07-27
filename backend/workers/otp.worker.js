/**
 * otp.worker.js — background email sender.
 * Handles OTP (password reset) and welcome (new account) emails via AWS SES.
 * Uses aws-sdk v2, matching package.json. Region and sender come from .env.

 */
require('dotenv').config();

const { Worker } = require('bullmq');
const AWS = require('aws-sdk'); 

const ses = new AWS.SES({ region: process.env.AWS_REGION });
const SENDER_EMAIL = process.env.SES_FROM_EMAIL;

const sendEmail = async ({ to, subject, body }) => {
  await ses.sendEmail({
    Source: SENDER_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: body } }
    }
  }).promise();
};

const connection = require('../config/redisConnection')();

const otpWorker = new Worker('send-otp-email', async (job) => {
  const { email, otp } = job.data;
  await sendEmail({
    to: email,
    subject: 'Your VFL password reset code',
    body: `Your one-time code is ${otp}. It expires in 10 minutes.`
  });
}, { connection, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

const welcomeWorker = new Worker('send-welcome-email', async (job) => {
  const { email, password } = job.data;
  await sendEmail({
    to: email,
    subject: 'Your Voxera For Law account is ready',
    body: `Welcome to Voxera For Law.\n\nYour login email: ${email}\nYour temporary password: ${password}\n\nPlease log in and change your password as soon as possible.`
  });
}, { connection, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

[otpWorker, welcomeWorker].forEach((w) => {
  w.on('completed', (job) => console.log(`${job.queueName} job ${job.id} done`));
  w.on('failed', (job, err) => console.error(`${job?.queueName} job ${job?.id} failed:`, err.message));
});

console.log('OTP + welcome-email workers started, listening for jobs...');