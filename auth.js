// auth.js — admin login, signed session tokens and the requireAdmin middleware
const crypto = require('crypto');

// Dummy password for local development. Set ADMIN_PASSWORD in .env to change it,
// and ALWAYS change it before putting the site online.
const DEV_PASSWORD = 'admin123';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// In production there is no fallback: with no ADMIN_PASSWORD, login is disabled.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? '' : DEV_PASSWORD);
if (!process.env.ADMIN_PASSWORD) {
  console.warn(IS_PRODUCTION
    ? 'ADMIN_PASSWORD is not set: admin login is disabled.'
    : `ADMIN_PASSWORD not set in .env: using the dummy password "${DEV_PASSWORD}". Change it before going live.`);
}

// Random secret = everyone is signed out when the server restarts. Set ADMIN_SECRET to keep sessions.
const SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const sign = payload => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Tokens are "<expiry>.<signature>". Logging out adds the token to a revoked list until it would have expired.
const revoked = new Map(); // token -> expiry
function pruneRevoked() {
  const now = Date.now();
  for (const [t, exp] of revoked) if (exp <= now) revoked.delete(t);
}

function makeToken() {
  const payload = String(Date.now() + TOKEN_TTL_MS);
  return `${payload}.${sign(payload)}`;
}
function validToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  return Number(payload) > Date.now() && !revoked.has(token);
}
const tokenFrom = req => (req.get('authorization') || '').replace(/^Bearer /i, '');

function requireAdmin(req, res, next) {
  if (!validToken(tokenFrom(req))) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

// Slow down password guessing: 5 failed attempts per IP, then locked for 15 minutes
const failedLogins = new Map();
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

function login(req, res) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin login is disabled. Set ADMIN_PASSWORD on the server.' });
  const rec = failedLogins.get(req.ip);
  const locked = rec && Date.now() - rec.last < LOCK_MS;
  if (locked && rec.count >= MAX_FAILS) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  if (!safeEqual((req.body && req.body.password) || '', ADMIN_PASSWORD)) {
    failedLogins.set(req.ip, { count: (locked ? rec.count : 0) + 1, last: Date.now() });
    return res.status(401).json({ error: 'Wrong password.' });
  }
  failedLogins.delete(req.ip);
  res.json({ token: makeToken(), expiresInMs: TOKEN_TTL_MS });
}

function logout(req, res) {
  const token = tokenFrom(req);
  if (validToken(token)) {
    pruneRevoked();
    revoked.set(token, Number(token.split('.')[0]));
  }
  res.json({ ok: true });
}

module.exports = { login, logout, requireAdmin };
