// jobRoutes.js — live jobs: a customer posts a job, online technicians in that department get a loud alert, the first to accept
// chats with the customer, sends a price and an arrival time, the customer agrees, the technician comes, and the customer confirms.
//
// Technicians:  POST /jobs/online, GET /jobs/feed, POST /jobs/:id/accept, /quote, /release, /arrived, /done, GET /jobs/ledger
// Customers:    POST /jobs/:id/quote/respond, /change-technician, /confirm, /cancel   (a job is created by POST /service-request)
// Both:         GET /jobs/:id (with the chat), POST /jobs/:id/messages
// Admin:        GET /jobs/ledger (every technician), POST /jobs/technicians/:id/settle
//
// Stages:  searching -> matched -> quoted -> agreed -> working -> done_pending -> closed        (or cancelled)
//   status (what older screens use):  searching, matched, quoted = pending | agreed, working, done_pending = in-progress | closed = completed
// Payment for now: the customer pays the technician in person. AutoAid's fee (JOBS_FEE_PERCENT, default 5) is worked out when the
// customer agrees the price, counted once the customer confirms the job, and settled by the admin from the ledger.
const express = require('express');

const feePercent = (() => {
  const n = Number(process.env.JOBS_FEE_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 5;
})();
const ONLINE_WINDOW_MS = 150 * 1000;         // a technician counts as online while their screen keeps checking in
const WIDEN_AFTER_MS = 2 * 60 * 1000;       // jobs reach technicians in other parishes after this long
const EXPIRE_AFTER_MS = 60 * 60 * 1000;     // a job nobody accepts for an hour is closed
const AUTO_CONFIRM_MS = 24 * 60 * 60 * 1000; // a finished job the customer never confirms is confirmed after a day
const MAX_ACTIVE_PER_TECH = 5;
const ACTIVE = ['matched', 'quoted', 'agreed', 'working', 'done_pending'];
const money = n => Math.round(Number(n) * 100) / 100;
const jmd = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });
const STATUS_OF = { searching: 'pending', matched: 'pending', quoted: 'pending', agreed: 'in-progress', working: 'in-progress', done_pending: 'in-progress', closed: 'completed', cancelled: 'cancelled' };

module.exports = function jobRoutes({ supabase, handle, auth }) {
  const router = express.Router();
  const techOnly = [auth.requireWorker, (req, res, next) => (req.user.role === 'staff' ? next() : res.status(403).json({ error: 'Only technicians can do this.' }))];
  const customerOnly = auth.requireRole('customer');
  const anyParty = auth.requireRole('customer', 'staff', 'admin');
  const adminOnly = auth.requireRole('admin');

  const isFresh = u => !!u.online && !!u.online_at && Date.now() - Date.parse(u.online_at) < ONLINE_WINDOW_MS;
  const specialtiesOf = u => String(u.specialties || '').split(',').filter(Boolean);
  const handles = (u, category) => category === 'other' || specialtiesOf(u).includes(category);
  const touch = patch => ({ ...patch, updated_at: new Date().toISOString() });

  async function rows(q) { const { data, error } = await q; if (error) throw error; return data; }
  async function vehiclesById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    return new Map((await rows(supabase.from('vehicles').select('id, type, year, owner, user_id').in('id', list))).map(v => [v.id, v]));
  }
  async function usersById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    return new Map((await rows(supabase.from('users').select('id, name, phone, parish, avatar_path, business_name').in('id', list))).map(u => [u.id, u]));
  }
  async function addMessage(jobId, senderId, kind, body) {
    const { error } = await supabase.from('job_messages').insert({ job_id: jobId, sender_id: senderId, kind, body });
    if (error) throw error;
  }
  async function setJob(row, patch) {
    const stage = patch.stage || row.stage;
    const { data, error } = await supabase.from('service_requests').update(touch({ ...patch, ...(patch.stage ? { status: STATUS_OF[patch.stage] } : {}) })).eq('id', row.id).select().single();
    if (error) throw error;
    void stage;
    return data;
  }

  // Housekeeping, run whenever someone looks at jobs: close jobs nobody took, confirm jobs the customer forgot
  let lastSweep = 0;
  async function sweep() {
    if (Date.now() - lastSweep < 20000) return;
    lastSweep = Date.now();
    try {
      const open = await rows(supabase.from('service_requests').select('*').in('stage', ['searching', 'done_pending']));
      for (const r of open) {
        if (r.stage === 'searching' && Date.now() - Date.parse(r.created_at) > EXPIRE_AFTER_MS) {
          await setJob(r, { stage: 'cancelled' });
          await addMessage(r.id, null, 'system', 'No technician was available in time, so this request was closed. You can post it again.');
        } else if (r.stage === 'done_pending' && r.done_at && Date.now() - Date.parse(r.done_at) > AUTO_CONFIRM_MS) {
          await setJob(r, { stage: 'closed', completed_at: new Date().toISOString(), amount: r.quote_amount, customer_unread: true });
          await addMessage(r.id, null, 'system', 'The job was confirmed automatically after 24 hours.');
        }
      }
    } catch (e) { console.error('Job sweep failed:', e.message); }
  }
  setInterval(sweep, 60000).unref();

  // ---------- shaping ----------
  const deal = r => ['agreed', 'working', 'done_pending', 'closed'].includes(r.stage);
  function shape(r, viewer, veh, users, extra = {}) {
    const isCustomer = viewer.role === 'customer', isTech = viewer.role === 'staff';
    const t = users.get(r.technician_id), c = veh ? users.get(veh.user_id) : null;
    return {
      id: r.id, stage: r.stage, status: r.status, category: r.category, description: r.description, premiumPerk: r.premium_perk || null,
      vehicle: veh ? { id: veh.id, name: veh.year + ' ' + veh.type } : null,
      parish: r.parish || '', locationText: r.location_text || '', hasCoords: r.latitude != null && r.longitude != null,
      ...(!isCustomer && r.latitude != null ? { latitude: r.latitude, longitude: r.longitude } : {}),
      createdAt: r.created_at, updatedAt: r.updated_at, acceptedAt: r.accepted_at || null,
      quote: r.quote_amount == null ? null : { amount: Number(r.quote_amount), etaMinutes: r.quote_eta_minutes, note: r.quote_note || '' },
      agreedAt: r.agreed_at || null, etaDeadline: r.eta_deadline || null, arrivedAt: r.arrived_at || null, doneAt: r.done_at || null, completedAt: r.completed_at || null,
      amount: r.amount == null ? null : Number(r.amount), rating: r.rating || null, review: r.review || '',
      technician: t ? { id: t.id, name: t.name, ...(deal(r) || !isCustomer ? { phone: t.phone || '' } : {}) } : null,
      customer: !isCustomer ? { name: c ? c.name : (veh ? veh.owner : ''), ...(deal(r) && c ? { phone: c.phone || '' } : {}) } : { name: c ? c.name : '' },
      ...(!isCustomer && r.fee_amount != null ? { fee: { percent: Number(r.fee_percent), amount: Number(r.fee_amount), settled: !!r.fee_settled_at } } : {}),
      unread: isCustomer ? !!r.customer_unread : isTech ? !!r.tech_unread : false,
      ...extra
    };
  }
  async function shapeMany(list, viewer, extras = () => ({})) {
    const vehicles = await vehiclesById(list.map(r => r.vehicle_id));
    const users = await usersById([...list.map(r => r.technician_id), ...[...vehicles.values()].map(v => v.user_id)]);
    return list.map(r => shape(r, viewer, vehicles.get(r.vehicle_id), users, extras(r)));
  }

  async function loadJob(req, res, who) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { res.status(404).json({ error: 'Job not found.' }); return null; }
    const row = (await rows(supabase.from('service_requests').select('*').eq('id', id)))[0];
    if (!row) { res.status(404).json({ error: 'Job not found.' }); return null; }
    const veh = (await vehiclesById([row.vehicle_id])).get(row.vehicle_id);
    const isCustomer = !!veh && veh.user_id === req.user.id, isTech = row.technician_id === req.user.id, isAdmin = req.user.role === 'admin';
    const canTake = who === 'accept' && req.user.role === 'staff';   // a technician may open an unassigned job in order to accept it
    if (!(isCustomer || isTech || isAdmin || canTake)) { res.status(404).json({ error: 'Job not found.' }); return null; }
    if (who === 'customer' && !isCustomer) { res.status(403).json({ error: 'Only the customer can do this.' }); return null; }
    if (who === 'tech' && !isTech) { res.status(403).json({ error: 'Only the technician on this job can do this.' }); return null; }
    return { row, veh, isCustomer, isTech };
  }

  // ---------- technician: online / offline, and the feed of new jobs ----------
  router.post('/jobs/online', ...techOnly, handle(async (req, res) => {
    const online = !!(req.body && req.body.online);
    if (online && !specialtiesOf(req.user).length) return res.status(400).json({ error: 'Add the kinds of work you do in My account first, so we know which jobs to send you.' });
    const { error } = await supabase.from('users').update({ online, online_at: new Date().toISOString() }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ online });
  }));

  router.get('/jobs/feed', ...techOnly, handle(async (req, res) => {
    await sweep();
    const u = req.user;
    if (u.online) await supabase.from('users').update({ online_at: new Date().toISOString() }).eq('id', u.id);   // "still here"
    const mineRows = await rows(supabase.from('service_requests').select('*').eq('technician_id', u.id));
    const mine = mineRows.filter(r => ACTIVE.includes(r.stage));
    let incoming = [];
    if (u.online) {
      const open = (await rows(supabase.from('service_requests').select('*').eq('stage', 'searching'))).filter(r => !r.technician_id && handles(u, r.category));
      incoming = open.filter(r => !r.parish || r.parish === u.parish || Date.now() - Date.parse(r.created_at) >= WIDEN_AFTER_MS);
    }
    const ledger = (await rows(supabase.from('service_requests').select('fee_amount, fee_settled_at, stage').eq('technician_id', u.id))).filter(r => r.stage === 'closed' && r.fee_amount && !r.fee_settled_at);
    res.json({
      online: !!u.online, specialties: specialtiesOf(u), feePercent,
      incoming: await shapeMany(incoming.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), req.user, r => ({ inYourParish: !r.parish || r.parish === u.parish })),
      mine: await shapeMany(mine.sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at)), req.user),
      feesDue: money(ledger.reduce((s, r) => s + Number(r.fee_amount), 0))
    });
  }));

  // ---------- technician: take the job (the first one wins) ----------
  router.post('/jobs/:id(\\d+)/accept', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'accept'); if (!j) return;
    const u = req.user;
    if (!isFresh(u)) return res.status(409).json({ error: 'Go online first to take jobs.' });
    if (!handles(u, j.row.category)) return res.status(403).json({ error: 'This job is for another department.' });
    if ((await rows(supabase.from('service_requests').select('id, stage').eq('technician_id', u.id))).filter(r => ACTIVE.includes(r.stage)).length >= MAX_ACTIVE_PER_TECH) {
      return res.status(409).json({ error: 'You have a lot of jobs open. Finish one first.' });
    }
    const { data, error } = await supabase.from('service_requests')
      .update(touch({ technician_id: u.id, stage: 'matched', status: 'pending', accepted_at: new Date().toISOString(), customer_unread: true, tech_unread: false }))
      .eq('id', j.row.id).eq('stage', 'searching').is('technician_id', null).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Another technician just took this job.' });
    await addMessage(data.id, u.id, 'system', u.name + ' accepted your request. Say hello and describe the problem. They will send you a price and an arrival time.');
    res.json({ ok: true, id: data.id });
  }));

  router.post('/jobs/:id(\\d+)/quote', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'tech'); if (!j) return;
    if (j.row.stage !== 'matched' && j.row.stage !== 'quoted') return res.status(409).json({ error: 'A price can only be sent before the customer agrees.' });
    const b = req.body || {};
    const amount = auth.parseAmount(b.amount);
    const perk = !!j.row.premium_perk;
    if (amount.error || amount.value === null || (!perk && amount.value <= 0)) return res.status(400).json({ error: perk ? 'Enter what the customer pays for parts and extras (0 if nothing).' : 'Enter your price in Jamaican dollars, e.g. 6500.' });
    const eta = Number(b.etaMinutes);
    if (!Number.isInteger(eta) || eta < 10 || eta > 1440) return res.status(400).json({ error: 'Say how many minutes until you arrive after the customer agrees (10 to 1440).' });
    const note = String(b.note || '').trim().slice(0, 300);
    await setJob(j.row, { stage: 'quoted', quote_amount: amount.value, quote_eta_minutes: eta, quote_note: note || null, quoted_at: new Date().toISOString(), customer_unread: true });
    await addMessage(j.row.id, req.user.id, 'system', 'Price: ' + jmd(amount.value) + '. The technician will arrive within ' + eta + ' minutes after you agree.' + (note ? ' Note: ' + note : ''));
    res.json({ ok: true });
  }));

  // the technician steps back: the job goes out to other technicians again
  router.post('/jobs/:id(\\d+)/release', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'tech'); if (!j) return;
    if (!['matched', 'quoted', 'agreed'].includes(j.row.stage)) return res.status(409).json({ error: 'You can only step back before you start the work.' });
    await setJob(j.row, { stage: 'searching', technician_id: null, accepted_at: null, quote_amount: null, quote_eta_minutes: null, quote_note: null, quoted_at: null, agreed_at: null, eta_deadline: null, fee_percent: null, fee_amount: null, customer_unread: true });
    await addMessage(j.row.id, req.user.id, 'system', 'The technician can no longer take this job. We are looking for another technician.');
    res.json({ ok: true });
  }));

  router.post('/jobs/:id(\\d+)/arrived', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'tech'); if (!j) return;
    if (j.row.stage !== 'agreed') return res.status(409).json({ error: 'The customer has not agreed the price yet.' });
    await setJob(j.row, { stage: 'working', arrived_at: new Date().toISOString(), customer_unread: true });
    await addMessage(j.row.id, req.user.id, 'system', 'The technician has arrived and started the work.');
    res.json({ ok: true });
  }));

  router.post('/jobs/:id(\\d+)/done', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'tech'); if (!j) return;
    if (!['agreed', 'working'].includes(j.row.stage)) return res.status(409).json({ error: 'This job is not in progress.' });
    await setJob(j.row, { stage: 'done_pending', done_at: new Date().toISOString(), arrived_at: j.row.arrived_at || new Date().toISOString(), customer_unread: true });
    await addMessage(j.row.id, req.user.id, 'system', 'The technician says the job is done. Please check the work and confirm.' + (j.row.premium_perk ? '' : ' You pay ' + jmd(j.row.quote_amount) + ' to the technician in person.'));
    res.json({ ok: true });
  }));

  // ---------- customer: answer the price, change technician, confirm, cancel ----------
  router.post('/jobs/:id(\\d+)/quote/respond', customerOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'customer'); if (!j) return;
    if (j.row.stage !== 'quoted' || j.row.quote_amount == null) return res.status(409).json({ error: 'There is no price to answer.' });
    if (req.body && req.body.accept === true) {
      const fee = j.row.premium_perk ? 0 : money(Number(j.row.quote_amount) * feePercent / 100);
      await setJob(j.row, { stage: 'agreed', agreed_at: new Date().toISOString(), eta_deadline: new Date(Date.now() + j.row.quote_eta_minutes * 60000).toISOString(), fee_percent: j.row.premium_perk ? 0 : feePercent, fee_amount: fee, tech_unread: true });
      await addMessage(j.row.id, req.user.id, 'system', 'Price agreed: ' + jmd(j.row.quote_amount) + '. The technician should arrive within ' + j.row.quote_eta_minutes + ' minutes. Phone numbers are now showing.');
    } else {
      await setJob(j.row, { stage: 'matched', quote_amount: null, quote_eta_minutes: null, quote_note: null, tech_unread: true });
      await addMessage(j.row.id, req.user.id, 'system', 'The customer did not accept that price. You can keep chatting and send a new one.');
    }
    res.json({ ok: true });
  }));

  router.post('/jobs/:id(\\d+)/change-technician', customerOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'customer'); if (!j) return;
    if (!['matched', 'quoted'].includes(j.row.stage)) return res.status(409).json({ error: 'You can ask for another technician before you agree a price.' });
    await addMessage(j.row.id, req.user.id, 'system', 'The customer asked for a different technician. We are looking again.');
    await setJob(j.row, { stage: 'searching', technician_id: null, accepted_at: null, quote_amount: null, quote_eta_minutes: null, quote_note: null, quoted_at: null, tech_unread: false });
    res.json({ ok: true });
  }));

  router.post('/jobs/:id(\\d+)/confirm', customerOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'customer'); if (!j) return;
    if (j.row.stage !== 'done_pending') return res.status(409).json({ error: 'The technician has not said the job is done yet.' });
    await setJob(j.row, { stage: 'closed', completed_at: new Date().toISOString(), amount: j.row.quote_amount, tech_unread: true });
    await addMessage(j.row.id, req.user.id, 'system', 'The customer confirmed the job is complete. Thank you!');
    res.json({ ok: true });
  }));

  router.post('/jobs/:id(\\d+)/cancel', customerOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'customer'); if (!j) return;
    if (!['searching', 'matched', 'quoted', 'agreed'].includes(j.row.stage)) return res.status(409).json({ error: 'This job can no longer be cancelled here. Contact the shop.' });
    await setJob(j.row, { stage: 'cancelled', fee_percent: null, fee_amount: null, tech_unread: true });
    if (j.row.technician_id) await addMessage(j.row.id, req.user.id, 'system', 'The customer cancelled this job.');
    res.json({ ok: true });
  }));

  // ---------- one job with its chat ----------
  router.get('/jobs/:id(\\d+)', ...[anyParty], handle(async (req, res) => {
    await sweep();
    const j = await loadJob(req, res); if (!j) return;
    let row = j.row;
    const mine = j.isCustomer ? 'customer_unread' : j.isTech ? 'tech_unread' : null;
    if (mine && row[mine]) { const { data } = await supabase.from('service_requests').update({ [mine]: false }).eq('id', row.id).select().single(); if (data) row = data; }
    const msgs = await rows(supabase.from('job_messages').select('*').eq('job_id', row.id).order('id', { ascending: true }));
    const vehicles = await vehiclesById([row.vehicle_id]);
    const users = await usersById([row.technician_id, ...[...vehicles.values()].map(v => v.user_id), ...msgs.map(m => m.sender_id)]);
    let onlineTechs = null;
    if (row.stage === 'searching') {
      const all = await rows(supabase.from('users').select('id, specialties, online, online_at, approved, active').eq('role', 'staff'));
      onlineTechs = all.filter(t => t.active !== false && t.approved !== false && isFresh(t) && handles(t, row.category)).length;
    }
    res.json({
      feePercent,
      order: shape(row, req.user, vehicles.get(row.vehicle_id), users, onlineTechs == null ? {} : { onlineTechs }),
      messages: msgs.map(m => ({
        id: m.id, kind: m.kind, body: m.body, createdAt: m.created_at,
        from: m.kind === 'system' ? 'system' : m.sender_id === req.user.id ? 'me' : 'them',
        sender: m.kind === 'system' ? '' : (users.get(m.sender_id) || {}).name || ''
      }))
    });
  }));

  router.post('/jobs/:id(\\d+)/messages', ...[anyParty], handle(async (req, res) => {
    const j = await loadJob(req, res); if (!j) return;
    if (req.user.role === 'admin' && !j.isCustomer && !j.isTech) return res.status(403).json({ error: 'Admins can read jobs but not write in them.' });
    if (!['matched', 'quoted', 'agreed', 'working', 'done_pending'].includes(j.row.stage)) return res.status(409).json({ error: 'The chat opens once a technician accepts, and closes when the job ends.' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Type a message first.' });
    if (body.length > 1000) return res.status(400).json({ error: 'That message is too long (1000 characters at most).' });
    const count = await rows(supabase.from('job_messages').select('id').eq('job_id', j.row.id));
    if (count.length >= 500) return res.status(429).json({ error: 'This chat is full.' });
    await addMessage(j.row.id, req.user.id, 'text', body);
    await setJob(j.row, j.isCustomer ? { tech_unread: true } : { customer_unread: true });
    res.status(201).json({ ok: true });
  }));

  // ---------- fees: technicians see their own, the admin sees everyone ----------
  router.get('/jobs/ledger', auth.requireRole('staff', 'admin'), handle(async (req, res) => {
    let q = supabase.from('service_requests').select('*').eq('stage', 'closed');
    if (req.user.role === 'staff') q = q.eq('technician_id', req.user.id);
    const data = (await rows(q)).filter(r => r.fee_amount != null);
    const users = await usersById(data.map(r => r.technician_id));
    const by = new Map();
    for (const r of data) {
      const t = users.get(r.technician_id);
      const v = by.get(r.technician_id) || { vendorId: r.technician_id, name: t ? t.name : 'Removed technician', orders: 0, sales: 0, commission: 0, settled: 0 };
      v.orders++; v.sales = money(v.sales + Number(r.amount || 0)); v.commission = money(v.commission + Number(r.fee_amount));
      if (r.fee_settled_at) v.settled = money(v.settled + Number(r.fee_amount));
      by.set(r.technician_id, v);
    }
    res.json({
      commissionPercent: feePercent, vendors: [...by.values()].map(v => ({ ...v, owed: money(v.commission - v.settled) })),
      orders: req.user.role === 'staff' ? data.map(r => ({ id: r.id, part: r.category + ' job #' + r.id, total: Number(r.amount || 0), commission: Number(r.fee_amount), settled: !!r.fee_settled_at, completedAt: r.completed_at })) : undefined
    });
  }));
  router.post('/jobs/technicians/:id/settle', adminOnly, handle(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Technician not found.' });
    const { data, error } = await supabase.from('service_requests').update({ fee_settled_at: new Date().toISOString() }).eq('technician_id', id).eq('stage', 'closed').is('fee_settled_at', null).select();
    if (error) throw error;
    res.json({ settled: data.length });
  }));

  return { router, feePercent, ACTIVE, STATUS_OF };
};
