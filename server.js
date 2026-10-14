// server.js — Laidlaw Auto Services
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const vehicleCatalog = require('./vehicleCatalog');

const app = express();

// CORS: allows other websites or apps to call this API.
// Set CORS_ORIGIN in .env to limit access (comma-separated); leave it empty to allow all.
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
const toVehicle = r => ({ id: r.id, owner: r.owner, type: r.type, category: r.category, year: r.year, vin: r.vin, createdAt: r.created_at });
const toRequest = r => ({ id: r.id, vehicleId: r.vehicle_id, category: r.category, description: r.description, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });

// Wraps async routes so database errors return a clean 500 instead of crashing
const handle = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

// Vehicle categories
const VEHICLE_CATEGORIES = [
  { value: 'car',         label: 'Car' },
  { value: 'light-truck', label: 'Light truck' },
  { value: 'small-truck', label: 'Small truck' },
  { value: 'heavy-truck', label: 'Heavy truck' }
];

// Service categories (edit this list to match what the shop offers)
const SERVICE_CATEGORIES = [
  { value: 'diagnostics', label: 'Diagnostics' },
  { value: 'mechanical',  label: 'Mechanical' },
  { value: 'tire',        label: 'Tire' },
  { value: 'electrical',  label: 'Electrical' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'other',       label: 'Other' }
];

const STATUSES = ['pending', 'in-progress', 'completed', 'cancelled'];
const isVehicleCategory = v => VEHICLE_CATEGORIES.some(c => c.value === v);
const isServiceCategory = v => SERVICE_CATEGORIES.some(c => c.value === v);

app.get('/categories', (req, res) => res.json({ vehicle: VEHICLE_CATEGORIES, service: SERVICE_CATEGORIES }));

// Common makes and models, grouped by vehicle category value ("car", "light-truck", ...).
// Edit vehicleCatalog.js to change the list. Only listed models can be registered.
const CATALOG_KEYS = { cars: 'car', lightTrucks: 'light-truck', smallTrucks: 'small-truck', heavyTrucks: 'heavy-truck' };
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
app.get('/vehicles', handle(async (req, res) => {
  const { data, error } = await supabase.from('vehicles').select('*').order('id');
  if (error) throw error;
  res.json(data.map(toVehicle));
}));

app.post('/vehicle', handle(async (req, res) => {
  const { owner, year, vin } = req.body;
  if (!owner || !req.body.type || !year) {
    return res.status(400).json({ error: 'Owner, make and model, and year are required.' });
  }
  // Find the vehicle in the Jamaica catalog. Case, spaces and dashes don't matter,
  // and the vehicle type (car, light truck...) comes from the catalog, not the request.
  const found = findExact(CATALOG, req.body.type);
  if (!found) {
    const suggestions = searchCatalog(CATALOG, req.body.type, 3).map(r => r.name);
    return res.status(400).json({
      error: 'Vehicle type not recognized in Jamaica catalog.' +
        (suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : ' Check the spelling and try again.'),
      suggestions
    });
  }
  const { name: type, category } = found;
  const y = Number(year);
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(y) || y < 1900 || y > maxYear) {
    return res.status(400).json({ error: `Year must be between 1900 and ${maxYear}.` });
  }
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
    return res.status(400).json({ error: 'A VIN has 17 letters and numbers (no I, O or Q).' });
  }
  const { data, error } = await supabase.from('vehicles').insert({
    owner: owner.trim(),
    type,                // must match vehicleCatalog.js exactly
    category,            // e.g. "small-truck"
    year: y,
    vin: (vin || '').toUpperCase()
  }).select().single();
  if (error) throw error;
  res.status(201).json(toVehicle(data));
}));

app.delete('/vehicle/:id', handle(async (req, res) => {
  const id = Number(req.params.id);
  // Its service requests are removed automatically (ON DELETE CASCADE)
  const { data, error } = await supabase.from('vehicles').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data.length) return res.status(404).json({ error: 'Vehicle not found.' });
  res.json({ deleted: id });
}));

// --- Service Requests ---
app.get('/service-requests', handle(async (req, res) => {
  let query = supabase.from('service_requests').select('*').order('id');
  if (req.query.vehicleId) query = query.eq('vehicle_id', Number(req.query.vehicleId));
  const { data, error } = await query;
  if (error) throw error;
  res.json(data.map(toRequest));
}));

app.post('/service-request', handle(async (req, res) => {
  const { vehicleId, category, description } = req.body;
  const vid = Number(vehicleId);
  const { data: found, error: findError } = await supabase.from('vehicles').select('id').eq('id', vid).maybeSingle();
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
    description: description.trim()
    // status defaults to 'pending' in the database
  }).select().single();
  if (error) throw error;
  res.status(201).json(toRequest(data));
}));

app.patch('/service-request/:id', handle(async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
  }
  // updated_at is set by a database trigger
  const { data, error } = await supabase.from('service_requests')
    .update({ status }).eq('id', Number(req.params.id)).select().maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Request not found.' });
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

app.post('/ai-assist', handle(async (req, res) => {
  const { question, vehicleId } = req.body;
  let { vehicleCategory } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Type a question first.' });
  }
  // Accept either a vehicleId (looked up) or a vehicleCategory directly
  if (vehicleId) {
    const { data: v, error } = await supabase.from('vehicles').select('category').eq('id', Number(vehicleId)).maybeSingle();
    if (error) throw error;
    if (v) vehicleCategory = v.category;
  }
  res.json({ question, vehicleCategory: vehicleCategory || null, ...diagnose(question, vehicleCategory) });
}));

// --- Admin portal ---
// Set ADMIN_PASSWORD in .env (and optionally ADMIN_SECRET to sign sessions). Without a password the portal is disabled.
// Login returns a signed token that expires after 8 hours; send it as "Authorization: Bearer <token>".
const crypto = require('crypto');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex'); // random = sessions end on restart
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const sign = payload => crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('base64url');
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function makeToken() {
  const payload = String(Date.now() + TOKEN_TTL_MS);
  return `${payload}.${sign(payload)}`;
}
function validToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  return Number(payload) > Date.now();
}
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin portal is disabled. Set ADMIN_PASSWORD in .env.' });
  const token = (req.get('authorization') || '').replace(/^Bearer /i, '');
  if (!validToken(token)) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

// Slow down password guessing: 5 failed attempts per IP, then locked for 15 minutes
const failedLogins = new Map();
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

app.post('/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin portal is disabled. Set ADMIN_PASSWORD in .env.' });
  const rec = failedLogins.get(req.ip);
  if (rec && rec.count >= MAX_FAILS && Date.now() - rec.last < LOCK_MS) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  if (!safeEqual(req.body.password || '', ADMIN_PASSWORD)) {
    failedLogins.set(req.ip, { count: (rec && Date.now() - rec.last < LOCK_MS ? rec.count : 0) + 1, last: Date.now() });
    return res.status(401).json({ error: 'Wrong password.' });
  }
  failedLogins.delete(req.ip);
  res.json({ token: makeToken() });
});

// Everything the dashboard needs in one call: all requests joined with their vehicles, plus counts
app.get('/admin/overview', requireAdmin, handle(async (req, res) => {
  const [v, r] = await Promise.all([
    supabase.from('vehicles').select('*').order('id'),
    supabase.from('service_requests').select('*').order('id', { ascending: false })
  ]);
  if (v.error) throw v.error;
  if (r.error) throw r.error;
  const vehicles = v.data.map(toVehicle);
  const byId = new Map(vehicles.map(x => [x.id, x]));
  const requests = r.data.map(toRequest).map(x => ({ ...x, vehicle: byId.get(x.vehicleId) || null }));
  const counts = Object.fromEntries(STATUSES.map(s => [s, requests.filter(x => x.status === s).length]));
  const owners = new Set(vehicles.map(x => x.owner.trim().toLowerCase())).size;
  res.json({ counts, totals: { vehicles: vehicles.length, requests: requests.length, owners }, vehicles, requests });
}));

app.patch('/admin/service-request/:id', requireAdmin, handle(async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
  const { data, error } = await supabase.from('service_requests')
    .update({ status }).eq('id', Number(req.params.id)).select().maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Request not found.' });
  res.json(toRequest(data));
}));

app.delete('/admin/service-request/:id', requireAdmin, handle(async (req, res) => {
  const id = Number(req.params.id);
  const { data, error } = await supabase.from('service_requests').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data.length) return res.status(404).json({ error: 'Request not found.' });
  res.json({ deleted: id });
}));

app.delete('/admin/vehicle/:id', requireAdmin, handle(async (req, res) => {
  const id = Number(req.params.id);
  const { data, error } = await supabase.from('vehicles').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data.length) return res.status(404).json({ error: 'Vehicle not found.' });
  res.json({ deleted: id });
}));

const PORT = process.env.PORT || 3000;
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Laidlaw Auto Services';
app.listen(PORT, () => {
  console.log(`${BUSINESS_NAME} running at http://localhost:${PORT} (${process.env.NODE_ENV || 'development'})`);
});
