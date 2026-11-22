// The parishes AutoAid 24/7 serves. Mechanics, tow trucks, parts, accessories and Premium only work for customers in an active parish;
// rentals are open everywhere. The admin switches parishes on as the app grows (Admin page, "Where AutoAid 24/7 is open").
// Until the admin saves a choice, the list comes from ACTIVE_PARISHES (comma separated) or starts as Kingston and St. Catherine.
const express = require('express');

module.exports = function ({ supabase, handle, auth }) {
  const router = express.Router();
  const adminOnly = auth.requireRole('admin');
  const START = ['Kingston', 'St. Catherine'];
  const fromEnv = () => {
    const list = String(process.env.ACTIVE_PARISHES || '').split(',').map(s => s.trim()).filter(p => auth.PARISHES.includes(p));
    return list.length ? list : START;
  };
  let cache = null, cachedAt = 0;

  async function list() {
    if (cache && Date.now() - cachedAt < 15000) return cache;
    try {
      const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'active_parishes').maybeSingle();
      if (error) throw error;
      const saved = data && data.value && Array.isArray(data.value.list) ? data.value.list.filter(p => auth.PARISHES.includes(p)) : null;
      cache = saved || fromEnv(); cachedAt = Date.now();
    } catch (_) { if (!cache) return fromEnv(); }   // if the settings cannot be read, keep the last good list
    return cache;
  }
  async function save(parishes) {
    const value = { list: parishes };
    const had = await supabase.from('app_settings').select('key').eq('key', 'active_parishes').maybeSingle();
    const w = had.data
      ? await supabase.from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', 'active_parishes')
      : await supabase.from('app_settings').insert({ key: 'active_parishes', value });
    if (w.error) throw w.error;
    cache = parishes; cachedAt = Date.now();
  }
  const sentence = names => names.length <= 1 ? (names[0] || 'no parish yet') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];

  // null when the parish is served (or not known), otherwise the sentence to show the customer
  async function blocked(parish) {
    if (!parish) return null;
    const open = await list();
    if (open.includes(parish)) return null;
    return 'AutoAid 24/7 is not in ' + parish + ' yet. We are open in ' + sentence(open) + ' and will add more parishes soon.';
  }

  // Anyone can see where we are open (the customer app shows a notice when their parish is not on the list)
  router.get('/service-area', handle(async (req, res) => res.json({ active: await list(), message: (await list()).length ? 'We are open in ' + sentence(await list()) + '.' : '' })));

  router.get('/admin/service-area', adminOnly, handle(async (req, res) => res.json({ active: await list(), all: auth.PARISHES })));
  router.put('/admin/service-area', adminOnly, handle(async (req, res) => {
    const asked = Array.isArray(req.body && req.body.active) ? req.body.active : null;
    if (!asked) return res.status(400).json({ error: 'Choose the parishes.' });
    const parishes = auth.PARISHES.filter(p => asked.includes(p));   // keeps the usual order and drops anything unknown
    if (!parishes.length) return res.status(400).json({ error: 'Keep at least one parish switched on.' });
    await save(parishes);
    res.json({ active: parishes, all: auth.PARISHES });
  }));

  return { router, list, blocked };
};
