// adminRoutes.js — everything under /admin. Only login is public; the rest needs a valid token.
const express = require('express');
const { login, logout, requireAdmin } = require('./auth');

module.exports = function adminRoutes({ supabase, handle, toVehicle, toRequest, STATUSES }) {
  const router = express.Router();

  // --- Auth ---
  router.post('/login', login);
  router.post('/logout', logout);
  router.get('/me', requireAdmin, (req, res) => res.json({ admin: true })); // lets the page check a saved token

  // --- Dashboard ---
  // Everything the dashboard needs in one call: all requests joined with their vehicles, plus counts
  router.get('/overview', requireAdmin, handle(async (req, res) => {
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

  // --- Service requests ---
  router.patch('/service-request/:id', requireAdmin, handle(async (req, res) => {
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
    const { data, error } = await supabase.from('service_requests')
      .update({ status }).eq('id', Number(req.params.id)).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Request not found.' });
    res.json(toRequest(data));
  }));

  router.delete('/service-request/:id', requireAdmin, handle(async (req, res) => {
    const id = Number(req.params.id);
    const { data, error } = await supabase.from('service_requests').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Request not found.' });
    res.json({ deleted: id });
  }));

  // --- Vehicles ---
  router.delete('/vehicle/:id', requireAdmin, handle(async (req, res) => {
    const id = Number(req.params.id);
    // Its service requests are removed automatically (ON DELETE CASCADE)
    const { data, error } = await supabase.from('vehicles').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Vehicle not found.' });
    res.json({ deleted: id });
  }));

  return router;
};
