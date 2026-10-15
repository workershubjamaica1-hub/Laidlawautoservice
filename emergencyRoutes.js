// emergencyRoutes.js — roadside assistance and wrecker (towing) requests.
//
// Customers:  POST /emergency, GET /emergency/mine, POST /emergency/:id/cancel
// Technicians and admins:  GET /admin/emergencies, PATCH /admin/emergencies/:id  (accept, release, resolve, cancel)
//
// A request goes to every approved technician; the portal shows their own parish first.
// The first technician to accept it gets it ("accept" only works while the request is still open).
const express = require('express');

const KINDS = ['roadside', 'towing'];
const MAX_ACTIVE = 3;       // open or on-the-way requests one customer can have at once
const MAX_PER_HOUR = 5;
const HOUR = 3600 * 1000;

module.exports = function emergencyRoutes({ supabase, handle, auth }) {
  const router = express.Router();
  const customerOnly = auth.requireRole('customer');
  const staffUp = auth.requireWorker;   // staff and admin; a provider with a lapsed subscription is stopped (402)

  const toEmergency = (r, extra = {}) => ({
    id: r.id, kind: r.kind, vehicleId: r.vehicle_id, note: r.note || '',
    latitude: r.latitude, longitude: r.longitude, locationText: r.location_text || '',
    parish: r.parish, phone: r.phone, status: r.status, technicianId: r.technician_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
    amount: r.amount == null ? null : Number(r.amount), rating: r.rating || null, review: r.review || '', completedAt: r.completed_at || null,
    hasWorkPhoto: !!r.work_photo_path,
    ...extra
  });
  const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

  // --- Customer: ask for help ---
  router.post('/emergency', customerOnly, handle(async (req, res) => {
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'Choose roadside assistance or a wrecker.' });

    const lat = num(b.latitude), lng = num(b.longitude);
    const hasCoords = lat !== null && lng !== null;
    if (hasCoords && !(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
      return res.status(400).json({ error: 'That location does not look right. Try sharing it again.' });
    }
    const locationText = String(b.locationText || '').trim().slice(0, 200);
    if (!hasCoords && locationText.length < 3) {
      return res.status(400).json({ error: 'Share your location, or describe where you are (road, landmark, community).' });
    }

    // Only the phone is checked here (an empty string counts as missing), not the sign-up address/parish rules
    const phoneCheck = auth.checkContact({ phone: String(b.phone || req.user.phone || '') }, false);
    if (phoneCheck.error) return res.status(400).json({ error: phoneCheck.error });
    const parish = auth.PARISHES.includes(b.parish) ? b.parish : req.user.parish;
    if (!parish) return res.status(400).json({ error: 'Choose the parish you are in.' });
    const note = String(b.note || '').trim().slice(0, 500);

    let vehicleId = null;
    if (b.vehicleId) {
      const v = await supabase.from('vehicles').select('id').eq('id', Number(b.vehicleId)).eq('user_id', req.user.id).maybeSingle();
      if (v.error) throw v.error;
      if (!v.data) return res.status(400).json({ error: 'Choose one of your vehicles, or leave it blank.' });
      vehicleId = v.data.id;
    }

    // Stop accidental repeats and abuse
    const mine = await supabase.from('emergency_requests').select('id, status, created_at').eq('user_id', req.user.id);
    if (mine.error) throw mine.error;
    if (mine.data.filter(r => r.status === 'open' || r.status === 'dispatched').length >= MAX_ACTIVE) {
      return res.status(429).json({ error: 'You already have emergency requests in progress. Cancel one or call the shop.' });
    }
    if (mine.data.filter(r => Date.now() - new Date(r.created_at).getTime() < HOUR).length >= MAX_PER_HOUR) {
      return res.status(429).json({ error: 'Too many requests this hour. Please call the shop directly.' });
    }

    const { data, error } = await supabase.from('emergency_requests').insert({
      user_id: req.user.id, kind: b.kind, vehicle_id: vehicleId, note: note || null,
      latitude: hasCoords ? lat : null, longitude: hasCoords ? lng : null, location_text: locationText || null,
      parish, phone: phoneCheck.value.phone, status: 'open'
    }).select().single();
    if (error) throw error;
    res.status(201).json(toEmergency(data));
  }));

  // --- Customer: my recent requests, with the technician's details once someone accepts ---
  router.get('/emergency/mine', customerOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('emergency_requests').select('*').eq('user_id', req.user.id).order('id', { ascending: false });
    if (error) throw error;
    const recent = data.slice(0, 10);
    const techIds = [...new Set(recent.map(r => r.technician_id).filter(Boolean))];
    let techs = new Map();
    if (techIds.length) {
      const t = await supabase.from('users').select('id, name, phone, avatar_path').in('id', techIds);
      if (t.error) throw t.error;
      techs = new Map(await Promise.all(t.data.map(async x => [x.id, { ...x, avatarUrl: await auth.signedPhotoUrl(x.avatar_path).catch(() => null) }])));
    }
    res.json(await Promise.all(recent.map(async r => {
      const t = techs.get(r.technician_id);
      return toEmergency(r, {
        technician: t ? { name: t.name, phone: t.phone || '', avatarUrl: t.avatarUrl } : null,
        workPhotoUrl: r.work_photo_path ? await auth.signedPhotoUrl(r.work_photo_path).catch(() => null) : null
      });
    })));
  }));

  router.post('/emergency/:id/cancel', customerOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('emergency_requests')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', Number(req.params.id)).eq('user_id', req.user.id).in('status', ['open', 'dispatched']).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'This request is already finished or was not found.' });
    res.json(toEmergency(data));
  }));

  router.post('/emergency/:id/rating', customerOnly, handle(async (req, res) => {
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
    const review = String(req.body.review || '').trim().slice(0, 500);
    const cur = await supabase.from('emergency_requests').select('*').eq('id', Number(req.params.id)).eq('user_id', req.user.id).maybeSingle();
    if (cur.error) throw cur.error;
    if (!cur.data) return res.status(404).json({ error: 'Request not found.' });
    if (cur.data.status !== 'resolved' || !cur.data.technician_id) return res.status(400).json({ error: 'You can rate it once the technician has finished.' });
    if (cur.data.rating) return res.status(409).json({ error: 'You already rated this.' });
    const { data, error } = await supabase.from('emergency_requests')
      .update({ rating, review: review || null, rated_at: new Date().toISOString() }).eq('id', cur.data.id).select().single();
    if (error) throw error;
    res.json(toEmergency(data));
  }));

  // --- Technicians and admins ---
  // Active requests, plus anything finished in the last two days
  router.get('/admin/emergencies', staffUp, handle(async (req, res) => {
    const { data, error } = await supabase.from('emergency_requests').select('*').order('id', { ascending: false });
    if (error) throw error;
    const cutoff = Date.now() - 48 * HOUR;
    const rows = data.filter(r => r.status === 'open' || r.status === 'dispatched' || new Date(r.updated_at || r.created_at).getTime() > cutoff);
    const ids = [...new Set(rows.flatMap(r => [r.user_id, r.technician_id]).filter(Boolean))];
    const vIds = [...new Set(rows.map(r => r.vehicle_id).filter(Boolean))];
    const [u, v] = await Promise.all([
      ids.length ? supabase.from('users').select('id, name, phone, address, parish').in('id', ids) : { data: [] },
      vIds.length ? supabase.from('vehicles').select('id, year, type').in('id', vIds) : { data: [] }
    ]);
    if (u.error) throw u.error;
    if (v.error) throw v.error;
    const users = new Map(u.data.map(x => [x.id, x]));
    const vehicles = new Map(v.data.map(x => [x.id, x]));
    res.json(rows.map(r => {
      const c = users.get(r.user_id), t = users.get(r.technician_id), veh = vehicles.get(r.vehicle_id);
      return toEmergency(r, {
        customer: c ? { id: c.id, name: c.name, phone: c.phone || '', address: c.address || '', parish: c.parish || '' } : null,
        technician: t ? { id: t.id, name: t.name, phone: t.phone || '' } : null,
        vehicle: veh ? `${veh.year} ${veh.type}` : null
      });
    }));
  }));

  // body: { action: 'accept' | 'release' | 'resolve' | 'cancel' }
  router.patch('/admin/emergencies/:id', staffUp, handle(async (req, res) => {
    const id = Number(req.params.id);
    const action = req.body && req.body.action;
    const now = new Date().toISOString();
    const isAdmin = req.user.role === 'admin';
    const current = await supabase.from('emergency_requests').select('*').eq('id', id).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return res.status(404).json({ error: 'Request not found.' });
    const r = current.data;
    const mine = r.technician_id === req.user.id;
    const amount = auth.parseAmount(req.body && req.body.amount);
    if (amount.error) return res.status(400).json({ error: amount.error });

    let update, guard;
    if (action === 'accept') {
      if (r.status !== 'open') return res.status(409).json({ error: r.status === 'dispatched' && mine ? 'You already accepted this one.' : 'Someone else already took this request.' });
      update = { status: 'dispatched', technician_id: req.user.id, updated_at: now }; guard = 'open';
    } else if (action === 'release') {
      if (r.status !== 'dispatched' || (!mine && !isAdmin)) return res.status(403).json({ error: 'You can only hand back a request you accepted.' });
      update = { status: 'open', technician_id: null, updated_at: now }; guard = 'dispatched';
    } else if (action === 'resolve') {
      if (r.status !== 'dispatched' || (!mine && !isAdmin)) return res.status(403).json({ error: 'You can only finish a request you accepted.' });
      update = { status: 'resolved', updated_at: now, completed_at: now }; guard = 'dispatched';
      if (amount.value !== null) update.amount = amount.value; // JMD charged to the customer
    } else if (action === 'cancel') {
      if (!isAdmin) return res.status(403).json({ error: 'Only admins can cancel a request.' });
      if (r.status === 'resolved' || r.status === 'cancelled') return res.status(409).json({ error: 'This request is already finished.' });
      update = { status: 'cancelled', updated_at: now }; guard = r.status;
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }
    // The status check in the update itself means two technicians tapping Accept together cannot both win
    const { data, error } = await supabase.from('emergency_requests').update(update).eq('id', id).eq('status', guard).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'This request just changed. Refresh and try again.' });
    res.json(toEmergency(data));
  }));

  return router;
};
