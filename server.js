// server.js — AutoAid 24/7
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const vehicleCatalog = require('./vehicleCatalog');

const app = express();

app.disable('x-powered-by');   // don't announce which framework runs the site

// Security headers on every response. The site and its API share one address, so the page may only talk to itself.
// (Inline scripts and styles are allowed because the pages use them; everything else is locked down.)
const SUPABASE_ORIGIN = (() => { try { return new URL(process.env.SUPABASE_URL).origin; } catch (_) { return ''; } })();
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: " + (SUPABASE_ORIGIN || 'https://*.supabase.co'),   // photos are shown through short-lived Supabase links
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
    'Content-Security-Policy': CSP
  });
  if (req.get('x-forwarded-proto') === 'https') res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// CORS: by default no other website may call this API (the site and its API live at the same address).
// To let another website or app call it, set CORS_ORIGIN in .env (comma-separated addresses).
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean);
if (corsOrigins.length) app.use(cors({ origin: corsOrigins }));

// The chassis photo upload (auth.js) has its own larger limit, so skip the small default for that one path
const smallJson = express.json();
const bigBodyPaths = /^\/(auth\/(chassis-photo|avatar)|jobs\/\d+\/photo|rentals\/(licence|my-vehicles\/\d+\/photos?(\/(front|back|left|right))?|bookings\/\d+\/photos)|admin\/jobs\/(service|emergency)\/\d+\/photo|webhooks\/fygaro)$/;
app.use((req, res, next) => (bigBodyPaths.test(req.path) ? next() : smallJson(req, res, next)));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// --- Supabase ---
// Uses the secret (service role) key, so this must only ever run on the server.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Database columns are snake_case; the API keeps camelCase for the frontend
const dateOnly = v => (v ? String(v).slice(0, 10) : null);
const toVehicle = r => ({ id: r.id, owner: r.owner, type: r.type, category: r.category, year: r.year, vin: r.vin, createdAt: r.created_at,
  reminders: { fitness: dateOnly(r.fitness_due), registration: dateOnly(r.registration_due), insurance: dateOnly(r.insurance_due), oil: dateOnly(r.oil_due) } });
const toRequest = r => ({
  id: r.id, vehicleId: r.vehicle_id, category: r.category, description: r.description, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  technicianId: r.technician_id || null, amount: r.amount == null ? null : Number(r.amount),
  rating: r.rating || null, review: r.review || '', completedAt: r.completed_at || null,
  hasWorkPhoto: !!r.work_photo_path,
  stage: r.stage || 'searching', urgent: !!r.urgent, parish: r.parish || '', locationText: r.location_text || '',
  quote: r.quote_amount == null ? null : { amount: Number(r.quote_amount), etaMinutes: r.quote_eta_minutes, note: r.quote_note || '' },
  etaDeadline: r.eta_deadline || null, agreedAt: r.agreed_at || null, doneAt: r.done_at || null, unread: !!r.customer_unread,
  premiumPerk: r.premium_perk || null,                       // 'oil' or 'brakes' when this job is a free Premium service
  platformPay: r.platform_pay == null ? null : Number(r.platform_pay)   // what AutoAid pays the technician for it
});

// Wraps async routes so database errors return a clean 500 instead of crashing
const handle = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

// --- Accounts (see auth.js). Customers only ever see their own data; staff and admins see everything. ---
// Remember why the email service refused a message (see mailer.js and the admin "Email check")
require('./mailer').onFailure(async ({ to, subject, error }) => {
  await supabase.from('email_failures').insert({ to_domain: String(to || '').split('@')[1] || null, subject: String(subject || '').replace(/\d{6}/g, '######').slice(0, 120), error: String(error || '').slice(0, 400) });
});

const auth = require('./auth')({ supabase, handle });
const { requireAuth } = auth;
// Parts vendors have their own pages and API. They must never reach the customer/staff routes below (which treat anyone who is not a customer as staff).
const noVendor = [requireAuth, (req, res, next) => (req.user.role === 'vendor' ? res.status(403).json({ error: 'You do not have access to this.' }) : next())];
app.use('/auth', auth.router);

// Monthly subscription for service providers (subscriptions.js). Off until SUBSCRIPTIONS_ENABLED=true.
const subs = require('./subscriptions')({ supabase, handle, auth });
app.use(subs.router);
const isCustomer = req => req.user.role === 'customer';

// Vehicle categories
const VEHICLE_CATEGORIES = [
  { value: 'car',         label: 'Car' },
  { value: 'suv',         label: 'SUV' },
  { value: 'van',         label: 'Van / minibus' },
  { value: 'bus',         label: 'Bus / coaster' },
  { value: 'motorcycle',  label: 'Motorcycle / ATV' },
  { value: 'light-truck', label: 'Pickup / light truck' },
  { value: 'small-truck', label: 'Small truck' },
  { value: 'heavy-truck', label: 'Heavy truck / equipment' },
  { value: 'other',       label: 'Other' }
];

// Service categories (edit this list to match what the shop offers)
const SERVICE_CATEGORIES = [
  { value: 'diagnostics', label: 'Diagnostics' },
  { value: 'mechanical',  label: 'Mechanical' },
  { value: 'tire',        label: 'Tire' },
  { value: 'electrical',  label: 'Electrical' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'bodywork',    label: 'Auto body repairs' },
  { value: 'roadside',    label: 'Roadside assistance' },
  { value: 'towing',      label: 'Wrecker / towing' },
  { value: 'other',       label: 'Other' }
];

const STATUSES = ['pending', 'in-progress', 'completed', 'cancelled'];
const isVehicleCategory = v => VEHICLE_CATEGORIES.some(c => c.value === v);
const isServiceCategory = v => SERVICE_CATEGORIES.some(c => c.value === v);

app.get('/categories', (req, res) => res.json({ vehicle: VEHICLE_CATEGORIES, service: SERVICE_CATEGORIES }));

// Common makes and models, grouped by vehicle category value ("car", "light-truck", ...).
// Edit vehicleCatalog.js to change the list. Only listed models can be registered.
const CATALOG_KEYS = { cars: 'car', suvs: 'suv', vans: 'van', buses: 'bus', motorcycles: 'motorcycle', lightTrucks: 'light-truck', smallTrucks: 'small-truck', heavyTrucks: 'heavy-truck' };
const CATALOG = Object.fromEntries(
  Object.entries(CATALOG_KEYS).map(([key, category]) => [category, vehicleCatalog[key] || []])
);
app.get('/vehicle-catalog', (req, res) => res.json(CATALOG));

// --- Vehicle search ---
// Matches typed text against the catalog: ignores case, spaces and dashes ("dmax", "c class"),
// matches partial words ("ken t6"), and tolerates one typo in longer words ("hilix").
const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function scoreModel(query, model) {
  const q = normalize(query);
  if (!q) return 0;
  const full = normalize(model);
  if (full === q) return 100;
  if (full.startsWith(q)) return 80;
  const words = model.toLowerCase().split(/[\s-]+/).map(normalize).filter(Boolean);
  const tokens = query.toLowerCase().split(/[\s-]+/).map(normalize).filter(Boolean);
  if (words.some(w => w.startsWith(q))) return 70;
  if (full.includes(q)) return 60;
  let fuzzy = false;
  const allMatch = tokens.every(t => {
    if (full.includes(t)) return true;
    if (t.length >= 4 && words.some(w => oneEditApart(t, w.slice(0, t.length)) || oneEditApart(t, w))) { fuzzy = true; return true; }
    return false;
  });
  if (!allMatch) return 0;
  return fuzzy ? 30 : 50;
}
function searchCatalog(catalog, query, limit = 8) {
  const results = [];
  for (const [category, models] of Object.entries(catalog)) {
    for (const name of models) {
      const score = scoreModel(query, name);
      if (score) results.push({ name, category, score });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}
function findExact(catalog, name) {
  const n = normalize(name);
  for (const [category, models] of Object.entries(catalog)) {
    const match = models.find(m => normalize(m) === n);
    if (match) return { name: match, category };
  }
  return null;
}

// Search the catalog: GET /vehicle-catalog/search?q=hilux
app.get('/vehicle-catalog/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json(q ? searchCatalog(CATALOG, q).map(({ name, category }) => ({ name, category })) : []);
});

// --- Vehicle Profiles ---
app.get('/vehicles', ...noVendor, handle(async (req, res) => {
  let query = supabase.from('vehicles').select('*').order('id');
  if (isCustomer(req)) query = query.eq('user_id', req.user.id);
  const { data, error } = await query;
  if (error) throw error;
  res.json(data.map(toVehicle));
}));

app.post('/vehicle', ...noVendor, handle(async (req, res) => {
  const { year, vin } = req.body;
  const owner = String(req.body.owner || req.user.name || '').trim();
  if (!owner || !req.body.type || !year) {
    return res.status(400).json({ error: 'Owner, make and model, and year are required.' });
  }
  // Find the vehicle in the Jamaica catalog. Case, spaces and dashes don't matter,
  // and the vehicle type (car, light truck...) comes from the catalog, not the request.
  let type, category;
  const found = findExact(CATALOG, req.body.type);
  if (found) {
    ({ name: type, category } = found);
  } else {
    // Not in our list: the customer may still add it, if they say what kind of vehicle it is
    const typed = String(req.body.type).trim().replace(/\s+/g, ' ');
    if (isVehicleCategory(req.body.category) && typed.length >= 3 && typed.length <= 60 && /^[\p{L}\p{N} .,'\/&+()-]+$/u.test(typed)) {
      type = typed; category = req.body.category;
    } else {
      const suggestions = searchCatalog(CATALOG, req.body.type, 3).map(r => r.name);
      return res.status(400).json({
        error: 'We could not find that vehicle.' + (suggestions.length ? ` Did you mean ${suggestions.join(', ')}? ` : ' ') + 'You can also choose "My vehicle isn\'t listed" and add it yourself.',
        code: 'not_listed', suggestions
      });
    }
  }
  const y = Number(year);
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(y) || y < 1900 || y > maxYear) {
    return res.status(400).json({ error: `Year must be between 1900 and ${maxYear}.` });
  }
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
    return res.status(400).json({ error: 'A VIN has 17 letters and numbers (no I, O or Q).' });
  }
  const { data, error } = await supabase.from('vehicles').insert({
    owner,
    user_id: req.user.id,
    type,                // must match vehicleCatalog.js exactly
    category,            // e.g. "small-truck"
    year: y,
    vin: (vin || '').toUpperCase()
  }).select().single();
  if (error) throw error;
  res.status(201).json(toVehicle(data));
}));

// Dates the customer wants to be reminded about (fitness, registration, insurance, next oil change)
app.patch('/vehicle/:id(\\d+)/reminders', ...noVendor, handle(async (req, res) => {
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'Only the owner can set reminders.' });
  const cols = { fitness: 'fitness_due', registration: 'registration_due', insurance: 'insurance_due', oil: 'oil_due' };
  const patch = {}, b = req.body || {};
  const thisYear = new Date().getFullYear();
  for (const [key, col] of Object.entries(cols)) {
    if (b[key] === undefined) continue;
    const v = b[key] === null ? '' : String(b[key]).trim();
    if (v === '') { patch[col] = null; continue; }
    const t = Date.parse(v + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) return res.status(400).json({ error: 'Use a real date for the ' + key + ' reminder.' });
    const y = Number(v.slice(0, 4));
    if (y < thisYear - 1 || y > thisYear + 10) return res.status(400).json({ error: 'That ' + key + ' date does not look right.' });
    patch[col] = v;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to save.' });
  const { data, error } = await supabase.from('vehicles').update(patch).eq('id', Number(req.params.id)).eq('user_id', req.user.id).select().maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Vehicle not found.' });
  res.json(toVehicle(data));
}));

app.delete('/vehicle/:id', ...noVendor, handle(async (req, res) => {
  if (req.user.role === 'staff') return res.status(403).json({ error: 'Only admins can remove vehicles.' });
  const id = Number(req.params.id);
  // Its service requests are removed automatically (ON DELETE CASCADE)
  let query = supabase.from('vehicles').delete().eq('id', id);
  if (isCustomer(req)) query = query.eq('user_id', req.user.id);
  const { data, error } = await query.select('id');
  if (error) throw error;
  if (!data.length) return res.status(404).json({ error: 'Vehicle not found.' });
  res.json({ deleted: id });
}));

// --- Service Requests ---
app.get('/service-requests', ...noVendor, handle(async (req, res) => {
  let query = supabase.from('service_requests').select('*').order('id');
  let extra = [];
  if (isCustomer(req)) {
    const mine = await supabase.from('vehicles').select('id').eq('user_id', req.user.id);
    if (mine.error) throw mine.error;
    query = query.in('vehicle_id', mine.data.map(v => v.id));
    const owned = await supabase.from('service_requests').select('*').eq('customer_id', req.user.id);   // emergencies have no vehicle
    if (owned.error) throw owned.error;
    extra = owned.data;
  }
  if (req.query.vehicleId) query = query.eq('vehicle_id', Number(req.query.vehicleId));
  let { data, error } = await query;
  if (error) throw error;
  if (extra.length) { const seen = new Set(data.map(r => r.id)); data = data.concat(extra.filter(r => !seen.has(r.id))).sort((a, b) => a.id - b.id); }
  const techIds = [...new Set(data.map(r => r.technician_id).filter(Boolean))];
  const techs = new Map();
  if (techIds.length) {
    const t = await supabase.from('users').select('id, name, phone, avatar_path').in('id', techIds);
    if (t.error) throw t.error;
    await Promise.all(t.data.map(async u => techs.set(u.id, {
      name: u.name, phone: u.phone || '', avatarUrl: await auth.signedPhotoUrl(u.avatar_path).catch(() => null)
    })));
  }
  res.json(await Promise.all(data.map(async r => ({
    ...toRequest(r), ...(isCustomer(req) ? { platformPay: null } : {}),
    technician: (t => (t && isCustomer(req) && !['agreed', 'working', 'done_pending', 'closed'].includes(r.stage) ? { ...t, phone: '' } : t))(techs.get(r.technician_id) || null),
    workPhotoUrl: r.work_photo_path ? await auth.signedPhotoUrl(r.work_photo_path).catch(() => null) : null
  }))));
}));

app.post('/service-request', ...noVendor, handle(async (req, res) => {
  const { vehicleId, category, description } = req.body;
  const vid = Number(vehicleId);
  const lat = Number(req.body.latitude), lng = Number(req.body.longitude);
  const hasCoords = req.body.latitude != null && req.body.longitude != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const where = String(req.body.locationText || req.user.address || '').trim().slice(0, 200);
  if (isCustomer(req) && where.length < 3 && !hasCoords) return res.status(400).json({ error: 'Tell us where the technician should come (street, community or landmark), or share your location.' });
  let vehicleQuery = supabase.from('vehicles').select('id, user_id').eq('id', vid);
  if (isCustomer(req)) vehicleQuery = vehicleQuery.eq('user_id', req.user.id);
  const { data: found, error: findError } = await vehicleQuery.maybeSingle();
  if (findError) throw findError;
  if (!found) {
    return res.status(400).json({ error: 'Choose a vehicle you have added.' });
  }
  if (!isServiceCategory(category)) {
    return res.status(400).json({ error: 'Choose a service category.' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'Describe what the vehicle is doing.' });
  }
  const { data, error } = await supabase.from('service_requests').insert({
    vehicle_id: vid,
    category,   // e.g. "diagnostics", "mechanical", "tire"
    description: description.trim(),
    customer_id: isCustomer(req) ? req.user.id : (found.user_id || null),
    parish: req.user.parish || null, location_text: where || null,
    latitude: hasCoords ? lat : null, longitude: hasCoords ? lng : null,
    stage: 'searching'
    // status defaults to 'pending' in the database
  }).select().single();
  if (error) throw error;
  require('./jobEvents').emit('new-job', data);   // alerts the technicians (see jobRoutes.js)
  res.status(201).json(toRequest(data));
}));

app.patch('/service-request/:id', ...noVendor, handle(async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
  }
  const id = Number(req.params.id);
  if (!isCustomer(req)) return res.status(403).json({ error: 'Staff update jobs from the technician portal.' });
  {
    // Customers can only cancel their own requests
    if (status !== 'cancelled') return res.status(403).json({ error: 'You can only cancel a request.' });
    const mine = await supabase.from('vehicles').select('id').eq('user_id', req.user.id);
    if (mine.error) throw mine.error;
    const one = await supabase.from('service_requests').select('id, stage, vehicle_id, customer_id').eq('id', id).maybeSingle();
    if (one.error) throw one.error;
    const own = { data: one.data && (one.data.customer_id === req.user.id || mine.data.some(v => v.id === one.data.vehicle_id)) ? one.data : null };
    if (!own.data) return res.status(404).json({ error: 'Request not found.' });
    if (!['searching', 'matched', 'quoted', 'agreed'].includes(own.data.stage || 'searching')) return res.status(409).json({ error: 'This job can no longer be cancelled here. Contact the shop.' });
  }
  // updated_at is set by a database trigger
  const { data, error } = await supabase.from('service_requests')
    .update({ status, stage: 'cancelled', fee_percent: null, fee_amount: null }).eq('id', id).select().maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Request not found.' });
  res.json(toRequest(data));
}));

// Customer rates a finished job (once). 1 to 5 stars and an optional comment.
app.post('/service-request/:id/rating', ...noVendor, handle(async (req, res) => {
  if (!isCustomer(req)) return res.status(403).json({ error: 'Only customers can rate a job.' });
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
  const review = String(req.body.review || '').trim().slice(0, 500);
  const mine = await supabase.from('vehicles').select('id').eq('user_id', req.user.id);
  if (mine.error) throw mine.error;
  const one = await supabase.from('service_requests').select('*').eq('id', Number(req.params.id)).maybeSingle();
  if (one.error) throw one.error;
  const cur = { data: one.data && (one.data.customer_id === req.user.id || mine.data.some(v => v.id === one.data.vehicle_id)) ? one.data : null };   // by owner (emergencies have no vehicle) or by vehicle
  if (!cur.data) return res.status(404).json({ error: 'Request not found.' });
  if (cur.data.status !== 'completed' || !cur.data.technician_id) return res.status(400).json({ error: 'You can rate a job once a technician has finished it.' });
  if (cur.data.rating) return res.status(409).json({ error: 'You already rated this job.' });
  const { data, error } = await supabase.from('service_requests')
    .update({ rating, review: review || null, rated_at: new Date().toISOString() }).eq('id', cur.data.id).select().single();
  if (error) throw error;
  res.json(toRequest(data));
}));

// --- AI Assistant ---
// Rule-based for now. To use a real AI model, replace diagnose() with a call to your
// model provider and keep the same response shape.

// General advice per vehicle category (from your original logic, expanded)
const VEHICLE_TIPS = {
  'car':         'For cars, common issues include the battery, brakes and engine sensors.',
  'light-truck': 'Light trucks often need suspension and transmission checks, especially if used for towing.',
  'small-truck': 'Small trucks may face tire wear and load balance problems, so check tire pressure against the load you carry.',
  'heavy-truck': 'Heavy trucks require hydraulic and diesel engine diagnostics, plus regular air-brake inspections.'
};

// Symptom rules: words to look for, the service to suggest, urgency, and the explanation
const RULES = [
  { words: ['brake', 'squeal', 'grind', 'pedal', 'stopping', 'air brake'], service: 'mechanical', urgency: 'high',
    answer: 'Squealing or grinding usually points to worn brake pads or scored rotors. A soft or sinking pedal can mean air or a leak in the brake lines. Avoid long trips until the brakes are inspected.',
    heavy: 'On air-brake systems, also check for air leaks, slow pressure build-up and slack adjuster wear.' },
  { words: ['overheat', 'temperature', 'coolant', 'steam', 'radiator', 'hot'], service: 'mechanical', urgency: 'high',
    answer: 'Overheating is often caused by low coolant, a leaking hose, a stuck thermostat or a failing water pump or radiator fan. Stop driving if the gauge goes into the red, and never open a hot radiator cap.' },
  { words: ['hydraulic', 'lift', 'dump', 'pto', 'tipper'], service: 'mechanical', urgency: 'medium',
    answer: 'Slow or jerky hydraulics usually mean low or contaminated fluid, a leaking hose or seal, or a worn pump. Check the fluid level and look for wet fittings before it gets worse.' },
  { words: ['battery', "won't start", 'wont start', 'click', 'lights dim', 'alternator', 'fuse', 'wiring'], service: 'electrical', urgency: 'medium',
    answer: 'A clicking sound or no crank usually means a weak battery or corroded terminals. If the battery keeps dying, the alternator may not be charging it. A battery and charging test will confirm which.' },
  { words: ['gear', 'shift', 'clutch', 'slipping', 'transmission'], service: 'mechanical', urgency: 'medium',
    answer: 'Hard shifts or slipping can come from low or old transmission fluid, a worn clutch on manual vehicles, or internal wear. Check the fluid level and colour first; burnt-smelling fluid needs attention soon.' },
  { words: ['bump', 'clunk', 'bounce', 'steering', 'pulling', 'pulls', 'alignment', 'shock', 'sag', 'leaf spring'], service: 'mechanical', urgency: 'medium',
    answer: 'Clunks over bumps often mean worn bushings, ball joints or sway-bar links. Pulling to one side is commonly wheel alignment or uneven tire pressure. Sagging at the rear under load can mean tired leaf springs or shocks.' },
  { words: ['dent', 'scratch', 'bumper', 'paint', 'collision', 'crash', 'accident', 'body work', 'bodywork', 'panel', 'fender', 'hood', 'bonnet', 'windshield', 'rust'], service: 'bodywork', urgency: 'low',
    answer: 'Dents, scratches, cracked bumpers and paint damage are auto body repairs. Take photos of the damage from a few angles. If the vehicle was in an accident, have a technician also check the alignment, suspension and lights, since body damage can hide other problems.' },
  { words: ['tyre', 'tire', 'puncture', 'flat', 'tread', 'pressure', 'load'], service: 'tire', urgency: 'medium',
    answer: 'Check pressures when the tires are cold and look for nails, bulges or uneven wear. Uneven wear can also hint at alignment, suspension or load balance problems.' },
  { words: ['engine', 'misfire', 'check engine', 'warning light', 'smoke', 'knock', 'rough idle', 'stall', 'power', 'diesel', 'injector', 'turbo'], service: 'diagnostics', urgency: 'medium',
    answer: 'A rough idle, misfire, loss of power or warning light is often ignition, fuel delivery, a vacuum or boost leak, or a sensor fault. Reading the diagnostic codes is the fastest way to narrow it down.',
    heavy: 'On diesel engines, black smoke often points to injectors or air intake, and white smoke to coolant or timing issues.' },
  { words: ['oil change', 'service', 'maintenance', 'filter', 'tune', 'mileage', 'grease'], service: 'maintenance', urgency: 'low',
    answer: "Routine service usually covers oil and filter, air filter, fluid top-ups and a safety inspection. Follow the interval in your owner's manual." }
];

function diagnose(question, vehicleCategory) {
  const q = question.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const rule of RULES) {
    const score = rule.words.filter(w => q.includes(w)).length;
    if (score > bestScore) { best = rule; bestScore = score; }
  }

  const tip = VEHICLE_TIPS[vehicleCategory] || null;

  if (!best) {
    return {
      answer: 'I couldn\'t match that to a common problem. Describe what you hear, feel or see, when it happens (cold start, braking, turning, under load) and any warning lights.',
      tip,
      category: 'diagnostics',
      urgency: 'unknown'
    };
  }

  let answer = best.answer;
  if (vehicleCategory === 'heavy-truck' && best.heavy) answer += ' ' + best.heavy;
  return { answer, tip, category: best.service, urgency: best.urgency };
}

app.post('/ai-assist', ...noVendor, handle(async (req, res) => {
  const { question, vehicleId } = req.body;
  let { vehicleCategory } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Type a question first.' });
  }
  // Accept either a vehicleId (looked up) or a vehicleCategory directly
  if (vehicleId) {
    let vq = supabase.from('vehicles').select('category').eq('id', Number(vehicleId));
    if (isCustomer(req)) vq = vq.eq('user_id', req.user.id);
    const { data: v, error } = await vq.maybeSingle();
    if (error) throw error;
    if (v) vehicleCategory = v.category;
  }
  res.json({ question, vehicleCategory: vehicleCategory || null, ...diagnose(question, vehicleCategory) });
}));

// --- Phone notifications and alert emails (pushRoutes.js) ---
const push = require('./pushRoutes')({ supabase, handle, auth, app });
app.use(push.router);

// --- Reminders for fitness, registration, insurance and oil changes (reminders.js) ---
const reminders = require('./reminders')({ supabase, push });
if (process.env.PUSH_FAKE === '1') app.post('/_reminders_run', handle(async (req, res) => res.json({ sent: await reminders.run() })));   // tests only

// --- Live jobs: online technicians, department alerts, chat, price and arrival time (jobRoutes.js) ---
const jobs = require('./jobRoutes')({ supabase, handle, auth, subs, push });
app.use(jobs.router);

// --- Emergency requests: roadside assistance and wrecker (emergencyRoutes.js) ---
app.use(require('./emergencyRoutes')({ supabase, handle, auth }));

// --- Parts marketplace: order parts from approved vendors in a chat (partsRoutes.js). Off until PARTS_ENABLED=true. ---
const parts = require('./partsRoutes')({ supabase, handle, auth });
app.use(parts.router);

// --- Vehicle rentals: rental companies list vehicles, customers book them (rentalRoutes.js). Off until RENTALS_ENABLED=true. ---
const rentals = require('./rentalRoutes')({ supabase, handle, auth, push, subs });
if (process.env.PUSH_FAKE === '1') {   // tests only: move a booking's dates back, and run the overdue / auto-agree check now
  app.post('/_rentals_backdate/:id', handle(async (req, res) => { const { error } = await supabase.from('rental_bookings').update({ start_date: req.body.start, end_date: req.body.end, ...(req.body.returnedAt ? { returned_at: req.body.returnedAt } : {}) }).eq('id', Number(req.params.id)); if (error) throw error; res.json({ ok: true }); }));
  app.post('/_rentals_sweep', handle(async (req, res) => res.json(await rentals.sweep())));
}
app.use(rentals.router);

// Typical prices the shop has set, shown while booking (nothing is shown for a department until the admin sets a range)
async function readPriceGuide() {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'price_guide').maybeSingle();
  return (data && data.value) || {};
}
app.get('/price-guide', handle(async (req, res) => res.json(await readPriceGuide())));
app.put('/admin/price-guide', auth.requireRole('admin'), handle(async (req, res) => {
  const input = (req.body && req.body.guide) || {}, guide = {};
  for (const [cat, range] of Object.entries(input)) {
    if (!isServiceCategory(cat)) return res.status(400).json({ error: 'Unknown department: ' + cat + '.' });
    if (!range || range.min === '' || range.min == null) continue;
    const min = Number(range.min), max = Number(range.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 10000000) return res.status(400).json({ error: 'Check the price range for ' + cat + '. The top price cannot be lower than the bottom price.' });
    guide[cat] = { min: Math.round(min), max: Math.round(max) };
  }
  const had = await supabase.from('app_settings').select('key').eq('key', 'price_guide').maybeSingle();
  const w = had.data ? await supabase.from('app_settings').update({ value: guide, updated_at: new Date().toISOString() }).eq('key', 'price_guide') : await supabase.from('app_settings').insert({ key: 'price_guide', value: guide });
  if (w.error) throw w.error;
  res.json(guide);
}));

// Public settings the pages need (the shop's phone number for the call buttons)
const subCfg = require('./subscriptionConfig');
app.get('/config', (req, res) => res.json({
  businessName: process.env.BUSINESS_NAME || 'AutoAid 24/7', shopPhone: process.env.SHOP_PHONE || '',
  legalName: process.env.LEGAL_NAME || '', contactEmail: process.env.CONTACT_EMAIL || '',   // shown on the privacy notice and terms
  subscription: { enabled: subs.config.enabled, priceLabel: subCfg.priceLabel(), days: subs.config.days },
  jobs: { feePercent: jobs.feePercent, onlinePayment: jobs.onlinePayment() },
  parts: { enabled: auth.PARTS.enabled, commissionPercent: parts.commissionPercent },
  rentals: { enabled: auth.RENTALS.enabled, commissionPercent: rentals.commissionPercent, onlinePayment: rentals.onlinePayment() },
  premium: { enabled: subCfg.premium.enabled, oilPerYear: subCfg.premium.oilPerYear, oilGapDays: subCfg.premium.oilGapDays,
    plans: subCfg.premiumPlans().map(p => ({ id: p.id, label: p.label, priceLabel: p.priceLabel, days: p.days })) }
}));

// --- Staff/admin portal API (adminRoutes.js) ---
app.use('/admin', require('./adminRoutes')({ supabase, handle, auth, subs, toVehicle, toRequest, STATUSES }));

// Streaming chat with the mechanic assistant (ai.js). The older /ai-assist above is kept for simple one-shot use.
app.post('/ai-chat', ...noVendor, handle(require('./ai')({ supabase, diagnose, isCustomer })));

// Health check for uptime monitors (UptimeRobot and similar): answers 200 only when the database responds
app.get('/health', async (req, res) => {
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(503).json({ ok: false }); }
});

// A friendly page for mistyped links (API paths keep their plain JSON answer)
app.use((req, res, next) => {
  if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  res.status(404).json({ error: 'Not found.' });
});

const PORT = process.env.PORT || 3000;
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'AutoAid 24/7';
// Last resort for errors that happen before a route runs (oversized or malformed request bodies)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large to upload. Try a smaller photo.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

auth.seed()
  .catch(err => console.error('Could not set up accounts. Have you run schema-users.sql in Supabase?', err.message || err))
  .finally(() => app.listen(PORT, () => {
    console.log(`${BUSINESS_NAME} running at http://localhost:${PORT} (${process.env.NODE_ENV || 'development'})`);
  }));
