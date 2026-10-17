const nodemailer = require('nodemailer');

// Emails player feedback to the developer. Configured from .env:
//   SMTP_USER / SMTP_PASS  sending account (for Gmail: an App Password,
//                          https://myaccount.google.com/apppasswords)
//   SMTP_HOST / SMTP_PORT  default smtp.gmail.com:465
//   FEEDBACK_EMAIL_TO      default hello.runiclabs@gmail.com
// Without SMTP_USER/SMTP_PASS feedback is only stored (FeedbackStore).
const FEEDBACK_EMAIL_TO = process.env.FEEDBACK_EMAIL_TO || 'hello.runiclabs@gmail.com';

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  const port = Number(process.env.SMTP_PORT) || 465;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

function mailerConfigured() {
  return !!getTransport();
}

function stars(rating) {
  return rating > 0 ? `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)` : 'no rating';
}

// Resolves true once sent; false when email isn't configured.
async function sendFeedbackEmail(entry) {
  const t = getTransport();
  if (!t) return false;
  const lines = [
    `Rating: ${stars(entry.rating)}`,
    '',
    entry.message,
    '',
    '---',
    `Player: ${entry.name || '(no name)'} (${entry.playerId})`,
    `App version: ${entry.appVersion || '?'}`,
    `Device: ${entry.device || '?'}`,
    `OS: ${entry.os || '?'}`,
    `Play time: ${entry.playMinutes ?? '?'} min, puzzles: ${entry.puzzles ?? '?'}`,
    `Sent: ${new Date(entry.createdAt).toISOString()}`,
  ];
  await t.sendMail({
    from: `"Word Search feedback" <${process.env.SMTP_USER}>`,
    to: FEEDBACK_EMAIL_TO,
    subject: `[Word Search] Feedback: ${stars(entry.rating)}`,
    text: lines.join('\n'),
  });
  return true;
}

module.exports = { sendFeedbackEmail, mailerConfigured };
