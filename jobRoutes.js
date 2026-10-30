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
// Payment, two ways (the same job code handles both):
//   in person (the default)  the customer pays the technician; the technician owes AutoAid its fee (JOBS_FEE_PERCENT, default 5), settled in the ledger.
//   online (JOBS_ONLINE_PAYMENT=true and Fygaro set up)  the customer pays on Fygaro when they agree the price; AutoAid holds the money,
//     and after the customer confirms the job it owes the technician price minus fee (a "payout"). A cancelled paid job is refunded,
//     and a complaint holds the payout until the admin decides.
const express = require('express');
const events = require('./jobEvents');
const bigJson = express.json({ limit: '6mb' });

const feePercent = (() => {
  const n = Number(process.env.JOBS_FEE_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 5;
})();
const ONLINE_WINDOW_MS = 150 * 1000;         // a technician counts as online while their screen keeps checking in
const WIDEN_AFTER_MS = 2 * 60 * 1000;       // jobs reach technicians in other parishes after this long
const WIDEN_URGENT_MS = 30 * 1000;          // emergencies spread much faster
const EXPIRE_AFTER_MS = 60 * 60 * 1000;     // a job nobody accepts for an hour is closed
const EXPIRE_URGENT_MS = 30 * 60 * 1000;    // an emergency nobody accepts for 30 minutes is closed (so the customer can call the shop or try again)
const AUTO_CONFIRM_MS = 24 * 60 * 60 * 1000; // a finished job the customer never confirms is confirmed after a day
const MAX_ACTIVE_PER_TECH = 5;
const ACTIVE = ['matched', 'quoted', 'agreed', 'working', 'done_pending'];
const money = n => Math.round(Number(n) * 100) / 100;
const jmd = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });
const STATUS_OF = { searching: 'pending', matched: 'pending', quoted: 'pending', agreed: 'in-progress', working: 'in-progress', done_pending: 'in-progress', closed: 'completed', cancelled: 'cancelled' };

const LABEL = { diagnostics: 'Diagnostics', mechanical: 'Mechanical', tire: 'Tire', electrical: 'Electrical', maintenance: 'Maintenance', bodywork: 'Auto body repairs', roadside: 'Roadside assistance', towing: 'Wrecker / towing', other: 'Repair' };
const TECH_LOC_FRESH_MS = 3 * 60 * 1000;   // a shared position older than this is not shown
const ESCALATE_AFTER_MS = (Number(process.env.ESCALATE_AFTER_SECONDS) || 300) * 1000;   // an emergency nobody took in this time is reported to the admin
const PUSH_WINDOW_MS = 12 * 60 * 60 * 1000;   // a technician who switched Online and has phone alerts on is still reachable for 12 hours

module.exports = function jobRoutes({ supabase, handle, auth, subs, push }) {
  const router = express.Router();
  const onlinePayment = () => process.env.JOBS_ONLINE_PAYMENT === 'true' && !!subs && subs.gatewayReady();
  const techOnly = [auth.requireWorker, (req, res, next) => (req.user.role === 'staff' ? next() : res.status(403).json({ error: 'Only technicians can do this.' }))];
  const customerOnly = auth.requireRole('customer');
  const anyParty = auth.requireRole('customer', 'staff', 'admin');
  const adminOnly = auth.requireRole('admin');

  const isFresh = u => !!u.online && !!u.online_at && Date.now() - Date.parse(u.online_at) < ONLINE_WINDOW_MS;
  const specialtiesOf = u => String(u.specialties || '').split(',').filter(Boolean);
  const handles = (u, category) => category === 'other' || specialtiesOf(u).includes(category);
  // Emergencies put a technician at a stranger's roadside, so only technicians whose ID the shop has checked receive them
  const canTake = (u, row) => handles(u, row.category) && (!row.urgent || !!u.pro_verified);
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
    const map = new Map((await rows(supabase.from('users').select('id, name, phone, parish, avatar_path, business_name, pro_verified').in('id', list))).map(u => [u.id, u]));
    // star rating and number of finished jobs, shown on a technician's profile card
    const done = await rows(supabase.from('service_requests').select('technician_id, rating, stage').in('technician_id', list).eq('stage', 'closed'));
    for (const u of map.values()) {
      const mine = done.filter(d => d.technician_id === u.id), rated = mine.filter(d => d.rating);
      u.stats = { jobs: mine.length, ratings: rated.length, average: rated.length ? Math.round(rated.reduce((s, d) => s + Number(d.rating), 0) / rated.length * 10) / 10 : null };
    }
    return map;
  }
  async function addMessage(jobId, senderId, kind, body) {
    const { error } = await supabase.from('job_messages').insert({ job_id: jobId, sender_id: senderId, kind, body });
    if (error) throw error;
    tellOthers(jobId, senderId, kind, body).catch(() => {});   // phone notification; never holds up the request
  }
  // Wakes the other person's phone: a chat message, or a step in the job (accepted, price, agreed, arrived, done...)
  async function tellOthers(jobId, senderId, kind, body) {
    if (!push) return;
    const row = (await rows(supabase.from('service_requests').select('id, technician_id, customer_id, vehicle_id, category, urgent').eq('id', jobId)))[0];
    if (!row) return;
    let customerId = row.customer_id;
    if (!customerId && row.vehicle_id) { const v = (await vehiclesById([row.vehicle_id])).get(row.vehicle_id); customerId = v && v.user_id; }
    const people = [{ id: row.technician_id, url: '/admin.html?job=' + jobId }, { id: customerId, url: '/app.html?job=' + jobId }].filter(p => p.id && p.id !== senderId);
    if (!people.length) return;
    let who = '';
    if (kind === 'text' && senderId) who = ((await usersById([senderId])).get(senderId) || {}).name || '';
    const label = LABEL[row.category] || 'your job';
    const title = kind === 'text' ? 'New message: ' + label : (row.urgent ? '\u{1F6A8} ' : '') + 'AutoAid 24/7: ' + label;
    const text = kind === 'text' ? (who ? who + ': ' : '') + String(body).slice(0, 90) : String(body).slice(0, 120);
    for (const p of people) await push.notify([p.id], { title, body: text, url: p.url, tag: 'job-' + jobId });
  }
  // A new job exists: alert the technicians who handle that department (phone notification, and an email for emergencies)
  async function alertNewJob(row) {
    if (!push) return;
    try {
      const techs = await rows(supabase.from('users').select('id, name, email, specialties, parish, online, online_at, approved, active, pro_verified').eq('role', 'staff'));
      const eligible = techs.filter(t => t.active !== false && t.approved !== false && t.online && t.online_at && Date.now() - Date.parse(t.online_at) < PUSH_WINDOW_MS && canTake(t, row));
      if (!eligible.length) { escalate(row, 'No verified technician is online for this job.'); return; }
      const label = LABEL[row.category] || 'Repair';
      const where = row.location_text || row.parish || '';
      const title = row.urgent ? '\u{1F6A8} URGENT: ' + label : 'New job: ' + label;
      await push.notify(eligible.map(t => t.id), { title, body: [where, row.description].filter(Boolean).join(' \u00b7 ').slice(0, 140), url: '/admin.html?job=' + row.id, tag: 'new-job-' + row.id, urgent: !!row.urgent });
      if (row.urgent) await push.email(eligible, 'URGENT ' + label + ' job' + (row.parish ? ' in ' + row.parish : ''), 'A customer needs help now' + (where ? ': ' + where : '') + '.\n' + row.description);
    } catch (err) { console.error('New job alert failed:', err.message); }
  }
  events.on('new-job', row => { alertNewJob(row); });
  // An emergency nobody has taken: tell the admins by email so the customer is never left waiting alone
  async function escalate(row, why) {
    try {
      const fresh = (await rows(supabase.from('service_requests').select('id, stage, escalated_at, technician_id').eq('id', row.id)))[0];
      if (!fresh || fresh.stage !== 'searching' || fresh.escalated_at) return;
      await supabase.from('service_requests').update({ escalated_at: new Date().toISOString() }).eq('id', row.id);
      const admins = await rows(supabase.from('users').select('id, name, email').eq('role', 'admin').eq('active', true));
      if (push) {
        const where = row.location_text || row.parish || 'location not given';
        await push.notify(admins.map(a => a.id), { title: '\u{1F6A8} Emergency not answered', body: (LABEL[row.category] || 'Job') + ' at ' + where + '. ' + why, url: '/admin.html?job=' + row.id, tag: 'escalate-' + row.id, urgent: true });
        await push.email(admins, 'Emergency not answered yet', (LABEL[row.category] || 'A job') + ' request #' + row.id + ' (' + where + ') has no technician. ' + why + ' Phone the customer' + (row.contact_phone ? ' on ' + row.contact_phone : '') + ' or send someone yourself.');
      }
    } catch (e) { console.error('Escalation failed:', e.message); }
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
        if (r.stage === 'searching' && r.urgent && !r.escalated_at && Date.now() - Date.parse(r.created_at) > ESCALATE_AFTER_MS) await escalate(r, 'Nobody has accepted it after 5 minutes.');
        if (r.stage === 'searching' && Date.now() - Date.parse(r.created_at) > (r.urgent ? EXPIRE_URGENT_MS : EXPIRE_AFTER_MS)) {
          await setJob(r, { stage: 'cancelled' });
          await addMessage(r.id, null, 'system', 'No technician was available in time, so this request was closed. You can post it again.');
        } else if (r.stage === 'done_pending' && r.done_at && Date.now() - Date.parse(r.done_at) > AUTO_CONFIRM_MS) {
          if (!r.disputed_at) await closeJob(r, 'The job was confirmed automatically after 24 hours.');
        }
      }
    } catch (e) { console.error('Job sweep failed:', e.message); }
  }
  setInterval(sweep, 60000).unref();

  // The price is agreed: the arrival clock starts and the fee is worked out
  async function agreeJob(row, extra = {}) {
    const fee = row.premium_perk ? 0 : money(Number(row.quote_amount) * feePercent / 100);
    return setJob(row, { stage: 'agreed', agreed_at: new Date().toISOString(), eta_deadline: new Date(Date.now() + row.quote_eta_minutes * 60000).toISOString(), fee_percent: row.premium_perk ? 0 : feePercent, fee_amount: fee, tech_unread: true, ...extra });
  }
  // The job is finished and accepted (by the customer, automatically, or by the admin after a complaint)
  async function closeJob(row, note) {
    const platform = row.pay_mode === 'platform' && row.pay_status === 'paid';
    const patch = { stage: 'closed', completed_at: new Date().toISOString(), amount: row.quote_amount, tech_unread: true };
    if (platform) patch.payout_amount = money(Number(row.paid_amount) - Number(row.fee_amount || 0));
    const done = await setJob(row, patch);
    await addMessage(row.id, null, 'system', note);
    return done;
  }
  // A paid job that will not go ahead: the customer is owed their money back
  async function cancelWithRefund(row, why, reasonText) {
    const paid = row.pay_status === 'paid' && row.refund_status !== 'done';
    const done = await setJob(row, { stage: 'cancelled', fee_percent: null, fee_amount: null, tech_unread: true, customer_unread: true, ...(paid ? { refund_status: 'due', refund_note: reasonText || why } : {}) });
    await addMessage(row.id, null, 'system', why + (paid ? ' Your payment of ' + jmd(row.paid_amount) + ' will be refunded.' : ''));
    return done;
  }

  // ---------- shaping ----------
  const deal = r => ['agreed', 'working', 'done_pending', 'closed'].includes(r.stage);
  function shape(r, viewer, veh, users, extra = {}) {
    const isCustomer = viewer.role === 'customer', isTech = viewer.role === 'staff';
    const t = users.get(r.technician_id), c = users.get(r.customer_id) || (veh ? users.get(veh.user_id) : null);
    const sharePhones = deal(r) || (!!r.urgent && !!r.technician_id);   // emergencies share phone numbers as soon as a technician accepts
    return {
      id: r.id, stage: r.stage, status: r.status, category: r.category, description: r.description, premiumPerk: r.premium_perk || null,
      vehicle: veh ? { id: veh.id, name: veh.year + ' ' + veh.type } : null,
      parish: r.parish || '', locationText: r.location_text || '', hasCoords: r.latitude != null && r.longitude != null,
      ...(!isCustomer && r.latitude != null ? { latitude: r.latitude, longitude: r.longitude } : {}),
      createdAt: r.created_at, updatedAt: r.updated_at, acceptedAt: r.accepted_at || null,
      quote: r.quote_amount == null ? null : { amount: Number(r.quote_amount), etaMinutes: r.quote_eta_minutes, note: r.quote_note || '' },
      agreedAt: r.agreed_at || null, etaDeadline: r.eta_deadline || null, arrivedAt: r.arrived_at || null, doneAt: r.done_at || null, completedAt: r.completed_at || null,
      amount: r.amount == null ? null : Number(r.amount), rating: r.rating || null, review: r.review || '',
      technician: t ? { id: t.id, name: t.name, verified: !!t.pro_verified, rating: t.stats ? t.stats.average : null, ratings: t.stats ? t.stats.ratings : 0, jobsDone: t.stats ? t.stats.jobs : 0, ...(sharePhones || !isCustomer ? { phone: t.phone || '' } : {}) } : null,
      ...(r.tech_lat != null && r.tech_loc_at && Date.now() - Date.parse(r.tech_loc_at) < TECH_LOC_FRESH_MS && ['matched', 'quoted', 'agreed'].includes(r.stage) ? { techLocation: { latitude: r.tech_lat, longitude: r.tech_lng, at: r.tech_loc_at } } : {}),
      customer: !isCustomer ? { name: c ? c.name : (veh ? veh.owner : ''), ...(sharePhones ? { phone: r.contact_phone || (c ? c.phone : '') || '' } : {}) } : { name: c ? c.name : '' },
      urgent: !!r.urgent,
      ...(!isCustomer && r.fee_amount != null ? { fee: { percent: Number(r.fee_percent), amount: Number(r.fee_amount), settled: !!r.fee_settled_at } } : {}),
      payMode: r.pay_mode || 'in_person', paid: r.pay_status === 'paid', paidAmount: r.paid_amount == null ? null : Number(r.paid_amount),
      refund: r.refund_status && r.refund_status !== 'none' ? r.refund_status : null, disputed: !!r.disputed_at, disputeNote: r.disputed_at ? (r.dispute_note || '') : '',
      ...(!isCustomer && r.payout_amount != null ? { payout: { amount: Number(r.payout_amount), settled: !!r.payout_settled_at } } : {}),
      ...(isCustomer && r.stage === 'quoted' && r.quote_amount != null && Number(r.quote_amount) > 0 && !r.premium_perk && onlinePayment()
        ? { payUrl: subs.checkoutUrl({ amount: Number(r.quote_amount).toFixed(2), currency: subs.config.currency, custom_reference: 'job-' + r.id + '-' + Date.parse(r.quoted_at || r.updated_at || r.created_at) }, 3 * 3600) } : {}),
      unread: isCustomer ? !!r.customer_unread : isTech ? !!r.tech_unread : false,
      ...extra
    };
  }
  async function shapeMany(list, viewer, extras = () => ({})) {
    const vehicles = await vehiclesById(list.map(r => r.vehicle_id));
    const users = await usersById([...list.map(r => r.technician_id), ...list.map(r => r.customer_id), ...[...vehicles.values()].map(v => v.user_id)]);
    const urls = new Map(await Promise.all(list.filter(r => r.photo_path).map(async r => [r.id, await auth.signedPhotoUrl(r.photo_path).catch(() => null)])));
    return list.map(r => shape(r, viewer, vehicles.get(r.vehicle_id), users, { ...(urls.get(r.id) ? { photoUrl: urls.get(r.id) } : {}), ...extras(r) }));
  }

  async function loadJob(req, res, who) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { res.status(404).json({ error: 'Job not found.' }); return null; }
    const row = (await rows(supabase.from('service_requests').select('*').eq('id', id)))[0];
    if (!row) { res.status(404).json({ error: 'Job not found.' }); return null; }
    const veh = (await vehiclesById([row.vehicle_id])).get(row.vehicle_id);
    const isCustomer = row.customer_id === req.user.id || (!!veh && veh.user_id === req.user.id), isTech = row.technician_id === req.user.id, isAdmin = req.user.role === 'admin';
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
    if (online && req.user.provider_type === 'sole' && req.user.identity_status !== 'approved') return res.status(403).json({ error: req.user.identity_status === 'rejected' ? 'Your face check was not accepted. Do it again in My account, then you can go online.' : 'Your face check is still being reviewed by AutoAid 24/7. You can go online as soon as it is approved.', code: 'identity' });
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
      const open = (await rows(supabase.from('service_requests').select('*').eq('stage', 'searching'))).filter(r => !r.technician_id && canTake(u, r));
      incoming = open.filter(r => !r.parish || r.parish === u.parish || Date.now() - Date.parse(r.created_at) >= (r.urgent ? WIDEN_URGENT_MS : WIDEN_AFTER_MS));
    }
    const mineAll = await rows(supabase.from('service_requests').select('fee_amount, fee_settled_at, stage, pay_mode, payout_amount, payout_settled_at').eq('technician_id', u.id));
    const ledger = mineAll.filter(r => r.stage === 'closed' && r.pay_mode !== 'platform' && r.fee_amount && !r.fee_settled_at);
    const payouts = mineAll.filter(r => r.stage === 'closed' && r.pay_mode === 'platform' && r.payout_amount != null && !r.payout_settled_at);
    res.json({
      online: !!u.online, specialties: specialtiesOf(u), feePercent, emergenciesLocked: !u.pro_verified,
      incoming: await shapeMany(incoming.sort((a, b) => (Number(!!b.urgent) - Number(!!a.urgent)) || Date.parse(b.created_at) - Date.parse(a.created_at)), req.user, r => ({ inYourParish: !r.parish || r.parish === u.parish })),
      mine: await shapeMany(mine.sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at)), req.user),
      feesDue: money(ledger.reduce((s, r) => s + Number(r.fee_amount), 0)),
      payoutsDue: money(payouts.reduce((s, r) => s + Number(r.payout_amount), 0)), onlinePayment: onlinePayment()
    });
  }));

  // ---------- technician: take the job (the first one wins) ----------
  router.post('/jobs/:id(\\d+)/accept', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'accept'); if (!j) return;
    const u = req.user;
    if (!isFresh(u)) return res.status(409).json({ error: 'Go online first to take jobs.' });
    if (!handles(u, j.row.category)) return res.status(403).json({ error: 'This job is for another department.' });
    if (j.row.urgent && !u.pro_verified) return res.status(403).json({ error: 'Emergency jobs are given to technicians whose ID AutoAid 24/7 has checked. Contact us to get verified.' });
    if ((await rows(supabase.from('service_requests').select('id, stage').eq('technician_id', u.id))).filter(r => ACTIVE.includes(r.stage)).length >= MAX_ACTIVE_PER_TECH) {
      return res.status(409).json({ error: 'You have a lot of jobs open. Finish one first.' });
    }
    const { data, error } = await supabase.from('service_requests')
      .update(touch({ technician_id: u.id, stage: 'matched', status: 'pending', accepted_at: new Date().toISOString(), customer_unread: true, tech_unread: false }))
      .eq('id', j.row.id).eq('stage', 'searching').is('technician_id', null).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Another technician just took this job.' });
    await addMessage(data.id, u.id, 'system', u.name + (data.urgent ? ' accepted your emergency request. Their phone number is showing so you can call them. They will send you a price and an arrival time here.' : ' accepted your request. Say hello and describe the problem. They will send you a price and an arrival time.'));
    res.json({ ok: true, id: data.id });
  }));

  // The technician shares where they are so the customer can see them coming
  router.post('/jobs/:id(\\d+)/location', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'tech'); if (!j) return;
    if (!['matched', 'quoted', 'agreed'].includes(j.row.stage)) return res.status(409).json({ error: 'Sharing location is only for jobs on the way.' });
    const lat = Number(req.body && req.body.latitude), lng = Number(req.body && req.body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'That position is not valid.' });
    const { error } = await supabase.from('service_requests').update({ tech_lat: lat, tech_lng: lng, tech_loc_at: new Date().toISOString() }).eq('id', j.row.id);
    if (error) throw error;
    res.json({ ok: true });
  }));

  router.post('/jobs/:id(\\d+)/quote', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'tech'); if (!j) return;
    if (j.row.stage !== 'matched' && j.row.stage !== 'quoted') return res.status(409).json({ error: 'A price can only be sent before the customer agrees.' });
    const b = req.body || {};
    const amount = auth.parseAmount(b.amount);
    const perk = !!j.row.premium_perk;
    if (amount.error || amount.value === null || (!perk && amount.value <= 0)) return res.status(400).json({ error: perk ? 'Enter what the customer pays for parts and extras (0 if nothing).' : 'Enter your price in Jamaican dollars, e.g. 6500.' });
    const eta = Number(b.etaMinutes);
    const minEta = j.row.urgent ? 5 : 10;
    if (!Number.isInteger(eta) || eta < minEta || eta > 1440) return res.status(400).json({ error: 'Say how many minutes until you arrive after the customer agrees (' + minEta + ' to 1440).' });
    const note = String(b.note || '').trim().slice(0, 300);
    await setJob(j.row, { stage: 'quoted', quote_amount: amount.value, quote_eta_minutes: eta, quote_note: note || null, quoted_at: new Date().toISOString(), customer_unread: true });
    await addMessage(j.row.id, req.user.id, 'system', 'Price: ' + jmd(amount.value) + '. The technician will arrive within ' + eta + ' minutes after you agree.' + (note ? ' Note: ' + note : ''));
    res.json({ ok: true });
  }));

  // the technician steps back: the job goes out to other technicians again
  router.post('/jobs/:id(\\d+)/release', ...techOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'tech'); if (!j) return;
    if (!['matched', 'quoted', 'agreed'].includes(j.row.stage)) return res.status(409).json({ error: 'You can only step back before you start the work.' });
    if (j.row.pay_status === 'paid') { await cancelWithRefund(j.row, 'The technician cannot make it.', 'Technician could not come'); return res.json({ ok: true, refunded: true }); }
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
      if (onlinePayment() && !j.row.premium_perk && Number(j.row.quote_amount) > 0) return res.status(409).json({ error: 'Use the secure payment button to agree this price. The job is booked as soon as your payment goes through.' });
      await agreeJob(j.row, { pay_mode: 'in_person' });
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
    await closeJob(j.row, 'The customer confirmed the job is complete. Thank you!' + (j.row.pay_mode === 'platform' ? ' The technician is paid from your payment.' : ''));
    res.json({ ok: true });
  }));

  // The customer adds a photo of where they are (or of the problem). Technicians who can see the job see it too.
  router.post('/jobs/:id(\\d+)/photo', customerOnly, bigJson, handle(async (req, res) => {
    const j = await loadJob(req, res, 'customer'); if (!j) return;
    if (!['searching', 'matched', 'quoted', 'agreed', 'working'].includes(j.row.stage)) return res.status(409).json({ error: 'You can add a photo while the job is open.' });
    const img = auth.readImage(req.body);
    if (img.error) return res.status(img.status).json({ error: img.error });
    const path = 'jobs/photo-' + j.row.id;
    await auth.storePhoto(path, img.buf, img.type);
    await setJob(j.row, { photo_path: path, photo_at: new Date().toISOString(), tech_unread: !!j.row.technician_id });
    if (j.row.technician_id) await addMessage(j.row.id, req.user.id, 'system', 'The customer added a photo.');
    res.json({ ok: true });
  }));

  // "Report a problem": the payout is held and the admin decides
  router.post('/jobs/:id(\\d+)/dispute', customerOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'customer'); if (!j) return;
    if (j.row.stage !== 'done_pending') return res.status(409).json({ error: 'You can report a problem once the technician says the job is done.' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
    if (note.length < 5) return res.status(400).json({ error: 'Tell us briefly what went wrong.' });
    await setJob(j.row, { disputed_at: new Date().toISOString(), dispute_note: note, tech_unread: true });
    await addMessage(j.row.id, req.user.id, 'system', 'The customer reported a problem: ' + note + ' AutoAid 24/7 will look into it and contact you both. ' + (j.row.pay_mode === 'platform' ? 'The payment is held until then.' : ''));
    res.json({ ok: true });
  }));

  router.post('/jobs/:id(\\d+)/cancel', customerOnly, handle(async (req, res) => {
    const j = await loadJob(req, res, 'customer'); if (!j) return;
    if (!['searching', 'matched', 'quoted', 'agreed'].includes(j.row.stage)) return res.status(409).json({ error: 'This job can no longer be cancelled here. Contact the shop.' });
    if (j.row.pay_status === 'paid') { await cancelWithRefund(j.row, 'The customer cancelled this job.', 'Customer cancelled'); return res.json({ ok: true, refunded: true }); }
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
      const all = await rows(supabase.from('users').select('id, specialties, online, online_at, approved, active, pro_verified').eq('role', 'staff'));
      const subscribed = push ? await push.withSubscriptions(all.map(t => t.id)) : new Set();
      const reachable = t => isFresh(t) || (!!t.online && subscribed.has(t.id) && !!t.online_at && Date.now() - Date.parse(t.online_at) < PUSH_WINDOW_MS);
      onlineTechs = all.filter(t => t.active !== false && t.approved !== false && reachable(t) && canTake(t, row)).length;
    }
    res.json({
      feePercent, onlinePayment: onlinePayment(),
      order: shape(row, req.user, vehicles.get(row.vehicle_id), users, { ...(onlineTechs == null ? {} : { onlineTechs }), ...(row.photo_path ? { photoUrl: await auth.signedPhotoUrl(row.photo_path).catch(() => null) } : {}) }),
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
    const data = (await rows(q)).filter(r => r.fee_amount != null && r.pay_mode !== 'platform');
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

  // ---------- online payments: the webhook, and what the admin has to do by hand ----------
  if (subs && subs.registerPaymentHandler) {
    subs.registerPaymentHandler('job', async ({ jobId, amount, currency, transactionId }) => {
      const dup = await rows(supabase.from('service_requests').select('id').eq('transaction_id', transactionId));
      if (dup.length) return;                                  // Fygaro sent the same notification twice
      const row = (await rows(supabase.from('service_requests').select('*').eq('id', jobId)))[0];
      if (!row) { console.warn('Fygaro job payment for a job that does not exist:', jobId, transactionId); return; }
      const fits = row.stage === 'quoted' && row.quote_amount != null && currency === subs.config.currency && Math.abs(amount - Number(row.quote_amount)) < 0.01;
      const payFields = { pay_mode: 'platform', pay_status: 'paid', paid_at: new Date().toISOString(), paid_amount: amount, transaction_id: transactionId };
      try {
        if (fits) {
          await agreeJob(row, payFields);
          await addMessage(row.id, null, 'system', 'Payment of ' + jmd(amount) + ' received. AutoAid 24/7 holds it until you confirm the job is done. The technician should arrive within ' + row.quote_eta_minutes + ' minutes. Phone numbers are now showing.');
        } else {
          console.warn(`Fygaro job payment ${transactionId} could not be used: job ${jobId} is "${row.stage}", got ${amount} ${currency}, price ${row.quote_amount}`);
          await setJob(row, { ...payFields, refund_status: 'due', refund_note: 'Payment arrived when the job was not waiting for it (or the price changed).', customer_unread: true });
          await addMessage(row.id, null, 'system', 'A payment of ' + jmd(amount) + ' arrived, but the job could not use it (the price or the job changed). It will be refunded in full. Nothing else is needed from you.');
        }
      } catch (e) { if (!(e && e.code === '23505')) throw e; }   // a second copy of the same transaction arrived at the same moment
    });
  }

  // What the admin has to do by hand: pay technicians, refund customers, decide complaints
  router.get('/jobs/payouts', adminOnly, handle(async (req, res) => {
    const all = await rows(supabase.from('service_requests').select('*').eq('pay_mode', 'platform'));
    // Premium services: AutoAid pays the technician a fixed amount for each one the customer has confirmed
    const perkDue = (await rows(supabase.from('service_requests').select('id, technician_id, platform_pay, platform_pay_settled_at, premium_perk, stage').eq('stage', 'closed'))).filter(r => r.premium_perk && Number(r.platform_pay) > 0 && !r.platform_pay_settled_at && r.technician_id);
    const users = await usersById([...all.map(r => r.technician_id), ...perkDue.map(r => r.technician_id)]);
    const vehicles = await vehiclesById(all.map(r => r.vehicle_id));
    const custUsers = await usersById([...all.map(r => r.customer_id), ...[...vehicles.values()].map(v => v.user_id)]);
    const payoutsMap = new Map();
    for (const r of all.filter(r => r.stage === 'closed' && r.payout_amount != null && !r.payout_settled_at)) {
      const t = users.get(r.technician_id);
      const p = payoutsMap.get(r.technician_id) || { technicianId: r.technician_id, name: t ? t.name : 'Removed technician', phone: t ? t.phone || '' : '', amount: 0, jobs: 0 };
      p.amount = money(p.amount + Number(r.payout_amount)); p.jobs++; payoutsMap.set(r.technician_id, p);
    }
    for (const r of perkDue) {
      const t = users.get(r.technician_id);
      const p = payoutsMap.get(r.technician_id) || { technicianId: r.technician_id, name: t ? t.name : 'Removed technician', phone: t ? t.phone || '' : '', amount: 0, jobs: 0 };
      p.amount = money(p.amount + Number(r.platform_pay)); p.jobs++; p.premiumJobs = (p.premiumJobs || 0) + 1; payoutsMap.set(r.technician_id, p);
    }
    const details = new Map((await rows(supabase.from('users').select('id, payout_details').in('id', [...payoutsMap.keys()].concat(0)))).map(u => [u.id, u.payout_details || '']));
    const who = r => { const v = vehicles.get(r.vehicle_id); const c = custUsers.get(r.customer_id) || (v ? custUsers.get(v.user_id) : null); return { name: c ? c.name : (v ? v.owner : ''), phone: c ? c.phone || '' : '' }; };
    res.json({
      payouts: [...payoutsMap.values()].map(p => ({ ...p, payoutDetails: details.get(p.technicianId) || '' })),
      refunds: all.filter(r => r.refund_status === 'due').map(r => ({ id: r.id, amount: Number(r.paid_amount), transactionId: r.transaction_id, note: r.refund_note || '', customer: who(r), stage: r.stage })),
      disputes: all.filter(r => r.disputed_at && r.stage === 'done_pending').map(r => ({ id: r.id, amount: Number(r.paid_amount), note: r.dispute_note || '', customer: who(r), technician: users.get(r.technician_id) ? users.get(r.technician_id).name : '', category: r.category }))
    });
  }));
  router.post('/jobs/technicians/:id(\\d+)/payout-paid', adminOnly, handle(async (req, res) => {
    const perkIds = (await rows(supabase.from('service_requests').select('id, premium_perk, platform_pay, platform_pay_settled_at').eq('technician_id', Number(req.params.id)).eq('stage', 'closed'))).filter(r => r.premium_perk && Number(r.platform_pay) > 0 && !r.platform_pay_settled_at).map(r => r.id);
    if (perkIds.length) await supabase.from('service_requests').update({ platform_pay_settled_at: new Date().toISOString() }).in('id', perkIds);
    const { data, error } = await supabase.from('service_requests').update({ payout_settled_at: new Date().toISOString() }).eq('technician_id', Number(req.params.id)).eq('stage', 'closed').eq('pay_mode', 'platform').is('payout_settled_at', null).select();
    if (error) throw error;
    res.json({ paid: data.length + perkIds.length });
  }));
  router.post('/jobs/:id(\\d+)/refund-done', adminOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('service_requests').update({ refund_status: 'done' }).eq('id', Number(req.params.id)).eq('refund_status', 'due').select();
    if (error) throw error;
    res.json({ refunded: data.length });
  }));
  router.post('/jobs/:id(\\d+)/resolve', adminOnly, handle(async (req, res) => {
    const row = (await rows(supabase.from('service_requests').select('*').eq('id', Number(req.params.id))))[0];
    if (!row || row.stage !== 'done_pending' || !row.disputed_at) return res.status(409).json({ error: 'There is no open complaint on this job.' });
    if (req.body && req.body.action === 'refund') { await cancelWithRefund(row, 'After looking into the complaint, AutoAid 24/7 cancelled this job.', 'Complaint upheld'); return res.json({ ok: true }); }
    await closeJob(row, 'After looking into the complaint, AutoAid 24/7 closed this job and released the payment to the technician.');
    res.json({ ok: true });
  }));

  return { router, feePercent, ACTIVE, STATUS_OF, onlinePayment };
};
