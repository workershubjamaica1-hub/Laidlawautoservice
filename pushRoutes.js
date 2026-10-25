// pushRoutes.js — phone notifications (web push) and email alerts.
//
// A person turns notifications on once in their browser (a technician from the Jobs tab, a customer when they book). The browser
// gives us a private "address" for that phone; we store it and can then wake the phone with a notification even when AutoAid is closed.
//   GET  /push/key          the public key the browser needs (no sign-in needed)
//   POST /push/subscribe    save this browser's address for the signed-in person
//   POST /push/unsubscribe  forget it
//   POST /push/test         send a test notification to the signed-in person
//
// Keys: the site makes its own "VAPID" key pair the first time it needs one and keeps it in the app_settings table, so there is
// nothing to set up. (To use your own, set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.) Optional: VAPID_SUBJECT (a mailto: address).
const express = require('express');
const webpush = require('web-push');
const mailer = require('./mailer');

// Only real browser push services are allowed as destinations, so nobody can make the server call an address of their choosing.
const PUSH_HOSTS = /(^|\.)(googleapis\.com|mozilla\.com|mozilla\.org|windows\.com|apple\.com)$/i;
const MAX_PER_USER = 10;
const FAKE = process.env.PUSH_FAKE === '1' && process.env.NODE_ENV !== 'production';   // tests only: record instead of sending

module.exports = function createPush({ supabase, handle, auth, app }) {
  const router = express.Router();
  const fakeLog = [];
  let keyPromise = null;

  function loadKeys() {
    if (!keyPromise) keyPromise = (async () => {
      if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
      const got = await supabase.from('app_settings').select('value').eq('key', 'vapid').maybeSingle();
      if (got.error) throw got.error;
      if (got.data && got.data.value && got.data.value.publicKey) return got.data.value;
      const fresh = webpush.generateVAPIDKeys();
      const put = await supabase.from('app_settings').insert({ key: 'vapid', value: fresh });
      if (put.error) {   // another copy of the server saved a pair first: use that one
        const again = await supabase.from('app_settings').select('value').eq('key', 'vapid').maybeSingle();
        if (again.data && again.data.value) return again.data.value;
        throw put.error;
      }
      return fresh;
    })().catch(err => { keyPromise = null; throw err; });
    return keyPromise;
  }
  async function ready() {
    const k = await loadKeys();
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || ('mailto:' + (process.env.CONTACT_EMAIL || 'support@autoaid247.com')), k.publicKey, k.privateKey);
    return k;
  }

  // Sends a notification to every browser these people have turned notifications on in. Never throws.
  async function notify(userIds, payload, opts = {}) {
    try {
      const ids = [...new Set(userIds.filter(Boolean))];
      if (!ids.length) return { sent: 0 };
      const { data, error } = await supabase.from('push_subscriptions').select('*').in('user_id', ids);
      if (error) throw error;
      if (!data.length) return { sent: 0 };
      if (!FAKE) await ready();
      const body = JSON.stringify({ title: payload.title, body: payload.body || '', url: payload.url || '/', tag: payload.tag || undefined, urgent: !!payload.urgent });
      let sent = 0;
      await Promise.all(data.map(async s => {
        try {
          if (FAKE) { fakeLog.push({ userId: s.user_id, endpoint: s.endpoint, ...JSON.parse(body) }); sent++; return; }
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body,
            { TTL: opts.ttl || (payload.urgent ? 600 : 3600), urgency: payload.urgent ? 'high' : 'normal' });
          sent++;
        } catch (err) {
          if (err && (err.statusCode === 404 || err.statusCode === 410)) await supabase.from('push_subscriptions').delete().eq('id', s.id);   // the phone is gone
          else console.error('Push failed:', err && (err.statusCode || err.message));
        }
      }));
      return { sent };
    } catch (err) { console.error('Could not send notifications:', err.message); return { sent: 0 }; }
  }

  // Which of these people have notifications turned on?
  async function withSubscriptions(userIds) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return new Set();
    const { data, error } = await supabase.from('push_subscriptions').select('user_id').in('user_id', ids);
    if (error) throw error;
    return new Set(data.map(r => r.user_id));
  }

  // Email alert (best effort)
  async function email(users, subject, text) {
    if (!mailer.ready()) return;
    for (const u of users) {
      if (!u.email) continue;
      try { await mailer.sendMail({ to: u.email, subject, text: text + '\n\nOpen AutoAid 24/7 to respond.' }); }
      catch (err) { console.error('Alert email failed:', err.message); }
    }
  }

  // ---------------- routes ----------------
  router.get('/push/key', handle(async (req, res) => {
    if (FAKE) return res.json({ enabled: true, publicKey: 'BFAKEKEYFORTESTSONLY' });
    try { res.json({ enabled: true, publicKey: (await loadKeys()).publicKey }); }
    catch (err) { console.error('Push keys unavailable:', err.message); res.json({ enabled: false }); }
  }));

  router.post('/push/subscribe', auth.requireAuth, handle(async (req, res) => {
    const sub = req.body && req.body.subscription;
    const endpoint = String((sub && sub.endpoint) || '');
    let host = '';
    try { const u = new URL(endpoint); if (u.protocol !== 'https:') throw new Error('not https'); host = u.hostname; } catch (_) { return res.status(400).json({ error: 'That notification address is not valid.' }); }
    if (!PUSH_HOSTS.test(host) || endpoint.length > 800) return res.status(400).json({ error: 'That browser is not supported for notifications.' });
    const p256dh = String((sub.keys && sub.keys.p256dh) || ''), authKey = String((sub.keys && sub.keys.auth) || '');
    if (!/^[A-Za-z0-9_\-+/=]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_\-+/=]{8,100}$/.test(authKey)) return res.status(400).json({ error: 'That notification address is not valid.' });
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);          // the same phone may switch accounts
    const mine = await supabase.from('push_subscriptions').select('id').eq('user_id', req.user.id).order('id', { ascending: true });
    if (!mine.error && mine.data.length >= MAX_PER_USER) await supabase.from('push_subscriptions').delete().eq('id', mine.data[0].id);
    const { error } = await supabase.from('push_subscriptions').insert({ user_id: req.user.id, endpoint, p256dh, auth: authKey, user_agent: String(req.get('user-agent') || '').slice(0, 200) });
    if (error) throw error;
    res.status(201).json({ ok: true });
  }));

  router.post('/push/unsubscribe', auth.requireAuth, handle(async (req, res) => {
    const endpoint = String((req.body && req.body.endpoint) || '');
    if (endpoint) await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', req.user.id);
    res.json({ ok: true });
  }));

  router.post('/push/test', auth.requireAuth, handle(async (req, res) => {
    const out = await notify([req.user.id], { title: 'AutoAid 24/7', body: 'Notifications are working on this phone.', url: '/', tag: 'autoaid-test' });
    if (!out.sent) return res.status(409).json({ error: 'No phone is set up for notifications on your account yet.' });
    res.json({ ok: true, sent: out.sent });
  }));

  if (FAKE && app) app.get('/_push_log', (req, res) => res.json(fakeLog));

  return { router, notify, email, withSubscriptions, ready, fakeLog };
};
