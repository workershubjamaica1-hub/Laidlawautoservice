// adminRoutes.js — the staff/admin portal API, mounted at /admin.
// Staff and admins can view everything and change request status. Only admins can delete records or manage users.
const express = require('express');

module.exports = function adminRoutes({ supabase, handle, auth, toVehicle, toRequest, STATUSES }) {
  const router = express.Router();
  const staffUp = auth.requireRole('staff', 'admin');
  const adminOnly = auth.requireRole('admin');

  // --- Dashboard ---
  // Everything the dashboard needs in one call: all requests joined with their vehicles, plus counts
  router.get('/overview', staffUp, handle(async (req, res) => {
    const [v, r, u] = await Promise.all([
      supabase.from('vehicles').select('*').order('id'),
      supabase.from('service_requests').select('*').order('id', { ascending: false }),
      supabase.from('users').select('id, name, email')
    ]);
    for (const x of [v, r, u]) if (x.error) throw x.error;
    const accounts = new Map(u.data.map(x => [x.id, x]));
    const vehicles = v.data.map(row => {
      const acct = accounts.get(row.user_id);
      return { ...toVehicle(row), account: acct ? { name: acct.name, email: acct.email } : null };
    });
    const byId = new Map(vehicles.map(x => [x.id, x]));
    const requests = r.data.map(toRequest).map(x => ({ ...x, vehicle: byId.get(x.vehicleId) || null }));
    const counts = Object.fromEntries(STATUSES.map(s => [s, requests.filter(x => x.status === s).length]));
    const owners = new Set(vehicles.map(x => x.owner.trim().toLowerCase())).size;
    res.json({ counts, totals: { vehicles: vehicles.length, requests: requests.length, owners }, vehicles, requests });
  }));

  // --- Service requests ---
  router.patch('/service-request/:id', staffUp, handle(async (req, res) => {
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
    const { data, error } = await supabase.from('service_requests')
      .update({ status }).eq('id', Number(req.params.id)).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Request not found.' });
    res.json(toRequest(data));
  }));

  router.delete('/service-request/:id', adminOnly, handle(async (req, res) => {
    const id = Number(req.params.id);
    const { data, error } = await supabase.from('service_requests').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Request not found.' });
    res.json({ deleted: id });
  }));

  // --- Vehicles ---
  router.delete('/vehicle/:id', adminOnly, handle(async (req, res) => {
    const id = Number(req.params.id);
    // Its service requests are removed automatically (ON DELETE CASCADE)
    const { data, error } = await supabase.from('vehicles').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Vehicle not found.' });
    res.json({ deleted: id });
  }));

  // --- Users (admin only) ---
  router.get('/users', adminOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('users').select('*').order('id');
    if (error) throw error;
    res.json(data.map(auth.publicUser));
  }));

  router.post('/users', adminOnly, handle(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = req.body.role;
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter a name.' });
    if (!auth.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!auth.ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${auth.ROLES.join(', ')}.` });
    if (await auth.findByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });
    res.status(201).json(auth.publicUser(await auth.createUser({ name, email, password, role })));
  }));

  // Change role, active (disable/enable) or reset the password. Admins cannot demote or disable themselves.
  router.patch('/users/:id', adminOnly, handle(async (req, res) => {
    const id = Number(req.params.id);
    const update = {};
    if (req.body.role !== undefined) {
      if (!auth.ROLES.includes(req.body.role)) return res.status(400).json({ error: `Role must be one of: ${auth.ROLES.join(', ')}.` });
      update.role = req.body.role;
    }
    if (req.body.active !== undefined) update.active = !!req.body.active;
    if (req.body.password !== undefined) {
      if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      update.password_hash = auth.hashPassword(String(req.body.password));
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to change.' });
    if (id === req.user.id && ((update.role && update.role !== 'admin') || update.active === false)) {
      return res.status(400).json({ error: 'You cannot demote or disable your own account.' });
    }
    const { data, error } = await supabase.from('users').update(update).eq('id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found.' });
    res.json(auth.publicUser(data));
  }));

  router.delete('/users/:id', adminOnly, handle(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    // Their vehicles stay (user_id becomes null) so no service history is lost
    const { data, error } = await supabase.from('users').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'User not found.' });
    res.json({ deleted: id });
  }));

  return router;
};
