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
const isOn = v => String(v || '').toLowerCase() === 'true';

module.exports = function ({ supabase, handle, auth, subs }) {
  const router = express.Router();
  const adminOnly = auth.requireRole('admin');
  const fromRender = {};   // what Render says, kept so the admin can see it
  for (const k of KEYS) fromRender[k] = isOn(process.env[k]);
  let saved = {};

  const apply = () => { for (const k of KEYS) if (typeof saved[k] === 'boolean') process.env[k] = saved[k] ? 'true' : 'false'; };
  async function load() {
    try {
      const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'feature_flags').maybeSingle();
      if (error) throw error;
      saved = data && data.value && typeof data.value === 'object' ? data.value : {};
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

  return { router };
};
