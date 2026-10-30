// adminRoutes.js — the staff/admin portal API, mounted at /admin.
// Staff and admins can view everything and change request status. Only admins can delete records or manage users.
const express = require('express');
const { premium, premiumTiers, premiumStatusOf } = require('./subscriptionConfig');

module.exports = function adminRoutes({ supabase, handle, auth, subs, toVehicle, toRequest, STATUSES }) {
  const router = express.Router();
  const staffUp = auth.requireWorker;   // staff and admin; a provider with a lapsed subscription is stopped (402)
  const adminOnly = auth.requireRole('admin');

  // --- How the business is doing (admin only) ---
  router.get('/business-stats', adminOnly, handle(async (req, res) => {
    const [jr, ur] = await Promise.all([
      supabase.from('service_requests').select('stage, urgent, created_at, accepted_at, completed_at, fee_amount, refund_status, disputed_at, technician_id, pay_status, paid_amount'),
      supabase.from('users').select('id, role, approved, active, created_at, online, online_at, pro_verified, deleted_at')
    ]);
    if (jr.error) throw jr.error; if (ur.error) throw ur.error;
    const jobs = jr.data, users = ur.data.filter(u => !u.deleted_at);
    const now = Date.now(), DAY = 86400000, startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const ts = v => (v ? Date.parse(v) : 0);
    const recent = jobs.filter(j => now - ts(j.created_at) < 30 * DAY);
    const waits = recent.filter(j => j.accepted_at).map(j => (ts(j.accepted_at) - ts(j.created_at)) / 60000).filter(m => m >= 0);
    const techs = users.filter(u => u.role === 'staff');
    const sum = a => Math.round(a.reduce((s, n) => s + Number(n || 0), 0) * 100) / 100;
    res.json({
      jobsToday: jobs.filter(j => ts(j.created_at) >= startOfDay.getTime()).length,
      waitingNow: jobs.filter(j => j.stage === 'searching').length,
      emergenciesWaiting: jobs.filter(j => j.stage === 'searching' && j.urgent).length,
      activeNow: jobs.filter(j => ['matched', 'quoted', 'agreed', 'working', 'done_pending'].includes(j.stage)).length,
      completedThisMonth: jobs.filter(j => j.stage === 'closed' && ts(j.completed_at) >= monthStart.getTime()).length,
      feesThisMonth: sum(jobs.filter(j => j.stage === 'closed' && ts(j.completed_at) >= monthStart.getTime()).map(j => j.fee_amount)),
      averageMinutesToAccept: waits.length ? Math.round(waits.reduce((s, m) => s + m, 0) / waits.length * 10) / 10 : null,
      unansweredLast30Days: recent.filter(j => j.stage === 'cancelled' && !j.technician_id).length,
      jobsLast30Days: recent.length,
      complaintsOpen: jobs.filter(j => j.disputed_at && j.stage === 'done_pending').length,
      refundsDue: jobs.filter(j => j.refund_status === 'due').length,
      techniciansOnline: techs.filter(t => t.online && t.online_at && now - ts(t.online_at) < 150000).length,
      techniciansTotal: techs.filter(t => t.approved !== false && t.active !== false).length,
      bankPending: (await supabase.from('bank_payments').select('id, status').eq('status', 'pending')).data.length,
      techniciansNotIdChecked: techs.filter(t => t.approved !== false && t.active !== false && !t.pro_verified).length,
      customersTotal: users.filter(u => u.role === 'customer').length,
      newCustomersThisWeek: users.filter(u => u.role === 'customer' && now - ts(u.created_at) < 7 * DAY).length
    });
  }));

  // --- Dashboard ---
  // Everything the dashboard needs in one call: all requests joined with their vehicles, plus counts
  router.get('/overview', staffUp, handle(async (req, res) => {
    const [v, r, u] = await Promise.all([
      supabase.from('vehicles').select('*').order('id'),
      supabase.from('service_requests').select('*').order('id', { ascending: false }),
      supabase.from('users').select('id, name, email, phone, address, parish')
    ]);
    for (const x of [v, r, u]) if (x.error) throw x.error;
    const accounts = new Map(u.data.map(x => [x.id, x]));
    const vehicles = v.data.map(row => {
      const acct = accounts.get(row.user_id);
      return { ...toVehicle(row), account: acct ? { id: acct.id, name: acct.name, email: acct.email, phone: acct.phone || '', address: acct.address || '', parish: acct.parish || '' } : null };
    });
    const byId = new Map(vehicles.map(x => [x.id, x]));
    const requests = r.data.map(toRequest).map(x => ({ ...x, vehicle: byId.get(x.vehicleId) || null, technicianName: (accounts.get(x.technicianId) || {}).name || null }));
    const counts = Object.fromEntries(STATUSES.map(s => [s, requests.filter(x => x.status === s).length]));
    const owners = new Set(vehicles.map(x => x.owner.trim().toLowerCase())).size;
    res.json({ counts, totals: { vehicles: vehicles.length, requests: requests.length, owners }, vehicles, requests });
  }));

  // --- Service requests ---
  // A technician can take an unassigned job ("claim") and then update it. Once a job has a technician, only
  // that technician (or an admin) can change it, so earnings and ratings go to the right person.
  router.post('/service-request/:id/claim', staffUp, handle(async (req, res) => {
    if (req.user.role === 'staff') return res.status(403).json({ error: 'Jobs are taken from the Jobs tab now. Go online to see new jobs and accept one.' });
    const id = Number(req.params.id);
    const cur = await supabase.from('service_requests').select('*').eq('id', id).maybeSingle();
    if (cur.error) throw cur.error;
    if (!cur.data) return res.status(404).json({ error: 'Request not found.' });
    if (cur.data.technician_id) return res.status(409).json({ error: cur.data.technician_id === req.user.id ? 'You already have this job.' : 'Another technician already took this job.' });
    if (cur.data.status === 'completed' || cur.data.status === 'cancelled') return res.status(409).json({ error: 'This job is already finished.' });
    const { data, error } = await supabase.from('service_requests')
      .update({ technician_id: req.user.id, status: 'in-progress', stage: 'working' }).eq('id', id).is('technician_id', null).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Another technician just took this job.' });
    res.json(toRequest(data));
  }));

  router.patch('/service-request/:id', staffUp, handle(async (req, res) => {
    if (req.user.role === 'staff') return res.status(403).json({ error: 'Jobs are run from the Jobs tab now: send your price, then mark arrived and done there.' });
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}.` });
    const id = Number(req.params.id);
    const cur = await supabase.from('service_requests').select('*').eq('id', id).maybeSingle();
    if (cur.error) throw cur.error;
    if (!cur.data) return res.status(404).json({ error: 'Request not found.' });
    const row = cur.data, isAdmin = req.user.role === 'admin';
    if (!isAdmin && row.technician_id && row.technician_id !== req.user.id) {
      return res.status(403).json({ error: 'This job belongs to another technician.' });
    }
    const amount = auth.parseAmount(req.body.amount);
    if (amount.error) return res.status(400).json({ error: amount.error });
    const update = { status, stage: { 'pending': row.technician_id ? 'matched' : 'searching', 'in-progress': 'working', 'completed': 'closed', 'cancelled': 'cancelled' }[status] };
    // moving an unassigned job forward takes it
    if (!isAdmin && !row.technician_id && (status === 'in-progress' || status === 'completed')) update.technician_id = req.user.id;
    if (status === 'completed') {
      update.completed_at = row.completed_at || new Date().toISOString();
      if (amount.value !== null) update.amount = amount.value; // JMD charged to the customer
    } else {
      update.completed_at = null;
    }
    const { data, error } = await supabase.from('service_requests').update(update).eq('id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Request not found.' });
    res.json(toRequest(data));
  }));

  // --- Proof of work: the technician who did a finished job (or an admin) can attach or remove a photo of it ---
  const JOB_TABLES = { service: { table: 'service_requests', done: 'completed' }, emergency: { table: 'emergency_requests', done: 'resolved' } };
  const bigJson = express.json({ limit: '6mb' });
  async function loadJob(req, res) {
    const def = JOB_TABLES[req.params.kind];
    if (!def) { res.status(404).json({ error: 'Unknown job type.' }); return null; }
    const cur = await supabase.from(def.table).select('*').eq('id', Number(req.params.id)).maybeSingle();
    if (cur.error) throw cur.error;
    if (!cur.data) { res.status(404).json({ error: 'Job not found.' }); return null; }
    if (req.user.role !== 'admin' && cur.data.technician_id !== req.user.id) { res.status(403).json({ error: 'You can only add photos to jobs you did.' }); return null; }
    return { def, row: cur.data };
  }
  router.post('/jobs/:kind/:id/photo', staffUp, bigJson, handle(async (req, res) => {
    const job = await loadJob(req, res);
    if (!job) return;
    if (job.row.status !== job.def.done) return res.status(400).json({ error: 'Add the photo once the job is finished.' });
    const img = auth.readImage(req.body);
    if (img.error) return res.status(img.status).json({ error: img.error });
    const path = `jobs/${req.params.kind}-${job.row.id}`;
    await auth.storePhoto(path, img.buf, img.type);
    const { error } = await supabase.from(job.def.table).update({ work_photo_path: path, work_photo_at: new Date().toISOString() }).eq('id', job.row.id);
    if (error) throw error;
    res.json({ ok: true });
  }));
  router.delete('/jobs/:kind/:id/photo', staffUp, handle(async (req, res) => {
    const job = await loadJob(req, res);
    if (!job) return;
    await auth.removePhoto(job.row.work_photo_path).catch(err => console.error('Could not remove photo:', err.message));
    const { error } = await supabase.from(job.def.table).update({ work_photo_path: null, work_photo_at: null }).eq('id', job.row.id);
    if (error) throw error;
    res.json({ ok: true });
  }));

  // --- Technician dashboard: jobs, earnings (JMD), ratings. Admins can view anyone with ?technicianId= ---
  router.get('/dashboard', staffUp, handle(async (req, res) => {
    const techId = req.user.role === 'admin' && req.query.technicianId ? Number(req.query.technicianId) : req.user.id;
    const [sr, em, tu] = await Promise.all([
      supabase.from('service_requests').select('*').eq('technician_id', techId),
      supabase.from('emergency_requests').select('*').eq('technician_id', techId),
      supabase.from('users').select('*').eq('id', techId).maybeSingle()
    ]);
    for (const x of [sr, em, tu]) if (x.error) throw x.error;
    if (!tu.data) return res.status(404).json({ error: 'Technician not found.' });

    const label = { diagnostics: 'Diagnostics', mechanical: 'Mechanical', tire: 'Tire', electrical: 'Electrical', maintenance: 'Maintenance', bodywork: 'Auto body repairs', other: 'Other' };
    const jobs = [
      ...sr.data.map(r => ({ id: r.id, jobType: 'service', photoPath: r.work_photo_path, kind: 'service', title: label[r.category] || r.category, done: r.status === 'completed', active: r.status === 'in-progress',
        when: r.completed_at || r.updated_at || r.created_at, amount: Number(r.amount || 0) + Number(r.platform_pay || 0), rating: r.rating, review: r.review })),
      ...em.data.map(r => ({ id: r.id, jobType: 'emergency', photoPath: r.work_photo_path, kind: r.kind, title: r.kind === 'towing' ? 'Wrecker / towing' : 'Roadside assistance', done: r.status === 'resolved', active: r.status === 'dispatched',
        when: r.completed_at || r.updated_at || r.created_at, amount: Number(r.amount || 0), rating: r.rating, review: r.review }))
    ];
    const done = jobs.filter(j => j.done).sort((x, y) => new Date(y.when) - new Date(x.when));
    const monthKey = d => new Date(d).toISOString().slice(0, 7);
    const thisMonth = monthKey(Date.now());
    const sum = list => Math.round(list.reduce((t, j) => t + j.amount, 0) * 100) / 100;

    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = d.toISOString().slice(0, 7);
      const inMonth = done.filter(j => monthKey(j.when) === key);
      months.push({ month: key, label: d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }), earned: sum(inMonth), jobs: inMonth.length });
    }

    const rated = done.filter(j => j.rating);
    const breakdown = [1, 2, 3, 4, 5].map(n => rated.filter(j => j.rating === n).length);
    const avatarUrl = await auth.signedPhotoUrl(tu.data.avatar_path).catch(() => null);
    // the 20 latest finished jobs, with a short-lived link to the technician's photo of the work (if any)
    const recent = await Promise.all(done.slice(0, 20).map(async j => ({
      id: j.id, jobType: j.jobType, title: j.title, kind: j.kind, when: j.when, amount: j.amount, rating: j.rating,
      photoUrl: j.photoPath ? await auth.signedPhotoUrl(j.photoPath).catch(() => null) : null
    })));
    res.json({
      technician: { name: tu.data.name, parish: tu.data.parish || '', specialties: tu.data.specialties ? tu.data.specialties.split(',') : [], avatarUrl },
      totals: {
        completed: done.length, inProgress: jobs.filter(j => j.active).length,
        earnedTotal: sum(done), earnedThisMonth: sum(done.filter(j => monthKey(j.when) === thisMonth)),
        completedThisMonth: done.filter(j => monthKey(j.when) === thisMonth).length
      },
      rating: { average: rated.length ? Math.round(rated.reduce((t, j) => t + j.rating, 0) / rated.length * 10) / 10 : null, count: rated.length, breakdown },
      months,
      reviews: rated.filter(j => j.review).slice(0, 5).map(j => ({ rating: j.rating, review: j.review, title: j.title, when: j.when })),
      recent, gallery: recent.filter(j => j.photoUrl)
    });
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

  // One person's whole profile for the admin: contact details, photos, vehicles and, for a service provider, who they are
  router.get('/users/:id/profile', adminOnly, handle(async (req, res) => {
    const { data: u, error } = await supabase.from('users').select('*').eq('id', Number(req.params.id)).maybeSingle();
    if (error) throw error;
    if (!u) return res.status(404).json({ error: 'User not found.' });
    const link = async p => { try { return await auth.signedPhotoUrl(p); } catch (_) { return null; } };
    const { data: cars } = await supabase.from('vehicles').select('*').eq('user_id', u.id).order('id');
    res.json({
      user: auth.publicUser(u), joined: u.created_at, online: !!u.online,
      photos: { vehicle: await link(u.chassis_photo_path), face: await link(u.avatar_path), selfie1: await link(u.selfie_path), selfie2: await link(u.selfie2_path), licence: await link(u.licence_photo_path) },
      vehicles: (cars || []).map(v => ({ id: v.id, type: v.type, category: v.category, year: v.year, chassis: v.vin || '', colour: v.colour || '', plate: v.plate || '', about: v.about || '' }))
    });
  }));
  // The admin looks at the two live photos and decides whether a real person stands behind the account
  router.post('/users/:id/identity', adminOnly, handle(async (req, res) => {
    const decision = req.body && req.body.decision, note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ error: 'Choose approve or reject.' });
    if (decision === 'reject' && !note) return res.status(400).json({ error: 'Say why, so they know what to fix.' });
    const { data: u } = await supabase.from('users').select('id, provider_type, selfie_path').eq('id', Number(req.params.id)).maybeSingle();
    if (!u || u.provider_type !== 'sole' || !u.selfie_path) return res.status(404).json({ error: 'This person has no face check to decide on.' });
    const { error } = await supabase.from('users').update({ identity_status: decision === 'approve' ? 'approved' : 'rejected', identity_note: decision === 'reject' ? note : null, identity_at: new Date().toISOString(), ...(decision === 'reject' ? { online: false } : {}) }).eq('id', u.id);
    if (error) throw error;
    res.json({ ok: true });
  }));

  router.get('/users/:id/chassis-photo', staffUp, handle(async (req, res) => {
    const { data, error } = await supabase.from('users').select('chassis_photo_path').eq('id', Number(req.params.id)).maybeSingle();
    if (error) throw error;
    const url = data && await auth.signedPhotoUrl(data.chassis_photo_path);
    if (!url) return res.status(404).json({ error: 'This customer has not uploaded a vehicle photo.' });
    res.json({ url });
  }));

  // --- Subscriptions (admin only) ---
  router.get('/subscription-info', adminOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('users').select('id, approved, subscription_paid_until').eq('role', 'staff');
    if (error) throw error;
    const members = await supabase.from('vehicles').select('id, premium_paid_until, premium_year_start');
    if (members.error) throw members.error;
    const proto = req.get('x-forwarded-proto') || req.protocol;
    res.json({
      premium: {
        enabled: premium.enabled, servicesPerYear: premium.servicesPerYear, gapDays: premium.gapDays,
        tiers: premiumTiers().map(t => ({ id: t.id, label: t.label, price: t.price, priceLabel: t.priceLabel, pay: t.pay })),
        activeMembers: members.data.filter(v => premiumStatusOf(v).status === 'active').length
      },
      enabled: subs.config.enabled, price: subs.config.price, currency: subs.config.currency, days: subs.config.days, graceDays: subs.config.graceDays,
      gatewayConfigured: subs.gatewayReady(), webhookUrl: proto + '://' + req.get('host') + '/webhooks/fygaro',
      providersNeverPaid: data.filter(u => u.approved !== false && !u.subscription_paid_until).length
    });
  }));

  // Add access days to one provider (cash, bank transfer, a free month, or a fix if the gateway hiccups). Recorded as a manual payment.
  router.post('/users/:id/subscription', adminOnly, handle(async (req, res) => {
    const days = Number(req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 366) return res.status(400).json({ error: 'Enter a number of days between 1 and 366.' });
    const out = await subs.credit({ userId: Number(req.params.id), provider: 'manual', days });
    if (!out.ok) return res.status(404).json({ error: 'Service provider not found.' });
    const { data, error } = await supabase.from('users').select('*').eq('id', Number(req.params.id)).single();
    if (error) throw error;
    res.json(auth.publicUser(data));
  }));

  // Give a vehicle Premium days by hand (cash, a gift, or a fix if a payment did not arrive). Recorded as a manual payment.
  router.post('/vehicles/:id/premium', adminOnly, handle(async (req, res) => {
    if (!premium.enabled) return res.status(400).json({ error: 'Premium is not switched on.' });
    const days = Number(req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 732) return res.status(400).json({ error: 'Enter a number of days between 1 and 732.' });
    const out = await subs.creditVehicle({ vehicleId: Number(req.params.id), provider: 'manual', days });
    if (!out.ok) return res.status(404).json({ error: 'Vehicle not found.' });
    const { data, error } = await supabase.from('vehicles').select('*').eq('id', Number(req.params.id)).single();
    if (error) throw error;
    res.json(toVehicle(data));
  }));

  // Switching subscriptions on would lock out technicians who joined before it existed. This gives all of them free days at once.
  router.post('/subscriptions/grandfather', adminOnly, handle(async (req, res) => {
    const days = Number(req.body.days || 30);
    if (!Number.isInteger(days) || days < 1 || days > 366) return res.status(400).json({ error: 'Enter a number of days between 1 and 366.' });
    const { data, error } = await supabase.from('users').select('id, approved, subscription_paid_until').eq('role', 'staff');
    if (error) throw error;
    const targets = data.filter(u => u.approved !== false && !u.subscription_paid_until);
    for (const u of targets) await subs.credit({ userId: u.id, provider: 'manual', days });
    res.json({ count: targets.length, days });
  }));

  router.get('/subscription-payments', adminOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('subscription_payments').select('*').order('id', { ascending: false });
    if (error) throw error;
    const rows = data.slice(0, 50);
    const ids = [...new Set(rows.map(r => r.user_id))];
    const u = ids.length ? await supabase.from('users').select('id, name').in('id', ids) : { data: [] };
    if (u.error) throw u.error;
    const names = new Map(u.data.map(x => [x.id, x.name]));
    res.json(rows.map(r => ({ id: r.id, name: names.get(r.user_id) || 'Deleted user', provider: r.provider, kind: r.kind || 'provider', plan: r.plan || null, amount: r.amount == null ? null : Number(r.amount),
      currency: r.currency, periodEnd: r.period_end, createdAt: r.created_at })));
  }));

  // If the email service is down, or someone cannot get their code, an admin can mark an email as verified by hand.
  router.post('/users/:id/verify', adminOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('users')
      .update({ email_verified: true, verify_code_hash: null, verify_expires_at: null, verify_attempts: 0 }).eq('id', Number(req.params.id)).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found.' });
    res.json(auth.publicUser(data));
  }));

  // --- Users (admin only) ---
  // Sends one test email and shows exactly what the email service answered, so a wrong key or sender is easy to find.
  const mailer = require('./mailer');
  async function recentFailures() {
    const { data } = await supabase.from('email_failures').select('at, to_domain, subject, error').order('id', { ascending: false });
    return (data || []).slice(0, 5);
  }
  router.get('/email-failures', adminOnly, handle(async (req, res) => res.json({ settings: mailer.describe(), recent: await recentFailures() })));
  router.post('/email-test', adminOnly, handle(async (req, res) => {
    const to = String((req.body && req.body.to) || req.user.email || '').trim();
    if (!auth.validEmail(to)) return res.status(400).json({ error: 'Enter a valid email address to send the test to.' });
    const settings = mailer.describe();
    if (!settings.ready) return res.json({ ok: false, settings, error: 'Email is not fully set up. One of EMAIL_PROVIDER, EMAIL_API_KEY or EMAIL_FROM is missing in Render.' });
    try {
      await mailer.sendMail({ to, subject: 'AutoAid 24/7 test email', text: 'This is a test email from your AutoAid 24/7 admin page. If you can read this, sending works.' });
      res.json({ ok: true, settings, to });
    } catch (err) {
      res.json({ ok: false, settings, error: err.message, recent: await recentFailures() });
    }
  }));

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
    const contact = auth.checkContact({ phone: req.body.phone || undefined, address: req.body.address || undefined, parish: req.body.parish || undefined }, false);
    if (contact.error) return res.status(400).json({ error: contact.error });
    if (await auth.findByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });
    res.status(201).json(auth.publicUser(await auth.createUser({ name, email, password, role, proVerified: role === 'staff', ...contact.value })));
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
    if (req.body.proVerified !== undefined) update.pro_verified = !!req.body.proVerified;   // the shop has checked this technician's ID
    if (req.body.approved !== undefined) update.approved = !!req.body.approved; // approve a service member's application
    if (req.body.password !== undefined) {
      if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      update.password_hash = auth.hashPassword(String(req.body.password));
      update.pw_changed_at = new Date().toISOString();   // signs them out everywhere
    }
    const contact = auth.checkContact(req.body, false);
    if (contact.error) return res.status(400).json({ error: contact.error });
    Object.assign(update, contact.value);
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to change.' });
    if (id === req.user.id && ((update.role && update.role !== 'admin') || update.active === false || update.approved === false)) {
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
    const { data, error } = await supabase.from('users').delete().eq('id', id).select('id, chassis_photo_path');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'User not found.' });
    await auth.removePhoto(data[0].chassis_photo_path).catch(err => console.error('Could not remove photo:', err.message));
    res.json({ deleted: id });
  }));

  return router;
};
