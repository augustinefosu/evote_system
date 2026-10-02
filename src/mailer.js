// SMTP email with safe dev fallback (no extra config needed to run).
// Configure via env: SMTP_HOST, SMTP_PORT, SMTP_SECURE (true/false),
// SMTP_USER, SMTP_PASS, MAIL_FROM. When unconfigured, sendMail() logs
// instead of sending and reports { sent: false, reason: 'unconfigured' }.
const nodemailer = require('nodemailer');

const configured = Boolean(process.env.SMTP_HOST);

let transporter = null;
if (configured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
  });
}

const FROM = process.env.MAIL_FROM || 'University E-Voting <no-reply@university.edu>';
// APP_URL wins; on Render, RENDER_EXTERNAL_URL is injected automatically so
// emailed links are correct without extra setup.
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');

async function sendMail(to, subject, text, html) {
  if (!transporter) {
    console.log(`[mail:dev] to=${to} subject=${subject}\n${text}`);
    return { sent: false, reason: 'unconfigured' };
  }
  await transporter.sendMail({ from: FROM, to, subject, text, html: html || text });
  return { sent: true };
}

function verificationMail(name, token) {
  const link = `${APP_URL}/verify.html#${token}`;
  return {
    subject: 'Verify your E-Voting account',
    text: `Hello ${name},\n\nVerify your University E-Voting account with this token:\n${token}\n\nOr open: ${link}\n\nThis token expires in 24 hours.`,
    html: `<p>Hello ${name},</p><p>Verify your University E-Voting account with this token:</p><p><b>${token}</b></p><p><a href="${link}">Verify my account</a></p><p>This token expires in 24 hours.</p>`,
  };
}

function resetMail(name, token) {
  const link = `${APP_URL}/verify.html#reset-${token}`;
  return {
    subject: 'Reset your E-Voting password',
    text: `Hello ${name},\n\nReset your password with this token (valid 1 hour):\n${token}\n\nOr open: ${link}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Hello ${name},</p><p>Reset your password with this token (valid 1 hour):</p><p><b>${token}</b></p><p><a href="${link}">Reset my password</a></p><p>If you did not request this, ignore this email.</p>`,
  };
}

module.exports = { sendMail, verificationMail, resetMail, isConfigured: () => configured, APP_URL };
