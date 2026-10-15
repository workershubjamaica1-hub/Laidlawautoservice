// subscriptions.js — the monthly subscription for service providers: checkout link, payment notification (webhook) and credits.
//
// How a payment works (Fygaro):
//   1. The provider taps "Pay now". We build a Fygaro payment link with a signed JWT (amount, currency and a reference that names
//      the provider), so the customer cannot change the amount.
//   2. They pay on Fygaro's page. Fygaro then POSTs a signed notification to  /webhooks/fygaro.
//   3. We verify the signature (HMAC-SHA256 over "<timestamp>.<raw body>"), check the amount, and extend their access.
// Setup steps are in PAYMENTS.md. Fygaro's JWT links and notifications need their Pro plan.
const crypto = require('crypto');
const express = require('express');
const { config, statusOf, priceLabel, DAY } = require('./subscriptionConfig');

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

module.exports = function createSubscriptions({ supabase, handle, auth }) {
  const router = express.Router();

  const getUser = async id => {
    const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  };

  // Gives a provider more access time and records it. Safe to call twice for the same transactionId.
  async function credit({ userId, provider, transactionId = null, amount = null, currency = null, days = config.days }) {
    const user = await getUser(userId);
    if (!user || user.role !== 'staff') return { ok: false, reason: 'not-a-provider' };
    if (transactionId) {
      const dup = await supabase.from('subscription_payments').select('id, period_end').eq('transaction_id', transactionId).maybeSingle();
      if (dup.error) throw dup.error;
      if (dup.data) {
        // already recorded; make sure the access date really got applied (a previous attempt may have stopped halfway)
        const have = user.subscription_paid_until ? Date.parse(user.subscription_paid_until) : 0;
        if (have < Date.parse(dup.data.period_end)) {
          const fix = await supabase.from('users').update({ subscription_paid_until: dup.data.period_end }).eq('id', userId);
          if (fix.error) throw fix.error;
        }
        return { ok: true, duplicate: true };
      }
    }
    const now = Date.now();
    const start = Math.max(now, user.subscription_paid_until ? Date.parse(user.subscription_paid_until) : 0); // paying early adds to the end
    const end = new Date(start + days * DAY).toISOString();
    const ins = await supabase.from('subscription_payments').insert({
      user_id: userId, provider, transaction_id: transactionId, amount, currency,
      period_start: new Date(start).toISOString(), period_end: end
    }).select().single();
    if (ins.error) {
      if (ins.error.code === '23505') return { ok: true, duplicate: true }; // two copies of the same notification arrived together
      throw ins.error;
    }
    const upd = await supabase.from('users').update({ subscription_paid_until: end }).eq('id', userId);
    if (upd.error) throw upd.error;
    return { ok: true, paidUntil: end };
  }

  // --- A provider's own subscription ---
  const providerOnly = auth.requireRole('staff');

  router.get('/subscription', providerOnly, (req, res) => {
    const s = statusOf(req.user);
    res.json({
      enabled: config.enabled, ...s, price: config.price, currency: config.currency, priceLabel: priceLabel(),
      days: config.days, graceDays: config.graceDays, canPayOnline: gatewayReady() && config.price > 0
    });
  });

  // Builds the Fygaro payment link for this provider (amount is signed into the link, so it cannot be edited)
  router.post('/subscription/checkout', providerOnly, handle(async (req, res) => {
    if (!config.enabled) return res.status(400).json({ error: 'Subscriptions are not switched on.' });
    if (!gatewayReady() || !(config.price > 0)) return res.status(503).json({ error: 'Online payment is not set up yet. Please contact AutoAid 24/7 to activate your account.' });
    const claims = {
      amount: config.price.toFixed(2), currency: config.currency,
      custom_reference: `sub-${req.user.id}-${Date.now()}`,
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    const jwt = signJwt(claims, FYGARO.keyId, FYGARO.secret);
    const url = FYGARO.buttonUrl + (FYGARO.buttonUrl.includes('?') ? '&' : '?') + 'jwt=' + jwt;
    res.json({ url });
  }));

  // --- Fygaro's "payment received" notification ---
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
    const m = /^sub-(\d+)-/.exec(ref);
    const paid = Number(p.amount), cur = String(p.currency || '').toUpperCase();
    // From here on we answer 200 even when we decline to credit, so Fygaro does not keep retrying something we will never accept.
    if (!m) { console.warn('Fygaro payment with a reference we do not recognise:', ref, p.transactionId); return res.json({ ok: true, ignored: true }); }
    if (!p.transactionId) { console.warn('Fygaro payment without a transactionId:', ref); return res.json({ ok: true, ignored: true }); }
    if (!(config.price > 0) || cur !== config.currency || !(paid >= config.price - 0.005)) {
      console.warn(`Fygaro payment ${p.transactionId} not credited: got ${p.amount} ${p.currency}, expected ${config.price} ${config.currency}`);
      return res.json({ ok: true, ignored: true });
    }
    const out = await credit({ userId: Number(m[1]), provider: 'fygaro', transactionId: String(p.transactionId), amount: paid, currency: cur });
    if (!out.ok) console.warn('Fygaro payment for an unknown provider:', ref, p.transactionId);
    res.json({ ok: true });
  }));

  return { router, credit, config, gatewayReady, signJwt, verifyFygaroSignature };
};
module.exports.signJwt = signJwt;
module.exports.verifyFygaroSignature = verifyFygaroSignature;
