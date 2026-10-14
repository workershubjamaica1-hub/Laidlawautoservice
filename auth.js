// auth.js — user accounts: password hashing, signed session tokens, login/register/logout routes
// and the requireAuth / requireRole middleware. Users live in the Supabase "users" table (see schema-users.sql).
//
// Roles:  customer  = own vehicles and requests only
//         staff     = sees every vehicle and request, can update request status
//         admin     = everything, plus deleting records and managing users
const crypto = require('crypto');
const express = require('express');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ROLES = ['customer', 'staff', 'admin'];
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
const PHOTO_BUCKET = 'chassis-photos';
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const profileComplete = u => !!(u.phone && u.address && u.parish && u.chassis_photo_path);
const publicUser = u => ({
  id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, createdAt: u.created_at,
  phone: u.phone || '', address: u.address || '', parish: u.parish || '',
  hasChassisPhoto: !!u.chassis_photo_path,
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
  async function createUser({ name, email, password, role, phone, address, parish }) {
    const { data, error } = await supabase.from('users')
      .insert({ name, email, password_hash: hashPassword(password), role, phone: phone || null, address: address || null, parish: parish || null })
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
      if (!user || !user.active) return res.status(401).json({ error: 'Please sign in.' });
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
  async function removePhoto(path) {
    if (path) await supabase.storage.from(PHOTO_BUCKET).remove([path]);
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
    const contact = checkContact(req.body, true);
    if (contact.error) return res.status(400).json({ error: contact.error });
    if (await findByEmail(email)) {
      signupLimit.fail(req.ip);
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    }
    const user = await createUser({ name, email, password, role: 'customer', ...contact.value }); // sign-up is always a customer
    signupLimit.fail(req.ip); // counts every sign-up toward the hourly limit
    res.status(201).json({ token: makeToken(user.id), user: publicUser(user) });
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
    const { data, error } = await supabase.from('users').select('name, phone')
      .eq('role', 'staff').eq('active', true).eq('parish', req.user.parish).order('name');
    if (error) throw error;
    res.json(data.map(t => ({ name: t.name, phone: t.phone || '' })));
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

  // Photo of the chassis (VIN) number. The browser shrinks it first; sent as base64 JSON.
  router.post('/chassis-photo', requireAuth, express.json({ limit: '6mb' }), handle(async (req, res) => {
    const b64 = String((req.body && req.body.image) || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Choose a photo first.' });
    if (buf.length > MAX_PHOTO_BYTES) return res.status(413).json({ error: 'That photo is too large. Try a smaller one (under 4 MB).' });
    const type = sniffImage(buf);
    if (!type) return res.status(400).json({ error: 'The file must be a JPEG, PNG or WebP photo.' });
    const path = `user-${req.user.id}/chassis`;
    const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, buf, { contentType: type, upsert: true });
    if (up.error) throw up.error;
    const { data, error } = await supabase.from('users').update({ chassis_photo_path: path }).eq('id', req.user.id).select().single();
    if (error) throw error;
    res.json({ user: publicUser(data) });
  }));

  // A short-lived link to view your own chassis photo
  router.get('/chassis-photo', requireAuth, handle(async (req, res) => {
    const url = await signedPhotoUrl(req.user.chassis_photo_path);
    if (!url) return res.status(404).json({ error: 'No photo uploaded yet.' });
    res.json({ url });
  }));

  return { router, requireAuth, requireRole, seed, createUser, findByEmail, hashPassword, publicUser, validEmail, checkContact, signedPhotoUrl, removePhoto, ROLES, PARISHES };
};
