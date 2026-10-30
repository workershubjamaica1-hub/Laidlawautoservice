// bankRoutes.js — paying for Premium by bank transfer (used while online card payment is not switched on, and always available as an option).
//
// How it works:
//   1. The customer taps "Join Premium by bank transfer" for a vehicle. The app shows the bank details the admin set, the exact amount,
//      and a reference to put on the transfer (for example AA-12-K7Q).  POST /premium/bank-request
//   2. They make the transfer and can add a photo of the receipt.                        POST /premium/bank-request/:id/proof
//   3. The admin sees it under "Payments to confirm" on the Overview, checks the money arrived, and presses Confirm.
//      The vehicle's Premium starts for a year and the customer is told.                 POST /admin/bank-payments/:id/confirm
//   The admin can also reject a request (with a reason), and a customer can cancel one that is still waiting.
// The bank details come from the admin page (Users > Settings) or, if none were saved there, the BANK_DETAILS setting in Render.
const express = require('express');
const mailer = require('./mailer');
const { premium, premiumPlanFor, premiumStatusOf, tierOfCategory } = require('./subscriptionConfig');

const MAX_PENDING_PER_CUSTOMER = 5;
const money = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });
const bigJson = express.json({ limit: '6mb' });

module.exports = function bankRoutes({ supabase, handle, auth, push, subs }) {
  const router = express.Router();
  const customerOnly = auth.requireRole('customer');
  const adminOnly = auth.requireRole('admin');

  async function getDetails() {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'bank_details').maybeSingle();
    const saved = data && data.value && typeof data.value.text === 'string' ? data.value.text.trim() : '';
    return saved || String(process.env.BANK_DETAILS || '').trim();
  }
  async function alertAdmins(subject, text) {
    try {
      const { data } = await supabase.from('users').select('id, name, email').eq('role', 'admin').eq('active', true);
      if (!data || !data.length) return;
      if (push) { await push.notify(data.map(a => a.id), { title: subject, body: text.slice(0, 140), url: '/admin.html', tag: 'bank-payment', urgent: false }).catch(() => {}); await push.email(data, subject, text).catch(() => {}); }
      else if (mailer.ready()) for (const a of data) if (a.email) mailer.sendMail({ to: a.email, subject, text }).catch(() => {});
    } catch (e) { console.error('Could not alert the admin about a bank payment:', e.message); }
  }
  async function tellCustomer(userId, subject, text) {
    try {
      const { data } = await supabase.from('users').select('id, name, email').eq('id', userId).maybeSingle();
      if (!data) return;
      if (push) { await push.notify([data.id], { title: subject, body: text.slice(0, 140), url: '/app.html#premium', tag: 'bank-payment-result', urgent: false }).catch(() => {}); await push.email([data], subject, text).catch(() => {}); }
      else if (mailer.ready() && data.email) mailer.sendMail({ to: data.email, subject, text }).catch(() => {});
    } catch (e) { console.error('Could not tell the customer about their payment:', e.message); }
  }
  const vehicleName = v => v.year + ' ' + v.type;
  const shape = r => ({ id: r.id, vehicleId: r.vehicle_id, amount: Number(r.amount), reference: r.reference, status: r.status, note: r.customer_note || '', hasProof: !!r.proof_path, decisionNote: r.decision_note || '', createdAt: r.created_at });
  const ref = vehicleId => 'AA-' + vehicleId + '-' + Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[^A-Z0-9]/g, 'X');

  // ---------- customer ----------
  router.get('/premium/bank', customerOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('bank_payments').select('*').eq('user_id', req.user.id).eq('kind', 'premium').order('id', { ascending: false });
    if (error) throw error;
    res.json({ details: await getDetails(), requests: data.filter(r => r.status === 'pending' || r.status === 'rejected').slice(0, 20).map(shape) });
  }));

  router.post('/premium/bank-request', customerOnly, handle(async (req, res) => {
    if (!premium.enabled) return res.status(400).json({ error: 'Premium is not available yet.' });
    const details = await getDetails();
    if (!details) return res.status(503).json({ error: 'Bank transfer details are not set up yet. Please contact AutoAid 24/7 to join.' });
    const v = await supabase.from('vehicles').select('*').eq('id', Number(req.body && req.body.vehicleId)).eq('user_id', req.user.id).maybeSingle();
    if (v.error) throw v.error;
    if (!v.data) return res.status(400).json({ error: 'Choose one of your vehicles.' });
    const plan = premiumPlanFor(v.data);
    if (!plan) return res.status(400).json({ error: 'Premium is not offered for this type of vehicle yet.' });
    const mine = await supabase.from('bank_payments').select('*').eq('user_id', req.user.id).eq('status', 'pending');
    if (mine.error) throw mine.error;
    const existing = mine.data.find(r => r.vehicle_id === v.data.id);
    if (existing) return res.json({ ...shape(existing), details, existing: true });   // one waiting request for each vehicle
    if (mine.data.length >= MAX_PENDING_PER_CUSTOMER) return res.status(429).json({ error: 'You already have several payments waiting to be confirmed.' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      const ins = await supabase.from('bank_payments').insert({ user_id: req.user.id, vehicle_id: v.data.id, kind: 'premium', amount: plan.price, reference: ref(v.data.id), customer_note: note || null, status: 'pending' }).select().single();
      if (!ins.error) row = ins.data; else if (ins.error.code !== '23505') throw ins.error;   // 23505: that reference was taken, try another
    }
    if (!row) return res.status(500).json({ error: 'Could not make a payment reference. Try again.' });
    alertAdmins('Premium payment coming by bank transfer', req.user.name + ' wants to join Premium for their ' + vehicleName(v.data) + ' (' + money(plan.price) + ', reference ' + row.reference + '). Check your bank account for the transfer, then confirm it on the Overview.');
    res.status(201).json({ ...shape(row), details });
  }));

  async function ownRequest(req, res) {
    const { data, error } = await supabase.from('bank_payments').select('*').eq('id', Number(req.params.id)).eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Payment not found.' }); return null; }
    return data;
  }
  router.post('/premium/bank-request/:id(\\d+)/proof', customerOnly, bigJson, handle(async (req, res) => {
    const row = await ownRequest(req, res); if (!row) return;
    if (row.status !== 'pending') return res.status(409).json({ error: 'This payment is no longer waiting.' });
    const img = auth.readImage(req.body);
    if (img.error) return res.status(img.status).json({ error: img.error });
    const path = 'bank/proof-' + row.id + '-' + Date.now();
    await auth.storePhoto(path, img.buf, img.type);
    const { error } = await supabase.from('bank_payments').update({ proof_path: path }).eq('id', row.id);
    if (error) throw error;
    alertAdmins('Receipt added for a Premium payment', req.user.name + ' added a photo of their bank receipt for reference ' + row.reference + ' (' + money(row.amount) + '). Confirm it on the Overview once the money is in your account.');
    res.json({ ok: true });
  }));
  router.post('/premium/bank-request/:id(\\d+)/cancel', customerOnly, handle(async (req, res) => {
    const row = await ownRequest(req, res); if (!row) return;
    if (row.status !== 'pending') return res.status(409).json({ error: 'This payment is no longer waiting.' });
    const { error } = await supabase.from('bank_payments').update({ status: 'cancelled', decided_at: new Date().toISOString() }).eq('id', row.id);
    if (error) throw error;
    res.json({ ok: true });
  }));

  // ---------- admin ----------
  router.get('/admin/bank-details', adminOnly, handle(async (req, res) => res.json({ text: await getDetails() })));
  router.put('/admin/bank-details', adminOnly, handle(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (text.length > 800) return res.status(400).json({ error: 'Keep the bank details under 800 characters.' });
    const had = await supabase.from('app_settings').select('key').eq('key', 'bank_details').maybeSingle();
    const w = had.data ? await supabase.from('app_settings').update({ value: { text }, updated_at: new Date().toISOString() }).eq('key', 'bank_details') : await supabase.from('app_settings').insert({ key: 'bank_details', value: { text } });
    if (w.error) throw w.error;
    res.json({ text });
  }));

  router.get('/admin/bank-payments', adminOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('bank_payments').select('*').order('id', { ascending: false });
    if (error) throw error;
    const list = data.filter(r => r.status === 'pending' || (req.query.all === '1' && r.status !== 'cancelled')).slice(0, 100);
    const users = new Map(((await supabase.from('users').select('id, name, email, phone').in('id', [...new Set(list.map(r => r.user_id))].concat(0))).data || []).map(u => [u.id, u]));
    const vehicles = new Map(((await supabase.from('vehicles').select('id, year, type, category').in('id', [...new Set(list.map(r => r.vehicle_id))].concat(0))).data || []).map(v => [v.id, v]));
    const out = [];
    for (const r of list) {
      const u = users.get(r.user_id), v = vehicles.get(r.vehicle_id);
      let proofUrl = null; try { proofUrl = r.proof_path ? await auth.signedPhotoUrl(r.proof_path) : null; } catch (_) {}
      out.push({ ...shape(r), proofUrl, customer: u ? { name: u.name, email: u.email, phone: u.phone || '' } : { name: 'Removed customer', email: '', phone: '' },
        vehicle: v ? { name: vehicleName(v), tier: (tierOfCategory(v.category) || {}).label || '' } : null, decidedAt: r.decided_at || null });
    }
    res.json({ payments: out, pending: data.filter(r => r.status === 'pending').length });
  }));

  async function decide(req, res, status) {
    const id = Number(req.params.id);
    const { data: row, error } = await supabase.from('bank_payments').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Payment not found.' });
    if (row.status !== 'pending') return res.status(409).json({ error: 'This payment was already ' + row.status + '.' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    if (status === 'rejected' && note.length < 3) return res.status(400).json({ error: 'Say why (a few words), so the customer knows what to do.' });
    if (status === 'confirmed') {
      const out = await subs.creditVehicle({ vehicleId: row.vehicle_id, userId: row.user_id, provider: 'bank', transactionId: 'bank-' + row.id, amount: Number(row.amount), currency: subs.config.currency, days: 365 });
      if (!out.ok) return res.status(409).json({ error: 'That vehicle is no longer on the customer\'s account, so Premium cannot be started.' });
    }
    const { error: e2 } = await supabase.from('bank_payments').update({ status, decision_note: note || null, decided_at: new Date().toISOString() }).eq('id', id);
    if (e2) throw e2;
    const { data: veh } = await supabase.from('vehicles').select('*').eq('id', row.vehicle_id).maybeSingle();
    const name = veh ? vehicleName(veh) : 'your vehicle';
    if (status === 'confirmed') {
      const st = veh ? premiumStatusOf(veh) : {};
      tellCustomer(row.user_id, 'Your Premium is active', 'We received your payment of ' + money(row.amount) + '. Premium for your ' + name + ' is active' + (st.paidUntil ? ' until ' + new Date(st.paidUntil).toLocaleDateString('en-JM', { day: 'numeric', month: 'short', year: 'numeric' }) : '') + '. Open AutoAid 24/7 to book your free services.');
    } else {
      tellCustomer(row.user_id, 'We could not confirm your Premium payment', 'We could not confirm your payment of ' + money(row.amount) + ' (reference ' + row.reference + ') for ' + name + '. Reason: ' + note + ' You can try again in the app, or contact AutoAid 24/7.');
    }
    res.json({ ok: true });
  }
  router.post('/admin/bank-payments/:id(\\d+)/confirm', adminOnly, handle((req, res) => decide(req, res, 'confirmed')));
  router.post('/admin/bank-payments/:id(\\d+)/reject', adminOnly, handle((req, res) => decide(req, res, 'rejected')));

  return { router, getDetails };
};
