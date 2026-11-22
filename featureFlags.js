// Feature switches the admin can turn on and off from the Control center, without going into Render.
// A switch saved here wins; a switch never touched falls back to the Render setting of the same name. The saved choices are copied into
// process.env, so every place that already reads those settings picks the change up straight away (the rest refresh within 30 seconds).
const express = require('express');

const FLAGS = [
  { key: 'PREMIUM_ENABLED', group: 'Services', label: 'Premium memberships', help: 'Customers can buy a yearly Premium plan for a vehicle. Plans and prices are set in Render.' },
  { key: 'PARTS_ENABLED', group: 'Services', label: 'Parts and accessories', help: 'Customers can ask approved sellers for parts and accessories. Sellers can sign up.' },
  { key: 'RENTALS_ENABLED', group: 'Services', label: 'Vehicle rentals', help: 'Rental companies can list vehicles and customers can book them. Open in every parish.' },
  { key: 'SUBSCRIPTIONS_ENABLED', group: 'Services', label: 'Monthly fee for technicians', help: 'Technicians must pay a monthly subscription to receive jobs. Leave off while providers pay nothing.' },
  { key: 'JOBS_ONLINE_PAYMENT', group: 'Online payment', label: 'Pay for jobs in the app', help: 'Customers pay the quote through Fygaro with the 3% service fee. Off means they pay the technician in person.', needsGateway: true },
  { key: 'PARTS_ONLINE_PAYMENT', group: 'Online payment', label: 'Pay for parts in the app', help: 'Customers pay parts and accessories through Fygaro with the service fee. Off means pay the seller in person.', needsGateway: true },
  { key: 'RENTALS_ONLINE_PAYMENT', group: 'Online payment', label: 'Pay for rentals in the app', help: 'Renters pay rent, deposit and the service fee through Fygaro. Off means pay the company in person.', needsGateway: true }
];
const KEYS = FLAGS.map(f => f.key);

// Prices and rates the admin can change (a number saved here wins over the Render setting of the same name)
const jmd = (key, label, help) => ({ key, group: 'Premium prices (J$ a year)', label, help, unit: 'J$', min: 0, max: 1000000, def: 0 });
const pay = (key, label) => ({ key, group: 'Technician pay for one Premium service (J$)', label, unit: 'J$', min: 0, max: 1000000, def: 0 });
const NUMBERS = [
  { key: 'SERVICE_FEE_PERCENT', group: 'Service fee', label: 'Service fee the customer pays on top', help: 'Added to every payment made through the app. Providers pay nothing.', unit: '%', min: 0, max: 20, step: 0.5, def: 3 },
  jmd('PREMIUM_PRICE_CAR', 'Car'), jmd('PREMIUM_PRICE_SUV', 'SUV or van'), jmd('PREMIUM_PRICE_SMALL_TRUCK', 'Pickup or small truck'), jmd('PREMIUM_PRICE_LARGE_TRUCK', 'Large truck or bus'),
  pay('PREMIUM_PAY_CAR', 'Car'), pay('PREMIUM_PAY_SUV', 'SUV or van'), pay('PREMIUM_PAY_SMALL_TRUCK', 'Pickup or small truck'), pay('PREMIUM_PAY_LARGE_TRUCK', 'Large truck or bus'),
  { key: 'PREMIUM_SERVICES_PER_YEAR', group: 'Premium rules', label: 'Free services in a membership year', unit: '', min: 1, max: 12, def: 2 },
  { key: 'PREMIUM_SERVICE_GAP_DAYS', group: 'Premium rules', label: 'Days between two services on one vehicle', unit: 'days', min: 0, max: 365, def: 60 },
  { key: 'SUBSCRIPTION_PRICE', group: 'Technician subscription (only if switched on)', label: 'Price per period (J$)', unit: 'J$', min: 0, max: 1000000, def: 0 },
  { key: 'SUBSCRIPTION_DAYS', group: 'Technician subscription (only if switched on)', label: 'Days each payment covers', unit: 'days', min: 1, max: 365, def: 30 },
  { key: 'SUBSCRIPTION_GRACE_DAYS', group: 'Technician subscription (only if switched on)', label: 'Grace days after it runs out', unit: 'days', min: 0, max: 60, def: 5 }
];
const NUM_KEYS = NUMBERS.map(n => n.key);
const isOn = v => String(v || '').toLowerCase() === 'true';

module.exports = function ({ supabase, handle, auth, subs }) {
  const router = express.Router();
  const adminOnly = auth.requireRole('admin');
  const fromRender = {};   // what Render says, kept so the admin can see it
  for (const k of KEYS) fromRender[k] = isOn(process.env[k]);
  let saved = {}, savedNums = {};
  const renderEnv = {};   // what Render says for each number, so "use the Render value" can put it back
  for (const k of NUM_KEYS) renderEnv[k] = process.env[k];

  const apply = () => {
    for (const k of KEYS) if (typeof saved[k] === 'boolean') process.env[k] = saved[k] ? 'true' : 'false';
    for (const k of NUM_KEYS) { if (typeof savedNums[k] === 'number') process.env[k] = String(savedNums[k]); else if (renderEnv[k] === undefined) delete process.env[k]; else process.env[k] = renderEnv[k]; }
  };
  async function load() {
    try {
      const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'feature_flags').maybeSingle();
      if (error) throw error;
      saved = data && data.value && typeof data.value === 'object' ? data.value : {};
      const nums = await supabase.from('app_settings').select('value').eq('key', 'number_settings').maybeSingle();
      if (nums.error) throw nums.error;
      savedNums = nums.data && nums.data.value && typeof nums.data.value === 'object' ? nums.data.value : {};
      apply();
    } catch (_) { /* keep the last good choices */ }
  }
  load();
  setInterval(load, 30000).unref();

  const view = () => FLAGS.map(f => ({ ...f, on: isOn(process.env[f.key]), choice: typeof saved[f.key] === 'boolean' ? 'admin' : 'render' }));

  router.get('/admin/features', adminOnly, handle(async (req, res) => res.json({ flags: view(), gatewayReady: !!(subs && subs.gatewayReady && subs.gatewayReady()) })));
  router.put('/admin/features', adminOnly, handle(async (req, res) => {
    const key = req.body && req.body.key;
    if (!KEYS.includes(key) || typeof (req.body && req.body.on) !== 'boolean') return res.status(400).json({ error: 'Choose a switch and on or off.' });
    saved = { ...saved, [key]: req.body.on };
    const had = await supabase.from('app_settings').select('key').eq('key', 'feature_flags').maybeSingle();
    const w = had.data
      ? await supabase.from('app_settings').update({ value: saved, updated_at: new Date().toISOString() }).eq('key', 'feature_flags')
      : await supabase.from('app_settings').insert({ key: 'feature_flags', value: saved });
    if (w.error) throw w.error;
    apply();
    res.json({ flags: view(), gatewayReady: !!(subs && subs.gatewayReady && subs.gatewayReady()) });
  }));

  const numView = () => NUMBERS.map(n => {
    const raw = Number(process.env[n.key]);
    const value = process.env[n.key] !== undefined && process.env[n.key] !== '' && Number.isFinite(raw) ? raw : n.def;
    return { ...n, value, choice: typeof savedNums[n.key] === 'number' ? 'admin' : 'render' };
  });
  router.get('/admin/settings', adminOnly, handle(async (req, res) => res.json({ settings: numView() })));
  // body: { values: { KEY: number, KEY2: null } }   a number saves it; null goes back to the Render value
  router.put('/admin/settings', adminOnly, handle(async (req, res) => {
    const values = req.body && req.body.values;
    if (!values || typeof values !== 'object') return res.status(400).json({ error: 'Nothing to save.' });
    const next = { ...savedNums };
    for (const [k, v] of Object.entries(values)) {
      const def = NUMBERS.find(n => n.key === k);
      if (!def) return res.status(400).json({ error: 'Unknown setting.' });
      if (v === null) { delete next[k]; continue; }
      const num = Number(v);
      if (v === '' || !Number.isFinite(num) || num < def.min || num > def.max) return res.status(400).json({ error: def.label + ' must be a number from ' + def.min + ' to ' + def.max + '.' });
      next[k] = Math.round(num * 100) / 100;
    }
    savedNums = next;
    const had = await supabase.from('app_settings').select('key').eq('key', 'number_settings').maybeSingle();
    const w = had.data
      ? await supabase.from('app_settings').update({ value: savedNums, updated_at: new Date().toISOString() }).eq('key', 'number_settings')
      : await supabase.from('app_settings').insert({ key: 'number_settings', value: savedNums });
    if (w.error) throw w.error;
    apply();
    res.json({ settings: numView() });
  }));

  return { router };
};
