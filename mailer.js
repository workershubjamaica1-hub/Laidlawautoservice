// mailer.js — sends email through an HTTPS email service (Brevo or Resend).
// Render's free plan blocks normal SMTP email ports, so we use the services' web APIs instead. See EMAIL.md for setup.
//
// Settings (environment variables):
//   EMAIL_PROVIDER    brevo | resend      (console = print to the server log; for local testing only, never in production)
//   EMAIL_API_KEY     the API key from that service
//   EMAIL_FROM        the address mail is sent from, e.g. no-reply@yourdomain.com (must be verified with the service)
//   EMAIL_FROM_NAME   the name people see (default: BUSINESS_NAME)
const PROVIDER = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
const API_KEY = (process.env.EMAIL_API_KEY || '').trim();
const FROM_EMAIL = (process.env.EMAIL_FROM || '').trim();
const FROM_NAME = (process.env.EMAIL_FROM_NAME || process.env.BUSINESS_NAME || 'AutoAid 24/7').trim();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEFAULT_URLS = { brevo: 'https://api.brevo.com/v3/smtp/email', resend: 'https://api.resend.com/emails' };
const API_URL = process.env.EMAIL_API_URL || DEFAULT_URLS[PROVIDER];   // EMAIL_API_URL is for testing against a fake server

// Can we actually send mail with the current settings?
const ready = () => (PROVIDER === 'console' && !IS_PRODUCTION) || (!!DEFAULT_URLS[PROVIDER] && !!API_KEY && !!FROM_EMAIL);

async function sendMail({ to, subject, text, html }) {
  if (PROVIDER === 'console' && !IS_PRODUCTION) {
    console.log(`[email to ${to}] ${subject}\n${text}`);
    return;
  }
  if (!ready()) throw new Error('Email is not set up (EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM).');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    let headers, body;
    if (PROVIDER === 'brevo') {
      headers = { 'api-key': API_KEY, 'content-type': 'application/json', accept: 'application/json' };
      body = { sender: { name: FROM_NAME, email: FROM_EMAIL }, to: [{ email: to }], subject, htmlContent: html, textContent: text };
    } else {
      headers = { authorization: 'Bearer ' + API_KEY, 'content-type': 'application/json' };
      body = { from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [to], subject, html, text };
    }
    const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(`${PROVIDER} answered ${res.status}: ${(await res.text()).slice(0, 240)}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendMail, ready, provider: PROVIDER };
