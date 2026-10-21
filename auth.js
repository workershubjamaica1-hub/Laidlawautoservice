// auth.js — user accounts: password hashing, signed session tokens, login/register/logout routes
// and the requireAuth / requireRole middleware. Users live in the Supabase "users" table (see schema-users.sql).
//
// Roles:  customer  = own vehicles and requests only
//         staff     = sees every vehicle and request, can update request status
//         admin     = everything, plus deleting records and managing users
const crypto = require('crypto');
const { statusOf, premiumStatusOf } = require('./subscriptionConfig');
const mailer = require('./mailer');
const express = require('express');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ROLES = ['customer', 'staff', 'admin', 'vendor'];
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
// Random secret = everyone is signed out when the server restarts. Set ADMIN_SECRET to keep sessions.
const SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');

// --- Passwords (scrypt, built into Node: no extra packages) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
// Burned when the email doesn't exist, so a wrong email and a wrong password take the same time
const DUMMY_HASH = hashPassword('not-a-real-password');

// --- Tokens: "<base64url JSON {uid, exp}>.<signature>". Logging out revokes a token until it would expire. ---
const sign = payload => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const revoked = new Map(); // token -> expiry
function makeToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload)) || revoked.has(token)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() ? { uid, exp } : null;
  } catch (_) { return null; }
}
const tokenFrom = req => (req.get('authorization') || '').replace(/^Bearer /i, '');

const PARISHES = ['Kingston', 'St. Andrew', 'St. Thomas', 'Portland', 'St. Mary', 'St. Ann', 'Trelawny',
  'St. James', 'Hanover', 'Westmoreland', 'St. Elizabeth', 'Manchester', 'Clarendon', 'St. Catherine'];
// What a service member can do (roadside and towing match the emergency buttons)
const SPECIALTIES = [
  { value: 'diagnostics', label: 'Diagnostics' }, { value: 'mechanical', label: 'Mechanical' },
  { value: 'tire', label: 'Tire' }, { value: 'electrical', label: 'Electrical' },
  { value: 'maintenance', label: 'Maintenance' }, { value: 'roadside', label: 'Roadside assistance' },
  { value: 'towing', label: 'Wrecker / towing' }
];
// Email verification: a 6-digit code is emailed when someone signs up. Off until VERIFY_EMAIL=true (and email is set up, see EMAIL.md).
const VERIFY = {
  enabled: String(process.env.VERIFY_EMAIL || '').toLowerCase() === 'true',
  ttlMs: (Number(process.env.EMAIL_CODE_TTL_MINUTES) > 0 ? Number(process.env.EMAIL_CODE_TTL_MINUTES) : 10) * 60 * 1000,
  cooldownMs: (process.env.EMAIL_RESEND_SECONDS !== undefined && Number.isFinite(Number(process.env.EMAIL_RESEND_SECONDS)) ? Number(process.env.EMAIL_RESEND_SECONDS) : 60) * 1000,
  maxAttempts: 5
};
const PARTS = { enabled: String(process.env.PARTS_ENABLED || '').toLowerCase() === 'true' };
const BUSINESS = process.env.BUSINESS_NAME || 'AutoAid 24/7';
const TERMS_VERSION = '2026-10-21';   // bump when the Terms or Privacy Notice change in a way people should agree to again
const PHOTO_BUCKET = 'chassis-photos';
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const profileComplete = u => !!(u.phone && u.address && u.parish && u.chassis_photo_path);
const publicUser = u => ({
  id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, createdAt: u.created_at,
  phone: u.phone || '', address: u.address || '', parish: u.parish || '',
  hasChassisPhoto: !!u.chassis_photo_path, hasAvatar: !!u.avatar_path,
  approved: u.approved !== false,
  emailVerified: u.email_verified !== false,
  subscriptionPaidUntil: u.subscription_paid_until || null,
  termsAcceptedAt: u.terms_accepted_at || null,   // when they agreed to the Terms and Privacy Notice
  subscription: u.role === 'staff' ? statusOf(u) : null,   // only service providers have one
  premium: u.role === 'customer' ? premiumStatusOf(u) : null, premiumPaidUntil: u.premium_paid_until || null,   // only customers can be Premium members
  specialties: u.specialties ? u.specialties.split(',') : [],
  businessName: u.business_name || '', experience: u.experience || '',
  // Customers must have all four before the shop can send someone out
  profileComplete: u.role !== 'customer' || profileComplete(u)
});
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

// Checks phone, address and parish. With required:true all three must be given.
// Returns { error } or { value } holding only the fields that were provided.
function checkContact(body, required) {
  const value = {};
  if (required || body.phone !== undefined) {
    const phone = String(body.phone || '').trim();
    const digits = phone.replace(/\D/g, '').length;
    if (!/^\+?[\d\s\-().]{7,25}$/.test(phone) || digits < 7 || digits > 15) return { error: 'Enter a valid phone number, e.g. 876-555-0123.' };
    value.phone = phone;
  }
  if (required || body.address !== undefined) {
    const address = String(body.address || '').trim();
    if (address.length < 5 || address.length > 200) return { error: 'Enter your address (street, community or town).' };
    value.address = address;
  }
  if (required || body.parish !== undefined) {
    if (!PARISHES.includes(body.parish)) return { error: 'Choose your parish.' };
    value.parish = body.parish;
  }
  return { value };
}

// Reads { image: "<base64>" } from a request body. Returns { buf, type } or { error, status }.
function readImage(body) {
  const b64 = String((body && body.image) || '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { error: 'Choose a photo first.', status: 400 };
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'That photo is too large. Try a smaller one (under 4 MB).', status: 413 };
  const type = sniffImage(buf);
  if (!type) return { error: 'The file must be a JPEG, PNG or WebP photo.', status: 400 };
  return { buf, type };
}

// A money amount in JMD. Blank means "not given". Returns { value } (null if blank) or { error }.
function parseAmount(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { value: null };
  const n = Number(String(v).replace(/[,\s]|J\$/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10000000) return { error: 'Enter the amount charged in Jamaican dollars, e.g. 12500.' };
  return { value: Math.round(n * 100) / 100 };
}

// Reads the first bytes so only real JPEG, PNG or WebP images are accepted (not just a file name)
function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

// Limits repeated attempts per IP (and kind): `max` failures, then locked for `lockMs`
function makeLimiter(max, lockMs) {
  const hits = new Map();
  return {
    locked(key) { const r = hits.get(key); return !!r && r.count >= max && Date.now() - r.last < lockMs; },
    fail(key) {
      const r = hits.get(key);
      const fresh = !r || Date.now() - r.last >= lockMs;
      hits.set(key, { count: (fresh ? 0 : r.count) + 1, last: Date.now() });
    },
    clear(key) { hits.delete(key); }
  };
}

module.exports = function createAuth({ supabase, handle }) {
  const loginLimit = makeLimiter(5, 15 * 60 * 1000);
  const signupLimit = makeLimiter(10, 60 * 60 * 1000);

  const findByEmail = async email => {
    const { data, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    if (error) throw error;
    return data;
  };
  const findById = async id => {
    const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  };
  async function createUser({ name, email, password, role, phone, address, parish, approved, specialties, businessName, experience, termsAcceptedAt, emailVerified }) {
    const { data, error } = await supabase.from('users')
      .insert({
        name, email, password_hash: hashPassword(password), role,
        phone: phone || null, address: address || null, parish: parish || null,
        approved: approved !== false, specialties: specialties || null,
        business_name: businessName || null, experience: experience || null,
        email_verified: emailVerified !== false,
        terms_accepted_at: termsAcceptedAt || null, terms_version: termsAcceptedAt ? TERMS_VERSION : null
      })
      .select().single();
    if (error) throw error;
    return data;
  }

  // Checks the token, loads the user fresh (so a deleted or deactivated user is locked out immediately)
  // and puts them on req.user.
  const requireAuth = async (req, res, next) => {
    try {
      const t = readToken(tokenFrom(req));
      const user = t && await findById(t.uid);
      if (!user || !user.active || user.approved === false || user.email_verified === false) return res.status(401).json({ error: 'Please sign in.' });
      req.user = user;
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
    }
  };
  // Usage: app.get('/x', ...requireRole('staff', 'admin'), handler)
  const requireRole = (...roles) => [requireAuth, (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this.' });
    next();
  }];

  // Staff and admin routes. A service provider whose subscription is not active is stopped here (HTTP 402).
  const requireWorker = [requireAuth, (req, res, next) => {
    if (req.user.role !== 'staff' && req.user.role !== 'admin') return res.status(403).json({ error: 'You do not have access to this.' });
    if (statusOf(req.user).restricted) {
      return res.status(402).json({ error: 'Your subscription is not active. Pay your monthly fee to keep taking jobs.', code: 'subscription_required' });
    }
    next();
  }];

  // Creates the first admin (and, in development only, demo logins) when the users table is empty of them.
  // Existing accounts are never changed, so changing ADMIN_PASSWORD later does not reset an existing admin.
  async function seed() {
    const adminPassword = process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? '' : 'admin123');
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@laidlaw.local').trim().toLowerCase();
    const accounts = [];
    if (adminPassword) accounts.push({ name: 'Administrator', email: adminEmail, password: adminPassword, role: 'admin' });
    else console.warn('ADMIN_PASSWORD is not set: no admin account will be created.');
    if (!IS_PRODUCTION) {
      accounts.push({ name: 'Demo Staff', email: 'staff@laidlaw.local', password: 'staff123', role: 'staff', parish: 'Kingston', phone: '876-555-0100' });
      accounts.push({ name: 'Demo Customer', email: 'customer@laidlaw.local', password: 'customer123', role: 'customer',
        phone: '876-555-0123', address: '1 Hope Road, Kingston', parish: 'Kingston' });
    }
    // Private storage for chassis photos (nobody can open it without a signed link)
    const { error: bucketError } = await supabase.storage.createBucket(PHOTO_BUCKET, { public: false });
    if (bucketError && !/already exists|duplicate/i.test(bucketError.message || '')) console.error('Could not create the chassis-photos bucket:', bucketError.message);
    for (const a of accounts) {
      if (!(await findByEmail(a.email))) {
        await createUser(a);
        console.log(`Created ${a.role} account ${a.email}${IS_PRODUCTION ? '' : ` (dummy password "${a.password}")`}`);
      }
    }
  }

  // Signed links expire after 5 minutes; the bucket itself stays private
  async function signedPhotoUrl(path) {
    if (!path) return null;
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, 300);
    if (error) throw error;
    return data.signedUrl;
  }
  async function storePhoto(path, buf, type) {
    const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, buf, { contentType: type, upsert: true });
    if (up.error) throw up.error;
  }
  async function removePhoto(path) {
    if (path) await supabase.storage.from(PHOTO_BUCKET).remove([path]);
  }

  // --- Email verification codes ---
  const verifyLimit = makeLimiter(10, 15 * 60 * 1000);   // wrong codes per address
  const resendLimit = makeLimiter(10, 60 * 60 * 1000);   // "send me a code" requests per address
  const codeHash = (userId, code) => crypto.createHmac('sha256', SECRET).update(`verify:${userId}:${code}`).digest('hex');

  // Makes a new code, saves only a scrambled copy of it, and emails the real one.
  // Returns { sent: true } | { sent: false, wait: seconds } (asked too soon) | { sent: false, failed: true } (email service problem)
  async function sendCode(user) {
    const since = user.verify_sent_at ? Date.now() - Date.parse(user.verify_sent_at) : Infinity;
    if (since < VERIFY.cooldownMs) return { sent: false, wait: Math.max(1, Math.ceil((VERIFY.cooldownMs - since) / 1000)) };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const save = await supabase.from('users').update({
      verify_code_hash: codeHash(user.id, code), verify_expires_at: new Date(Date.now() + VERIFY.ttlMs).toISOString(),
      verify_attempts: 0, verify_sent_at: new Date().toISOString()
    }).eq('id', user.id);
    if (save.error) throw save.error;
    const minutes = Math.max(1, Math.round(VERIFY.ttlMs / 60000));
    const text = `Your ${BUSINESS} verification code is ${code}.\n\nIt expires in ${minutes} minutes. If you did not try to sign up, you can ignore this email.`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0F1B2D">
      <h2 style="margin:0 0 12px;color:#0B2545">${BUSINESS}</h2>
      <p style="margin:0 0 16px">Use this code to verify your email address:</p>
      <p style="font-size:34px;font-weight:800;letter-spacing:8px;margin:0 0 16px;color:#0F6FDE">${code}</p>
      <p style="margin:0;color:#55657B;font-size:14px">It expires in ${minutes} minutes. If you did not try to sign up, you can ignore this email.</p></div>`;
    try {
      await mailer.sendMail({ to: user.email, subject: `Your ${BUSINESS} code: ${code}`, text, html });
      return { sent: true };
    } catch (err) {
      console.error('Could not send the verification email:', err.message);
      await supabase.from('users').update({ verify_sent_at: null }).eq('id', user.id);   // let them ask again straight away
      return { sent: false, failed: true };
    }
  }
  const notReady = res => res.status(503).json({ error: 'Email verification is not set up yet. Please contact AutoAid 24/7.' });
  // A sign-up that was never verified holds no data, so signing up again with the same email simply replaces it.
  // (This stops someone from "squatting" on another person's email address.)
  async function replaceUnverified(existing, fields) {
    const { data, error } = await supabase.from('users').update(fields).eq('id', existing.id).select().single();
    if (error) throw error;
    return data;
  }

  // --- /auth routes ---
  const router = express.Router();

  router.post('/register', handle(async (req, res) => {
    if (signupLimit.locked(req.ip)) return res.status(429).json({ error: 'Too many sign-ups. Try again later.' });
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your name.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (req.body.agreed !== true) return res.status(400).json({ error: 'Please agree to the Terms and the Privacy Notice to create an account.' });
    const contact = checkContact(req.body, true);
    if (contact.error) return res.status(400).json({ error: contact.error });
    if (VERIFY.enabled && !mailer.ready()) return notReady(res);
    const existing = await findByEmail(email);
    if (existing && !(VERIFY.enabled && existing.email_verified === false && existing.role === 'customer')) {
      signupLimit.fail(req.ip);
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    }
    const now = new Date().toISOString();
    const user = existing
      ? await replaceUnverified(existing, { name, password_hash: hashPassword(password), phone: contact.value.phone, address: contact.value.address, parish: contact.value.parish, terms_accepted_at: now, terms_version: TERMS_VERSION })
      : await createUser({ name, email, password, role: 'customer', termsAcceptedAt: now, emailVerified: !VERIFY.enabled, ...contact.value }); // sign-up is always a customer
    signupLimit.fail(req.ip); // counts every sign-up toward the hourly limit
    if (VERIFY.enabled) {
      const sent = await sendCode(user);
      return res.status(201).json({ verificationRequired: true, email, emailSent: !!sent.sent || !!sent.wait });
    }
    res.status(201).json({ token: makeToken(user.id), user: publicUser(user) });
  }));

  // A professional applies to do jobs. They cannot sign in until an admin approves them.
  router.get('/specialties', (req, res) => res.json(SPECIALTIES));
  router.post('/register-technician', handle(async (req, res) => {
    if (signupLimit.locked(req.ip)) return res.status(429).json({ error: 'Too many sign-ups. Try again later.' });
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your name.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (req.body.agreed !== true) return res.status(400).json({ error: 'Please agree to the Terms and the Privacy Notice to apply.' });
    const contact = checkContact(req.body, true);
    if (contact.error) return res.status(400).json({ error: contact.error });
    const allowed = SPECIALTIES.map(s => s.value);
    const specialties = [...new Set((Array.isArray(req.body.specialties) ? req.body.specialties : []).filter(v => allowed.includes(v)))];
    if (!specialties.length) return res.status(400).json({ error: 'Choose at least one kind of work you do.' });
    const businessName = String(req.body.businessName || '').trim().slice(0, 100);
    const experience = String(req.body.experience || '').trim().slice(0, 600);
    if (experience.length < 10) return res.status(400).json({ error: 'Tell us a little about your experience and qualifications.' });
    if (VERIFY.enabled && !mailer.ready()) return notReady(res);
    const existing = await findByEmail(email);
    if (existing && !(VERIFY.enabled && existing.email_verified === false && existing.role === 'staff')) {
      signupLimit.fail(req.ip);
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    }
    const now = new Date().toISOString();
    const user = existing
      ? await replaceUnverified(existing, { name, password_hash: hashPassword(password), phone: contact.value.phone, address: contact.value.address, parish: contact.value.parish,
          specialties: specialties.join(','), business_name: businessName || null, experience, terms_accepted_at: now, terms_version: TERMS_VERSION })
      : await createUser({ name, email, password, role: 'staff', approved: false, specialties: specialties.join(','), businessName, experience, termsAcceptedAt: now, emailVerified: !VERIFY.enabled, ...contact.value });
    signupLimit.fail(req.ip);
    if (VERIFY.enabled) {
      const sent = await sendCode(user);
      return res.status(201).json({ pending: true, verificationRequired: true, email, emailSent: !!sent.sent || !!sent.wait });
    }
    res.status(201).json({ pending: true });
  }));

  // A parts vendor applies to sell parts. Like a technician, they cannot sign in until an admin approves them.
  router.post('/register-vendor', handle(async (req, res) => {
    if (!PARTS.enabled) return res.status(404).json({ error: 'Parts ordering is not switched on yet.' });
    if (signupLimit.locked(req.ip)) return res.status(429).json({ error: 'Too many sign-ups. Try again later.' });
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your name.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (req.body.agreed !== true) return res.status(400).json({ error: 'Please agree to the Terms and the Privacy Notice to apply.' });
    const contact = checkContact(req.body, true);
    if (contact.error) return res.status(400).json({ error: contact.error });
    const businessName = String(req.body.businessName || '').trim().slice(0, 100);
    if (businessName.length < 2) return res.status(400).json({ error: 'Enter the name of your parts business.' });
    const experience = String(req.body.experience || '').trim().slice(0, 600);
    if (experience.length < 10) return res.status(400).json({ error: 'Tell us what parts you sell (makes, models, new or used).' });
    if (VERIFY.enabled && !mailer.ready()) return notReady(res);
    const existing = await findByEmail(email);
    if (existing && !(VERIFY.enabled && existing.email_verified === false && existing.role === 'vendor')) {
      signupLimit.fail(req.ip);
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    }
    const now = new Date().toISOString();
    const user = existing
      ? await replaceUnverified(existing, { name, password_hash: hashPassword(password), phone: contact.value.phone, address: contact.value.address, parish: contact.value.parish,
          business_name: businessName, experience, terms_accepted_at: now, terms_version: TERMS_VERSION })
      : await createUser({ name, email, password, role: 'vendor', approved: false, businessName, experience, termsAcceptedAt: now, emailVerified: !VERIFY.enabled, ...contact.value });
    signupLimit.fail(req.ip);
    if (VERIFY.enabled) {
      const sent = await sendCode(user);
      return res.status(201).json({ pending: true, verificationRequired: true, email, emailSent: !!sent.sent || !!sent.wait });
    }
    res.status(201).json({ pending: true });
  }));

  // Enter the code from the email. A customer is signed in; a service provider's application moves on to admin approval.
  router.post('/verify', handle(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').replace(/\s+/g, '');
    if (verifyLimit.locked(req.ip)) return res.status(429).json({ error: 'Too many wrong codes. Ask for a new code in a few minutes.' });
    const user = email ? await findByEmail(email) : null;
    const wrong = left => { verifyLimit.fail(req.ip); return res.status(400).json({ error: 'That code is not right. Check the newest email and try again.', attemptsLeft: left }); };
    if (!user || user.email_verified !== false || !/^\d{6}$/.test(code)) return wrong();
    if (!user.verify_code_hash || !user.verify_expires_at || Date.parse(user.verify_expires_at) < Date.now()) {
      return res.status(400).json({ error: 'That code has expired. Ask for a new one.', code: 'expired' });
    }
    const used = user.verify_attempts || 0;
    if (used >= VERIFY.maxAttempts) return res.status(429).json({ error: 'Too many wrong tries for that code. Ask for a new one.', code: 'locked' });
    if (!safeEqual(codeHash(user.id, code), user.verify_code_hash)) {
      await supabase.from('users').update({ verify_attempts: used + 1 }).eq('id', user.id);
      return wrong(VERIFY.maxAttempts - used - 1);
    }
    const { data, error } = await supabase.from('users')
      .update({ email_verified: true, verify_code_hash: null, verify_expires_at: null, verify_attempts: 0 }).eq('id', user.id).select().single();
    if (error) throw error;
    verifyLimit.clear(req.ip);
    if (data.role === 'staff' || data.role === 'vendor' || data.approved === false) return res.json({ verified: true, pending: data.approved === false });   // providers wait for approval
    if (!data.active) return res.status(403).json({ error: 'This account has been disabled. Contact the shop.' });
    res.json({ verified: true, token: makeToken(data.id), user: publicUser(data) });
  }));

  // "Send me a new code". Always answers the same way, so it cannot be used to find out who has an account.
  router.post('/resend', handle(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (resendLimit.locked(req.ip)) return res.status(429).json({ error: 'Too many requests. Try again in an hour.' });
    resendLimit.fail(req.ip);
    const user = email ? await findByEmail(email) : null;
    if (!VERIFY.enabled || !user || user.email_verified !== false) return res.json({ ok: true, emailSent: true });
    if (!mailer.ready()) return notReady(res);
    const r = await sendCode(user);
    if (r.wait) return res.status(429).json({ error: `Please wait ${r.wait} seconds before asking for another code.`, wait: r.wait });
    res.json({ ok: true, emailSent: !!r.sent });
  }));

  router.post('/login', handle(async (req, res) => {
    if (loginLimit.locked(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const user = email ? await findByEmail(email) : null;
    const ok = checkPassword(password, user ? user.password_hash : DUMMY_HASH) && !!user;
    if (!ok) {
      loginLimit.fail(req.ip);
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    if (user.email_verified === false) {
      if (VERIFY.enabled && mailer.ready()) await sendCode(user);   // (does nothing if a code was just sent)
      return res.status(403).json({ error: 'Please verify your email address first. We sent you a 6-digit code.', code: 'email_unverified', email: user.email });
    }
    if (user.approved === false) return res.status(403).json({ error: 'Your application is still waiting for approval. You can sign in once an admin approves it.' });
    if (!user.active) return res.status(403).json({ error: 'This account has been disabled. Contact the shop.' });
    loginLimit.clear(req.ip);
    res.json({ token: makeToken(user.id), user: publicUser(user) });
  }));

  router.post('/logout', (req, res) => {
    const token = tokenFrom(req);
    const t = readToken(token);
    if (t) {
      for (const [k, exp] of revoked) if (exp <= Date.now()) revoked.delete(k); // tidy up expired entries
      revoked.set(token, t.exp);
    }
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
  router.get('/parishes', (req, res) => res.json(PARISHES));

  // The technicians (staff) working in the signed-in customer's parish
  router.get('/technicians', requireAuth, handle(async (req, res) => {
    if (!req.user.parish) return res.json([]);
    const { data, error } = await supabase.from('users').select('name, phone, role, approved, subscription_paid_until')
      .eq('role', 'staff').eq('active', true).eq('parish', req.user.parish).order('name');
    if (error) throw error;
    res.json(data.filter(t => t.approved !== false && !statusOf(t).restricted).map(t => ({ name: t.name, phone: t.phone || '' })));
  }));

  // Customers (and staff) update their own contact details
  router.patch('/profile', requireAuth, handle(async (req, res) => {
    const update = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your name.' });
      update.name = name;
    }
    const contact = checkContact(req.body, false);
    if (contact.error) return res.status(400).json({ error: contact.error });
    Object.assign(update, contact.value);
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to change.' });
    const { data, error } = await supabase.from('users').update(update).eq('id', req.user.id).select().single();
    if (error) throw error;
    res.json({ user: publicUser(data) });
  }));

  // Photos are sent by the browser as base64 JSON, already shrunk. column = which users column keeps the path.
  const receivePhoto = (column, name) => async (req, res) => {
    const b64 = String((req.body && req.body.image) || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Choose a photo first.' });
    if (buf.length > MAX_PHOTO_BYTES) return res.status(413).json({ error: 'That photo is too large. Try a smaller one (under 4 MB).' });
    const type = sniffImage(buf);
    if (!type) return res.status(400).json({ error: 'The file must be a JPEG, PNG or WebP photo.' });
    const path = `user-${req.user.id}/${name}`;
    const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, buf, { contentType: type, upsert: true });
    if (up.error) throw up.error;
    const { data, error } = await supabase.from('users').update({ [column]: path }).eq('id', req.user.id).select().single();
    if (error) throw error;
    res.json({ user: publicUser(data) });
  };
  const bigJson = express.json({ limit: '6mb' });
  // Photo of the chassis (VIN) number
  router.post('/chassis-photo', requireAuth, bigJson, handle(receivePhoto('chassis_photo_path', 'chassis')));
  // Optional profile photo (technicians show it to customers)
  router.post('/avatar', requireAuth, bigJson, handle(receivePhoto('avatar_path', 'avatar')));
  router.get('/avatar', requireAuth, handle(async (req, res) => {
    const url = await signedPhotoUrl(req.user.avatar_path);
    if (!url) return res.status(404).json({ error: 'No profile photo yet.' });
    res.json({ url });
  }));

  // A short-lived link to view your own chassis photo
  router.get('/chassis-photo', requireAuth, handle(async (req, res) => {
    const url = await signedPhotoUrl(req.user.chassis_photo_path);
    if (!url) return res.status(404).json({ error: 'No photo uploaded yet.' });
    res.json({ url });
  }));

  return { router, requireAuth, requireRole, requireWorker, seed, createUser, findByEmail, hashPassword, publicUser, validEmail, checkContact, parseAmount, readImage, storePhoto, signedPhotoUrl, removePhoto, ROLES, PARISHES, SPECIALTIES, PARTS };
};
