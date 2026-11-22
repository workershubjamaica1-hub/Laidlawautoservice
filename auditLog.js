// A record of what admins change (switches, prices, approvals, payments, refunds, deletions), shown in the Control center.
// Every successful change made by an admin is noted automatically after it goes through; nothing is stored for ordinary users.
// Entries live in app_settings, one record per month (audit_YYYY_MM), newest 3000 kept each month.
const express = require('express');

module.exports = function ({ supabase, handle, auth }) {
  const router = express.Router();
  const adminOnly = auth.requireRole('admin');
  const MAX = 3000;
  let queue = Promise.resolve();   // one write at a time, so two quick actions never overwrite each other

  const keyFor = d => 'audit_' + d.getUTCFullYear() + '_' + String(d.getUTCMonth() + 1).padStart(2, '0');
  const SKIP = /^\/(auth|push|ai-chat|jobs\/online|admin\/email-test)\b|\/messages?\b|\/read$/;
  const SECRET = /pass|token|secret|image|photo|proof|licence/i;

  const LABELS = [
    [/^PUT \/admin\/features$/, b => 'Switched ' + b.key + (b.on ? ' ON' : ' OFF')],
    [/^PUT \/admin\/settings$/, b => 'Changed prices and rates: ' + Object.entries(b.values || {}).map(([k, v]) => k + (v === null ? ' back to Render' : ' = ' + v)).join(', ')],
    [/^PUT \/admin\/service-area$/, b => 'Set the open parishes: ' + (Array.isArray(b.active) ? b.active.join(', ') : '')],
    [/^PUT \/admin\/bank-details$/, () => 'Changed the bank details'],
    [/^POST \/admin\/bank-payments\/(\d+)\/confirm$/, (b, m) => 'Confirmed bank payment #' + m[1] + ' (Premium started)'],
    [/^POST \/admin\/bank-payments\/(\d+)\/reject$/, (b, m) => 'Rejected bank payment #' + m[1]],
    [/^PATCH \/admin\/users\/(\d+)$/, (b, m) => 'Edited user #' + m[1] + ' (' + Object.keys(b).filter(k => !SECRET.test(k)).map(k => k + ': ' + String(b[k]).slice(0, 40)).join(', ') + ')'],
    [/^POST \/admin\/users$/, b => 'Added a person: ' + String(b.name || '').slice(0, 40) + ' (' + String(b.role || '') + ')'],
    [/^DELETE \/admin\/users\/(\d+)$/, (b, m) => 'Deleted user #' + m[1]],
    [/^POST \/admin\/users\/(\d+)\/verify$/, (b, m) => 'Verified user #' + m[1]],
    [/^POST \/admin\/users\/(\d+)\/identity$/, (b, m) => 'Checked the identity of user #' + m[1]],
    [/^POST \/admin\/users\/(\d+)\/subscription$/, (b, m) => 'Changed the subscription of user #' + m[1]],
    [/^POST \/admin\/vehicles\/(\d+)\/premium$/, (b, m) => 'Changed Premium on vehicle #' + m[1]],
    [/^DELETE \/admin\/vehicle\/(\d+)$/, (b, m) => 'Deleted vehicle #' + m[1]],
    [/^DELETE \/admin\/service-request\/(\d+)$/, (b, m) => 'Deleted service request #' + m[1]],
    [/^POST \/(jobs|parts\/orders|rentals\/bookings)\/(\d+)\/resolve$/, (b, m) => 'Decided the complaint on ' + m[1] + ' #' + m[2] + (b.decision ? ': ' + String(b.decision).slice(0, 40) : '')],
    [/^POST \/(jobs|parts\/orders|rentals\/bookings)\/(\d+)\/refund-done$/, (b, m) => 'Marked the refund done on ' + m[1] + ' #' + m[2]],
    [/^POST \/(jobs|parts|rentals)\/(technicians|vendors)\/(\d+)\/payout-paid$/, (b, m) => 'Marked a payout paid (' + m[1] + ', user #' + m[3] + ')'],
    [/^POST \/(jobs|parts|rentals)\/(technicians|vendors)\/(\d+)\/settle$/, (b, m) => 'Marked a balance settled (' + m[1] + ', user #' + m[3] + ')'],
    [/^POST \/rentals\/bookings\/(\d+)\/late-fee$/, (b, m) => 'Set a late fee on rental #' + m[1]]
  ];
  function describe(method, path, body) {
    const key = method + ' ' + path;
    for (const [re, fn] of LABELS) { const m = key.match(re); if (m) { try { return fn(body || {}, m); } catch (_) { break; } } }
    return method + ' ' + path;
  }

  function record(entry) {
    queue = queue.then(async () => {
      const key = keyFor(new Date(entry.at));
      const got = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
      const list = got.data && got.data.value && Array.isArray(got.data.value.entries) ? got.data.value.entries : [];
      list.push(entry);
      const value = { entries: list.slice(-MAX) };
      const w = got.data ? await supabase.from('app_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key) : await supabase.from('app_settings').insert({ key, value });
      if (w.error) throw w.error;
    }).catch(err => console.warn('Could not write the admin log:', err.message));
  }

  // runs before every route; looks at the finished response, so only changes that went through are noted
  function middleware(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const path = req.originalUrl.split('?')[0];
    if (SKIP.test(path)) return next();
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.user || req.user.role !== 'admin') return;
      record({ at: new Date().toISOString(), adminId: req.user.id, admin: req.user.name || req.user.email || '', action: describe(req.method, path, req.body).slice(0, 300) });
    });
    next();
  }

  router.get('/admin/audit', adminOnly, handle(async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const now = new Date(), prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const out = [];
    for (const d of [now, prev]) {
      const got = await supabase.from('app_settings').select('value').eq('key', keyFor(d)).maybeSingle();
      if (got.data && got.data.value && Array.isArray(got.data.value.entries)) out.push(...got.data.value.entries);
    }
    out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    res.json({ entries: out.slice(0, limit) });
  }));

  return { router, middleware };
};
