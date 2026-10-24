// subscriptions.js — paid memberships: the provider subscription and Premium customers. Checkout links, the payment
// notification (webhook) and crediting access.
//
// How a payment works (Fygaro):
//   1. The person taps "Pay". We build a Fygaro payment link with a signed JWT (amount, currency and a reference that names
//      who is paying and for what), so the amount cannot be changed.
//   2. They pay on Fygaro's page. Fygaro then POSTs a signed notification to  /webhooks/fygaro.
//   3. We verify the signature (HMAC-SHA256 over "<timestamp>.<raw body>"), check the amount, and extend their access.
// References:  job-<jobId>-<time>             a repair job paid online (handled by jobRoutes.js through registerPaymentHandler)
//              sub-<userId>-<time>            service provider subscription
//              prem-<userId>-<plan>-<time>    Premium customer membership (plan = monthly | yearly)
// Setup steps are in PAYMENTS.md. Fygaro's JWT links and notifications need their Pro plan.
const crypto = require('crypto');
const express = require('express');
const { config, statusOf, priceLabel, DAY, premium, premiumPlans, premiumStatusOf, perkAllowance, PERKS } = require('./subscriptionConfig');

const FYGARO = {
  buttonUrl: process.env.FYGARO_BUTTON_URL || '',
  keyId: process.env.FYGARO_KEY_ID || '',
  secret: process.env.FYGARO_SECRET || '',
  oldSecret: process.env.FYGARO_SECRET_OLD || ''   // keep the previous secret here while rotating keys
};
const gatewayReady = () => !!(FYGARO.buttonUrl && FYGARO.keyId && FYGARO.secret);
const TOLERANCE_S = 300; // reject notifications older than 5 minutes (replay protection)

// --- Fygaro helpers (exported so they can be tested) ---
function signJwt(claims, keyId, secret) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b({ alg: 'HS256', typ: 'JWT', kid: keyId }), body = b(claims);
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const hmacHex = (secret, t, raw) => crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
const safeHexEqual = (a, b) => a.length === b.length && /^[0-9a-f]+$/i.test(a) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

// headers: { 'fygaro-signature': 't=123,v1=abc,v1=def', 'fygaro-key-id': '...' }; raw: Buffer of the untouched body
function verifyFygaroSignature(raw, headers, nowMs = Date.now(), secrets = [FYGARO.secret, FYGARO.oldSecret]) {
  const sig = String(headers['fygaro-signature'] || '');
  const parts = sig.split(',').map(p => p.trim().split('='));
  const t = (parts.find(p => p[0] === 't') || [])[1];
  const v1 = parts.filter(p => p[0] === 'v1').map(p => p[1] || '');
  if (!t || !v1.length || !Buffer.isBuffer(raw)) return false;
  if (!/^\d+$/.test(t) || Math.abs(nowMs / 1000 - Number(t)) > TOLERANCE_S) return false;
  return secrets.filter(Boolean).some(secret => {
    const expected = hmacHex(secret, t, raw);
    return v1.some(v => safeHexEqual(v, expected));
  });
}

// What each kind of membership writes to and who may hold it
const KINDS = {
  provider: { field: 'subscription_paid_until', role: 'staff' },
  premium: { field: 'premium_paid_until', role: 'customer' }
};

module.exports = function createSubscriptions({ supabase, handle, auth }) {
  const router = express.Router();

  const getUser = async id => {
    const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  };

  // Gives someone more access time and records it. Safe to call twice for the same transactionId.
  async function credit({ userId, provider, transactionId = null, amount = null, currency = null, days = config.days, kind = 'provider', plan = null }) {
    const { field, role } = KINDS[kind];
    const user = await getUser(userId);
    if (!user || user.role !== role) return { ok: false, reason: 'wrong-account-type' };
    if (transactionId) {
      const dup = await supabase.from('subscription_payments').select('id, period_end').eq('transaction_id', transactionId).maybeSingle();
      if (dup.error) throw dup.error;
      if (dup.data) {
        // already recorded; make sure the access date really got applied (a previous attempt may have stopped halfway)
        const have = user[field] ? Date.parse(user[field]) : 0;
        if (have < Date.parse(dup.data.period_end)) {
          const fix = await supabase.from('users').update({ [field]: dup.data.period_end }).eq('id', userId);
          if (fix.error) throw fix.error;
        }
        return { ok: true, duplicate: true };
      }
    }
    const now = Date.now();
    const prevEnd = user[field] ? Date.parse(user[field]) : 0;
    const start = Math.max(now, prevEnd);   // paying early adds to the end
    const end = new Date(start + days * DAY).toISOString();
    const ins = await supabase.from('subscription_payments').insert({
      user_id: userId, provider, kind, plan, transaction_id: transactionId, amount, currency,
      period_start: new Date(start).toISOString(), period_end: end
    }).select().single();
    if (ins.error) {
      if (ins.error.code === '23505') return { ok: true, duplicate: true }; // two copies of the same notification arrived together
      throw ins.error;
    }
    const update = { [field]: end };
    // A Premium "membership year" (which the perks are counted in) restarts when a lapsed member comes back
    if (kind === 'premium' && prevEnd < now) update.premium_year_start = new Date(start).toISOString();
    const upd = await supabase.from('users').update(update).eq('id', userId);
    if (upd.error) throw upd.error;
    return { ok: true, paidUntil: end };
  }

  const checkoutUrl = (claims, ttlSeconds = 3600) => {
    const jwt = signJwt({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }, FYGARO.keyId, FYGARO.secret);
    return FYGARO.buttonUrl + (FYGARO.buttonUrl.includes('?') ? '&' : '?') + 'jwt=' + jwt;
  };

  // =============================== Service provider subscription ===============================
  const providerOnly = auth.requireRole('staff');

  router.get('/subscription', providerOnly, (req, res) => {
    const s = statusOf(req.user);
    res.json({
      enabled: config.enabled, ...s, price: config.price, currency: config.currency, priceLabel: priceLabel(),
      days: config.days, graceDays: config.graceDays, canPayOnline: gatewayReady() && config.price > 0
    });
  });

  router.post('/subscription/checkout', providerOnly, handle(async (req, res) => {
    if (!config.enabled) return res.status(400).json({ error: 'Subscriptions are not switched on.' });
    if (!gatewayReady() || !(config.price > 0)) return res.status(503).json({ error: 'Online payment is not set up yet. Please contact AutoAid 24/7 to activate your account.' });
    res.json({ url: checkoutUrl({ amount: config.price.toFixed(2), currency: config.currency, custom_reference: `sub-${req.user.id}-${Date.now()}` }) });
  }));

  // =============================== Premium customers ===============================
  const customerOnly = auth.requireRole('customer');

  // The member's service requests that used a perk, via their vehicles (service requests belong to vehicles)
  async function premiumRows(userId) {
    const v = await supabase.from('vehicles').select('id').eq('user_id', userId);
    if (v.error) throw v.error;
    if (!v.data.length) return [];
    const r = await supabase.from('service_requests').select('id, premium_perk, status, created_at').in('vehicle_id', v.data.map(x => x.id));
    if (r.error) throw r.error;
    return r.data.filter(x => x.premium_perk);
  }

  router.get('/premium', customerOnly, handle(async (req, res) => {
    if (!premium.enabled) return res.json({ enabled: false });
    const st = premiumStatusOf(req.user);
    const perks = st.status === 'active' ? perkAllowance(await premiumRows(req.user.id), st) : null;
    res.json({
      enabled: true, ...st, plans: premiumPlans(), currency: config.currency, canPayOnline: gatewayReady() && premiumPlans().length > 0,
      oilPerYear: premium.oilPerYear, oilGapDays: premium.oilGapDays, perks
    });
  }));

  router.post('/premium/checkout', customerOnly, handle(async (req, res) => {
    if (!premium.enabled) return res.status(400).json({ error: 'Premium is not available yet.' });
    const plan = premiumPlans().find(p => p.id === (req.body && req.body.plan));
    if (!plan) return res.status(400).json({ error: 'Choose a plan.' });
    if (!gatewayReady()) return res.status(503).json({ error: 'Online payment is not set up yet. Please contact AutoAid 24/7.' });
    res.json({ url: checkoutUrl({ amount: plan.price.toFixed(2), currency: config.currency, custom_reference: `prem-${req.user.id}-${plan.id}-${Date.now()}` }) });
  }));

  // Book a free perk: creates a service request that a technician can take. Uses up one perk until it is cancelled.
  router.post('/premium/redeem', customerOnly, handle(async (req, res) => {
    if (!premium.enabled) return res.status(400).json({ error: 'Premium is not available yet.' });
    const st = premiumStatusOf(req.user);
    if (st.status !== 'active') return res.status(403).json({ error: 'Your Premium membership is not active. Join or renew to use free services.' });
    const perk = req.body && req.body.perk;
    if (!PERKS[perk]) return res.status(400).json({ error: 'Choose a free service.' });
    const v = await supabase.from('vehicles').select('id').eq('id', Number(req.body.vehicleId)).eq('user_id', req.user.id).maybeSingle();
    if (v.error) throw v.error;
    if (!v.data) return res.status(400).json({ error: 'Choose one of your vehicles.' });
    const note = String(req.body.note || '').trim().slice(0, 300);

    const allowed = rows => perkAllowance(rows, st)[perk];
    let a = allowed(await premiumRows(req.user.id));
    if (!a.canBook) {
      const msg = perk === 'oil'
        ? (a.left === 0 ? `You have used all ${a.limit} free oil and filter changes for this membership year.`
          : `Your next free oil and filter change is available from ${new Date(a.nextAvailable).toLocaleDateString('en-JM', { day: 'numeric', month: 'short', year: 'numeric' })}.`)
        : 'You have already booked your free brake pad check for this membership year.';
      return res.status(409).json({ error: msg });
    }
    const pay = perk === 'oil' ? premium.payOil : premium.payBrakes;
    const ins = await supabase.from('service_requests').insert({
      vehicle_id: v.data.id, category: PERKS[perk].category,
      customer_id: req.user.id, parish: req.user.parish || null, location_text: req.user.address || null,
      stage: 'searching',
      description: PERKS[perk].description + (note ? '. Customer note: ' + note : ''),
      premium_perk: perk, platform_pay: pay > 0 ? pay : null
    }).select().single();
    if (ins.error) throw ins.error;
    // two taps at once could both pass the check above: count again and undo this one if the limit was passed
    a = allowed(await premiumRows(req.user.id));
    if (a.used > a.limit) {
      await supabase.from('service_requests').delete().eq('id', ins.data.id);
      return res.status(409).json({ error: 'That free service was already booked.' });
    }
    res.status(201).json({ id: ins.data.id, perk, status: ins.data.status });
  }));

  // Other parts of the site can take payments with the same Fygaro account: they register a handler for a reference prefix.
  const handlers = {};
  const registerPaymentHandler = (prefix, fn) => { handlers[prefix] = fn; };

  // =============================== Fygaro's "payment received" notification ===============================
  // Needs the raw body for the signature check, so it is read with express.raw (see the skip list in server.js).
  router.post('/webhooks/fygaro', express.raw({ type: () => true, limit: '200kb' }), handle(async (req, res) => {
    const raw = req.body;
    if (!verifyFygaroSignature(raw, req.headers)) {
      console.warn('Fygaro webhook rejected: bad signature');
      return res.status(400).json({ error: 'Invalid signature.' });
    }
    let p;
    try { p = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'Bad body.' }); }
    const ref = String(p.customReference || p.custom_reference || '');
    const prov = /^sub-(\d+)-/.exec(ref), prem = /^prem-(\d+)-(monthly|yearly)-/.exec(ref);
    const paid = Number(p.amount), cur = String(p.currency || '').toUpperCase();
    const jobRef = /^job-(\d+)-/.exec(ref);
    if (jobRef && handlers.job) {
      if (!p.transactionId) { console.warn('Fygaro job payment without a transactionId:', ref); return res.json({ ok: true, ignored: true }); }
      await handlers.job({ jobId: Number(jobRef[1]), amount: paid, currency: cur, transactionId: String(p.transactionId), reference: ref });
      return res.json({ ok: true });
    }
    // From here on we answer 200 even when we decline to credit, so Fygaro does not keep retrying something we will never accept.
    if (!prov && !prem) { console.warn('Fygaro payment with a reference we do not recognise:', ref, p.transactionId); return res.json({ ok: true, ignored: true }); }
    if (!p.transactionId) { console.warn('Fygaro payment without a transactionId:', ref); return res.json({ ok: true, ignored: true }); }

    let job;
    if (prov) {
      job = { kind: 'provider', userId: Number(prov[1]), price: config.price, days: config.days, plan: null };
    } else {
      const plan = premiumPlans().find(x => x.id === prem[2]);
      if (!premium.enabled || !plan) { console.warn(`Fygaro payment ${p.transactionId}: Premium plan ${prem[2]} is not on offer`); return res.json({ ok: true, ignored: true }); }
      job = { kind: 'premium', userId: Number(prem[1]), price: plan.price, days: plan.days, plan: plan.id };
    }
    if (!(job.price > 0) || cur !== config.currency || !(paid >= job.price - 0.005)) {
      console.warn(`Fygaro payment ${p.transactionId} not credited: got ${p.amount} ${p.currency}, expected ${job.price} ${config.currency}`);
      return res.json({ ok: true, ignored: true });
    }
    const out = await credit({ userId: job.userId, provider: 'fygaro', transactionId: String(p.transactionId), amount: paid, currency: cur, days: job.days, kind: job.kind, plan: job.plan });
    if (!out.ok) console.warn('Fygaro payment for the wrong kind of account:', ref, p.transactionId);
    res.json({ ok: true });
  }));

  return { router, credit, config, gatewayReady, signJwt, verifyFygaroSignature, checkoutUrl, registerPaymentHandler };
};
module.exports.signJwt = signJwt;
module.exports.verifyFygaroSignature = verifyFygaroSignature;
