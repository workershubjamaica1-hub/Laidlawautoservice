// rentalRoutes.js — vehicle rentals. Rental companies (vendors who offer "rentals") list vehicles; customers book them for dates.
//
// Customers:  GET /rentals/vehicles, POST /rentals/licence, GET /rentals/licence, POST /rentals/bookings, GET /rentals/bookings,
//             GET /rentals/bookings/:id, POST .../messages, /cancel, /rating
// Vendors:    GET/POST /rentals/my-vehicles, PATCH/DELETE /rentals/my-vehicles/:id, POST /rentals/my-vehicles/:id/photo,
//             POST /rentals/my-vehicles/:id/blocks, DELETE /rentals/blocks/:id,
//             GET /rentals/bookings, GET /rentals/bookings/:id/licence, POST .../accept, /decline, /pickup, /return, /cancel, GET /rentals/ledger
// Admin:      GET /rentals/bookings (all), GET /rentals/ledger (every vendor), POST /rentals/vendors/:id/settle
//
// A booking moves: requested -> accepted (vendor) -> picked_up (vendor) -> returned (vendor). It can end as declined or cancelled.
// The customer pays the vendor in person (rent and deposit are the vendor's business). AutoAid's commission (RENTALS_COMMISSION_PERCENT,
// default 5) is worked out on the rental total (not the deposit) when the vendor accepts, counted when the vehicle is returned,
// and settled by the admin from the ledger.
const express = require('express');
const mailer = require('./mailer');

const CATEGORIES = ['car', 'suv', 'truck', 'van', 'minibus', 'other'];
const TRANSMISSIONS = ['automatic', 'manual'];
const MAX_VEHICLES_PER_VENDOR = 50;
const MAX_ACTIVE_BOOKINGS_PER_CUSTOMER = 5;
const MIN_DAYS = 3;          // the shortest rental a vendor may offer; each vendor can set a longer minimum per vehicle
const OLD_CAR_YEARS = 10;    // a vehicle this old gets a deposit of one day's rent unless the vendor sets another amount
const MAX_DAYS = 60;
const MAX_MESSAGES = 500;
const commissionPercent = (() => {
  const n = Number(process.env.RENTALS_COMMISSION_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 5;
})();
const money = n => Math.round(Number(n) * 100) / 100;
const jmd = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });
const DAY = 86400000;

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY) + 1;   // both days count
const overlaps = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Jamaica' });   // YYYY-MM-DD in Jamaica

module.exports = function rentalRoutes({ supabase, handle, auth }) {
  const router = express.Router();
  const enabled = (req, res, next) => (auth.RENTALS.enabled ? next() : res.status(404).json({ error: 'Vehicle rentals are not switched on yet.' }));
  const customerOnly = [enabled, ...auth.requireRole('customer')];
  const anyParty = [enabled, ...auth.requireRole('customer', 'vendor', 'admin')];
  const adminOnly = [enabled, ...auth.requireRole('admin')];
  const bigJson = express.json({ limit: '6mb' });
  // Vendors who offer rentals only
  const rentalVendor = [enabled, ...auth.requireRole('vendor'), (req, res, next) =>
    (String(req.user.vendor_offers || 'parts').split(',').includes('rentals') ? next() : res.status(403).json({ error: 'Your account is not set up for vehicle rentals.' }))];

  const vendorName = u => (u ? (u.business_name || u.name) : 'Removed vendor');
  async function usersById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const { data, error } = await supabase.from('users').select('id, name, business_name, parish, address, phone, licence_photo_path').in('id', list);
    if (error) throw error;
    return new Map(data.map(u => [u.id, u]));
  }
  const touch = patch => ({ ...patch, updated_at: new Date().toISOString() });
  async function update(b, patch) {
    const { data, error } = await supabase.from('rental_bookings').update(touch(patch)).eq('id', b.id).select().single();
    if (error) throw error;
    return data;
  }
  async function addMessage(bookingId, senderId, kind, body) {
    const { error } = await supabase.from('rental_messages').insert({ booking_id: bookingId, sender_id: senderId, kind, body });
    if (error) throw error;
  }
  const notify = async (userId, subject, text) => {   // best effort: never blocks or fails the request
    try {
      if (!mailer.ready()) return;
      const { data } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
      if (data && data.email) await mailer.sendMail({ to: data.email, subject, text: text + '\n\nSign in to AutoAid 24/7 to reply.' });
    } catch (e) { console.error('Could not send a rental notification:', e.message); }
  };
  const OPEN = ['requested', 'accepted', 'picked_up'];
  const isClosed = b => !OPEN.includes(b.status);

  // Dates a vehicle is not free: accepted or picked-up bookings, and blocks the vendor added
  async function busyRanges(vehicleIds, exceptBookingId) {
    if (!vehicleIds.length) return new Map();
    const [bk, bl] = await Promise.all([
      supabase.from('rental_bookings').select('id, vehicle_id, start_date, end_date, status').in('vehicle_id', vehicleIds),
      supabase.from('rental_blocks').select('vehicle_id, start_date, end_date').in('vehicle_id', vehicleIds)
    ]);
    if (bk.error) throw bk.error; if (bl.error) throw bl.error;
    const map = new Map(vehicleIds.map(id => [id, []]));
    bk.data.filter(x => (x.status === 'accepted' || x.status === 'picked_up') && x.id !== exceptBookingId).forEach(x => map.get(x.vehicle_id).push([x.start_date, x.end_date]));
    bl.data.forEach(x => map.get(x.vehicle_id).push([x.start_date, x.end_date]));
    return map;
  }
  const isFree = (ranges, s, e) => !ranges.some(([a, b]) => overlaps(s, e, a, b));

  // ---------- vehicle shaping ----------
  const photoUrl = async v => { try { return v.photo_path ? await auth.signedPhotoUrl(v.photo_path) : null; } catch (_) { return null; } };
  const shapeVehicle = (v, vendor, url, extra = {}) => ({
    id: v.id, title: v.title, year: v.year, category: v.category, seats: v.seats, transmission: v.transmission,
    dailyRate: Number(v.daily_rate), deposit: Number(v.deposit || 0), minDays: v.min_days || MIN_DAYS,
    requirements: v.requirements || '', description: v.description || '', parish: v.parish || (vendor && vendor.parish) || '',
    vendorName: vendorName(vendor), vendorRequirements: (vendor && vendor.rental_requirements) || '', active: v.active !== false, photoUrl: url, ...extra
  });

  // ---------- customer: browse ----------
  router.get('/rentals/vehicles', ...customerOnly, handle(async (req, res) => {
    const q = req.query || {};
    const start = isDate(q.start) ? q.start : null, end = isDate(q.end) ? q.end : null;
    if ((start && !end) || (!start && end) || (start && end < start)) return res.status(400).json({ error: 'Choose a pick-up date and a return date on or after it.' });
    let query = supabase.from('rental_vehicles').select('*').eq('active', true);
    if (CATEGORIES.includes(q.category)) query = query.eq('category', q.category);
    if (auth.PARISHES.includes(q.parish)) query = query.eq('parish', q.parish);
    const { data, error } = await query;
    if (error) throw error;
    const vend = await supabase.from('users').select('id, name, business_name, parish, approved, active, email_verified, vendor_offers, rental_requirements')
      .in('id', [...new Set(data.map(v => v.vendor_id))].concat(0));
    if (vend.error) throw vend.error;
    const users = new Map(vend.data.filter(u => u.approved !== false && u.active !== false && u.email_verified !== false && String(u.vendor_offers || '').split(',').includes('rentals')).map(u => [u.id, u]));
    const list = data.filter(v => users.has(v.vendor_id));
    const busy = await busyRanges(list.map(v => v.id));
    const out = [];
    for (const v of list) {
      const free = start ? isFree(busy.get(v.id) || [], start, end) : null;
      out.push(shapeVehicle(v, users.get(v.vendor_id), await photoUrl(v), { available: free }));
    }
    out.sort((a, b) => ((b.available === true) - (a.available === true)) || ((req.user.parish === b.parish) - (req.user.parish === a.parish)) || a.dailyRate - b.dailyRate);
    res.json({ commissionPercent, vehicles: out });
  }));

  // ---------- customer: driving licence photo (needed once, before the first booking) ----------
  router.post('/rentals/licence', ...customerOnly, bigJson, handle(async (req, res) => {
    const img = auth.readImage(req.body);
    if (img.error) return res.status(img.status).json({ error: img.error });
    const path = 'licences/user-' + req.user.id;
    await auth.storePhoto(path, img.buf, img.type);
    const { error } = await supabase.from('users').update({ licence_photo_path: path }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true, hasLicence: true });
  }));
  router.get('/rentals/licence', ...customerOnly, (req, res) => res.json({ hasLicence: !!req.user.licence_photo_path }));

  // ---------- customer: ask to rent a vehicle ----------
  router.post('/rentals/bookings', ...customerOnly, handle(async (req, res) => {
    const b = req.body || {};
    if (b.hasLicenceConfirmed !== true) return res.status(400).json({ error: 'Please confirm that you hold a valid driver\'s licence.' });
    if (b.damageAuthorized !== true) return res.status(400).json({ error: 'Please agree that the vendor may charge you for any damage or loss, up to the deposit, with the card or deposit you give at pick-up.' });
    if (!req.user.licence_photo_path) return res.status(400).json({ error: 'Upload a photo of your driver\'s licence first.', code: 'licence_required' });
    if (!isDate(b.start) || !isDate(b.end)) return res.status(400).json({ error: 'Choose a pick-up date and a return date.' });
    if (b.start < today()) return res.status(400).json({ error: 'The pick-up date cannot be in the past.' });
    if (b.end < b.start) return res.status(400).json({ error: 'The return date must be on or after the pick-up date.' });
    const days = daysBetween(b.start, b.end);
    if (days > MAX_DAYS) return res.status(400).json({ error: 'Rentals are limited to ' + MAX_DAYS + ' days. Ask the vendor for a longer rental in the chat.' });
    const note = String(b.note || '').trim().slice(0, 500);
    const v = await supabase.from('rental_vehicles').select('*').eq('id', Number(b.vehicleId)).eq('active', true).maybeSingle();
    if (v.error) throw v.error;
    if (!v.data) return res.status(400).json({ error: 'That vehicle is not available to rent.' });
    const vendor = await supabase.from('users').select('id, name, business_name, approved, active, email_verified, vendor_offers').eq('id', v.data.vendor_id).maybeSingle();
    if (vendor.error) throw vendor.error;
    const vd = vendor.data;
    if (!vd || vd.approved === false || vd.active === false || vd.email_verified === false || !String(vd.vendor_offers || '').split(',').includes('rentals')) return res.status(400).json({ error: 'That vehicle is not available to rent.' });
    const minDays = Math.max(MIN_DAYS, v.data.min_days || MIN_DAYS);
    if (days < minDays) return res.status(400).json({ error: 'This vehicle is rented for at least ' + minDays + ' days.' });
    const busy = await busyRanges([v.data.id]);
    if (!isFree(busy.get(v.data.id), b.start, b.end)) return res.status(409).json({ error: 'That vehicle is not free on those dates. Try other dates.' });
    const mine = await supabase.from('rental_bookings').select('id, status').eq('customer_id', req.user.id);
    if (mine.error) throw mine.error;
    if (mine.data.filter(x => OPEN.includes(x.status)).length >= MAX_ACTIVE_BOOKINGS_PER_CUSTOMER) return res.status(429).json({ error: 'You have several rentals in progress. Finish or cancel one first.' });

    const rate = Number(v.data.daily_rate), total = money(rate * days);
    const { data, error } = await supabase.from('rental_bookings').insert({
      vehicle_id: v.data.id, vehicle_title: v.data.title, customer_id: req.user.id, vendor_id: v.data.vendor_id,
      start_date: b.start, end_date: b.end, days, daily_rate: rate, total, deposit: Number(v.data.deposit || 0), note: note || null,
      status: 'requested', damage_authorized_at: new Date().toISOString(), customer_unread: false, vendor_unread: true
    }).select().single();
    if (error) throw error;
    await addMessage(data.id, req.user.id, 'system', 'Rental requested: ' + v.data.title + ', ' + b.start + ' to ' + b.end + ' (' + days + ' day' + (days > 1 ? 's' : '') + '), ' + jmd(total) + '.' + (note ? ' Note: ' + note : ''));
    notify(v.data.vendor_id, 'New rental request on AutoAid 24/7', req.user.name + ' wants to rent ' + v.data.title + ' from ' + b.start + ' to ' + b.end + '.');
    const users = await usersById([data.customer_id, data.vendor_id]);
    res.status(201).json(shapeBooking(data, req.user, users, ''));
  }));

  // ---------- booking shaping: contact details and licence only once the vendor accepts ----------
  function shapeBooking(b, viewer, users, last) {
    const isCustomer = viewer.role === 'customer', isVendor = viewer.role === 'vendor';
    const deal = ['accepted', 'picked_up', 'returned'].includes(b.status);
    const c = users.get(b.customer_id), v = users.get(b.vendor_id);
    return {
      id: b.id, status: b.status, vehicle: { id: b.vehicle_id, title: b.vehicle_title },
      startDate: b.start_date, endDate: b.end_date, days: b.days, dailyRate: Number(b.daily_rate), total: Number(b.total), deposit: Number(b.deposit || 0), note: b.note || '', damageAuthorized: !!b.damage_authorized_at,
      customer: c ? { name: c.name, ...(deal && !isCustomer ? { phone: c.phone || '', parish: c.parish || '', hasLicence: !!c.licence_photo_path } : {}) } : { name: 'Removed customer' },
      vendor: v ? { id: v.id, name: vendorName(v), parish: v.parish || '', ...(deal && !isVendor ? { address: v.address || '', phone: v.phone || '' } : {}) } : { name: 'Removed vendor' },
      ...(!isCustomer && b.commission_amount != null ? { commission: { percent: Number(b.commission_percent), amount: Number(b.commission_amount), settled: !!b.commission_settled_at } } : {}),
      rating: b.rating || null, review: b.review || '',
      unread: isCustomer ? !!b.customer_unread : isVendor ? !!b.vendor_unread : false,
      createdAt: b.created_at, updatedAt: b.updated_at, returnedAt: b.returned_at || null, lastMessage: last || ''
    };
  }
  const canSee = (u, b) => u.role === 'admin' || b.customer_id === u.id || b.vendor_id === u.id;
  async function loadBooking(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { res.status(404).json({ error: 'Booking not found.' }); return null; }
    const { data, error } = await supabase.from('rental_bookings').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data || !canSee(req.user, data)) { res.status(404).json({ error: 'Booking not found.' }); return null; }
    return data;
  }

  router.get('/rentals/bookings', ...anyParty, handle(async (req, res) => {
    let q = supabase.from('rental_bookings').select('*');
    if (req.user.role === 'customer') q = q.eq('customer_id', req.user.id);
    else if (req.user.role === 'vendor') q = q.eq('vendor_id', req.user.id);
    const { data, error } = await q.order('updated_at', { ascending: false });
    if (error) throw error;
    const users = await usersById(data.flatMap(b => [b.customer_id, b.vendor_id]));
    const ids = data.map(b => b.id), last = new Map();
    if (ids.length) {
      const m = await supabase.from('rental_messages').select('booking_id, body, id').in('booking_id', ids).order('id', { ascending: true });
      if (m.error) throw m.error;
      m.data.forEach(x => last.set(x.booking_id, x.body));
    }
    res.json(data.map(b => shapeBooking(b, req.user, users, (last.get(b.id) || '').slice(0, 90))));
  }));

  router.get('/rentals/bookings/:id', ...anyParty, handle(async (req, res) => {
    let b = await loadBooking(req, res); if (!b) return;
    const mine = req.user.role === 'customer' ? 'customer_unread' : req.user.role === 'vendor' ? 'vendor_unread' : null;
    if (mine && b[mine]) { const { data } = await supabase.from('rental_bookings').update({ [mine]: false }).eq('id', b.id).select().single(); if (data) b = data; }
    const m = await supabase.from('rental_messages').select('*').eq('booking_id', b.id).order('id', { ascending: true });
    if (m.error) throw m.error;
    const users = await usersById([b.customer_id, b.vendor_id, ...m.data.map(x => x.sender_id)]);
    res.json({
      order: shapeBooking(b, req.user, users, ''),
      messages: m.data.map(x => ({
        id: x.id, kind: x.kind, body: x.body, createdAt: x.created_at,
        from: x.kind === 'system' ? 'system' : x.sender_id === req.user.id ? 'me' : 'them',
        sender: x.kind === 'system' ? '' : x.sender_id === b.vendor_id ? vendorName(users.get(x.sender_id)) : (users.get(x.sender_id) || {}).name || ''
      }))
    });
  }));

  router.post('/rentals/bookings/:id/messages', ...anyParty, handle(async (req, res) => {
    const b = await loadBooking(req, res); if (!b) return;
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins can read bookings but not write in them.' });
    if (isClosed(b)) return res.status(409).json({ error: 'This booking is closed.' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Type a message first.' });
    if (body.length > 1000) return res.status(400).json({ error: 'That message is too long (1000 characters at most).' });
    const count = await supabase.from('rental_messages').select('id').eq('booking_id', b.id);
    if (count.error) throw count.error;
    if (count.data.length >= MAX_MESSAGES) return res.status(429).json({ error: 'This chat is full.' });
    await addMessage(b.id, req.user.id, 'text', body);
    await update(b, req.user.role === 'customer' ? { vendor_unread: true } : { customer_unread: true });
    res.status(201).json({ ok: true });
  }));

  // ---------- vendor decisions ----------
  const mineAsVendor = (b, req) => b.vendor_id === req.user.id;
  const vendorActions = [enabled, ...auth.requireRole('vendor')];
  router.post('/rentals/bookings/:id/accept', ...vendorActions, handle(async (req, res) => {
    const b = await loadBooking(req, res); if (!b) return;
    if (!mineAsVendor(b, req)) return res.status(404).json({ error: 'Booking not found.' });
    if (b.status !== 'requested') return res.status(409).json({ error: 'Only a new request can be accepted.' });
    if (!b.vehicle_id) return res.status(409).json({ error: 'That vehicle has been removed.' });
    const busy = await busyRanges([b.vehicle_id], b.id);
    if (!isFree(busy.get(b.vehicle_id), b.start_date, b.end_date)) return res.status(409).json({ error: 'Those dates clash with another booking or a blocked day.' });
    const commission = money(Number(b.total) * commissionPercent / 100);
    await update(b, { status: 'accepted', accepted_at: new Date().toISOString(), commission_percent: commissionPercent, commission_amount: commission, customer_unread: true });
    await addMessage(b.id, req.user.id, 'system', 'The vendor accepted your rental. Collect the vehicle on ' + b.start_date + '. Their address and phone are now showing. Pay the vendor in person (rent ' + jmd(b.total) + (Number(b.deposit) ? ', deposit ' + jmd(b.deposit) : '') + ').');
    notify(b.customer_id, 'Your rental was accepted', 'Your rental of ' + b.vehicle_title + ' from ' + b.start_date + ' was accepted.');
    res.json({ ok: true });
  }));
  router.post('/rentals/bookings/:id/decline', ...vendorActions, handle(async (req, res) => {
    const b = await loadBooking(req, res); if (!b) return;
    if (!mineAsVendor(b, req)) return res.status(404).json({ error: 'Booking not found.' });
    if (b.status !== 'requested') return res.status(409).json({ error: 'Only a new request can be declined.' });
    await update(b, { status: 'declined', customer_unread: true });
    const why = String((req.body && req.body.reason) || '').trim().slice(0, 300);
    await addMessage(b.id, req.user.id, 'system', 'The vendor declined this request.' + (why ? ' Reason: ' + why : ''));
    notify(b.customer_id, 'Your rental request was declined', 'The vendor could not take your rental of ' + b.vehicle_title + '.');
    res.json({ ok: true });
  }));
  router.post('/rentals/bookings/:id/pickup', ...vendorActions, handle(async (req, res) => {
    const b = await loadBooking(req, res); if (!b) return;
    if (!mineAsVendor(b, req)) return res.status(404).json({ error: 'Booking not found.' });
    if (b.status !== 'accepted') return res.status(409).json({ error: 'Only an accepted booking can be handed over.' });
    await update(b, { status: 'picked_up', picked_up_at: new Date().toISOString(), customer_unread: true });
    await addMessage(b.id, req.user.id, 'system', 'The vehicle was handed over. Return it by ' + b.end_date + '.');
    res.json({ ok: true });
  }));
  router.post('/rentals/bookings/:id/return', ...vendorActions, handle(async (req, res) => {
    const b = await loadBooking(req, res); if (!b) return;
    if (!mineAsVendor(b, req)) return res.status(404).json({ error: 'Booking not found.' });
    if (b.status !== 'picked_up') return res.status(409).json({ error: 'Only a vehicle that is out can be marked returned.' });
    await update(b, { status: 'returned', returned_at: new Date().toISOString(), customer_unread: true });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 400);
    await addMessage(b.id, req.user.id, 'system', 'The vehicle was returned.' + (note ? ' Vendor note: ' + note : '') + ' Thank you!');
    res.json({ ok: true });
  }));

  // ---------- cancel: customer or vendor, until the vehicle is handed over ----------
  router.post('/rentals/bookings/:id/cancel', ...anyParty, handle(async (req, res) => {
    const b = await loadBooking(req, res); if (!b) return;
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins can read bookings but not change them.' });
    if (b.status !== 'requested' && b.status !== 'accepted') return res.status(409).json({ error: 'This booking can no longer be cancelled.' });
    const byCustomer = req.user.role === 'customer';
    await update(b, { status: 'cancelled', commission_percent: null, commission_amount: null, [byCustomer ? 'vendor_unread' : 'customer_unread']: true });
    await addMessage(b.id, req.user.id, 'system', (byCustomer ? 'The customer' : 'The vendor') + ' cancelled this booking.');
    res.json({ ok: true });
  }));

  router.post('/rentals/bookings/:id/rating', ...customerOnly, handle(async (req, res) => {
    const b = await loadBooking(req, res); if (!b) return;
    if (b.customer_id !== req.user.id) return res.status(404).json({ error: 'Booking not found.' });
    if (b.status !== 'returned') return res.status(409).json({ error: 'You can rate once the vehicle is returned.' });
    if (b.rating) return res.status(409).json({ error: 'You already rated this rental.' });
    const rating = Number(req.body && req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
    await update(b, { rating, review: String((req.body && req.body.review) || '').trim().slice(0, 500) || null });
    res.json({ ok: true });
  }));

  // The renter's licence photo: only the vendor of an accepted (or later) booking, or an admin
  router.get('/rentals/bookings/:id/licence', ...[enabled, ...auth.requireRole('vendor', 'admin')], handle(async (req, res) => {
    const b = await loadBooking(req, res); if (!b) return;
    if (!['accepted', 'picked_up', 'returned'].includes(b.status)) return res.status(403).json({ error: 'The licence is shown once you accept the booking.' });
    const u = (await usersById([b.customer_id])).get(b.customer_id);
    if (!u || !u.licence_photo_path) return res.status(404).json({ error: 'No licence photo on file.' });
    res.json({ url: await auth.signedPhotoUrl(u.licence_photo_path) });
  }));

  // ---------- vendor: the requirements that apply to every renter of this company ----------
  router.get('/rentals/my-requirements', ...rentalVendor, (req, res) => res.json({ requirements: req.user.rental_requirements || '' }));
  router.put('/rentals/my-requirements', ...rentalVendor, handle(async (req, res) => {
    const text = String((req.body && req.body.requirements) || '').trim();
    if (text.length > 600) return res.status(400).json({ error: 'Keep your requirements under 600 characters.' });
    const { error } = await supabase.from('users').update({ rental_requirements: text || null }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ requirements: text });
  }));

  // ---------- vendor: my vehicles ----------
  function readVehicle(body, vendor, partial) {
    const v = {}, b = body || {};
    const has = k => !partial || b[k] !== undefined;
    if (has('title')) { const t = String(b.title || '').trim(); if (t.length < 3 || t.length > 80) return { error: 'Enter the make and model, e.g. "Toyota Axio".' }; v.title = t; }
    if (has('year')) { const y = Number(b.year); if (!Number.isInteger(y) || y < 1980 || y > new Date().getFullYear() + 1) return { error: 'Enter the year of the vehicle.' }; v.year = y; }
    if (has('category')) { if (!CATEGORIES.includes(b.category)) return { error: 'Choose the type of vehicle.' }; v.category = b.category; }
    if (has('seats')) { const s = Number(b.seats); if (!Number.isInteger(s) || s < 1 || s > 60) return { error: 'Enter the number of seats.' }; v.seats = s; }
    if (has('transmission')) { if (!TRANSMISSIONS.includes(b.transmission)) return { error: 'Choose automatic or manual.' }; v.transmission = b.transmission; }
    if (has('dailyRate')) { const p = auth.parseAmount(b.dailyRate); if (p.error || !p.value || p.value <= 0 || p.value > 1000000) return { error: 'Enter the price per day in Jamaican dollars, e.g. 9500.' }; v.daily_rate = p.value; }
    if (has('deposit')) { const p = auth.parseAmount(b.deposit); if (p.error) return { error: 'Enter the deposit in Jamaican dollars (or leave it blank).' }; v.deposit = p.value || 0; }
    if (has('minDays')) { const m = b.minDays === '' || b.minDays == null ? MIN_DAYS : Number(b.minDays); if (!Number.isInteger(m) || m < MIN_DAYS || m > 30) return { error: 'The minimum rental is ' + MIN_DAYS + ' to 30 days.' }; v.min_days = m; }
    if (has('requirements')) v.requirements = String(b.requirements || '').trim().slice(0, 300) || null;
    if (has('description')) v.description = String(b.description || '').trim().slice(0, 600) || null;
    if (has('parish')) { const p = b.parish || (vendor && vendor.parish); if (!auth.PARISHES.includes(p)) return { error: 'Choose the parish the vehicle is collected in.' }; v.parish = p; }
    if (b.active !== undefined) v.active = !!b.active;
    return { value: v };
  }
  async function ownVehicle(req, res) {
    const id = Number(req.params.id);
    const { data, error } = await supabase.from('rental_vehicles').select('*').eq('id', id).eq('vendor_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Vehicle not found.' }); return null; }
    return data;
  }

  router.get('/rentals/my-vehicles', ...rentalVendor, handle(async (req, res) => {
    const { data, error } = await supabase.from('rental_vehicles').select('*').eq('vendor_id', req.user.id).order('id', { ascending: true });
    if (error) throw error;
    const ids = data.map(v => v.id);
    const blocks = ids.length ? await supabase.from('rental_blocks').select('*').in('vehicle_id', ids) : { data: [] };
    if (blocks.error) throw blocks.error;
    const out = [];
    for (const v of data) out.push(shapeVehicle(v, req.user, await photoUrl(v), { blocks: blocks.data.filter(x => x.vehicle_id === v.id).map(x => ({ id: x.id, start: x.start_date, end: x.end_date, note: x.note || '' })) }));
    res.json({ commissionPercent, vehicles: out });
  }));
  router.post('/rentals/my-vehicles', ...rentalVendor, handle(async (req, res) => {
    const r = readVehicle(req.body, req.user, false);
    if (r.error) return res.status(400).json({ error: r.error });
    const count = await supabase.from('rental_vehicles').select('id').eq('vendor_id', req.user.id);
    if (count.error) throw count.error;
    if (count.data.length >= MAX_VEHICLES_PER_VENDOR) return res.status(429).json({ error: 'You have reached the limit of ' + MAX_VEHICLES_PER_VENDOR + ' vehicles.' });
    // Older vehicles: if no deposit was entered, the deposit is one day's rent
    const blank = req.body.deposit === undefined || req.body.deposit === null || String(req.body.deposit).trim() === '';
    if (blank && new Date().getFullYear() - r.value.year >= OLD_CAR_YEARS) r.value.deposit = r.value.daily_rate;
    const { data, error } = await supabase.from('rental_vehicles').insert({ vendor_id: req.user.id, active: true, ...r.value }).select().single();
    if (error) throw error;
    res.status(201).json(shapeVehicle(data, req.user, null, { blocks: [] }));
  }));
  router.patch('/rentals/my-vehicles/:id', ...rentalVendor, handle(async (req, res) => {
    const v = await ownVehicle(req, res); if (!v) return;
    const r = readVehicle(req.body, req.user, true);
    if (r.error) return res.status(400).json({ error: r.error });
    const { data, error } = await supabase.from('rental_vehicles').update(r.value).eq('id', v.id).select().single();
    if (error) throw error;
    res.json(shapeVehicle(data, req.user, await photoUrl(data)));
  }));
  router.delete('/rentals/my-vehicles/:id', ...rentalVendor, handle(async (req, res) => {
    const v = await ownVehicle(req, res); if (!v) return;
    const open = await supabase.from('rental_bookings').select('id, status').eq('vehicle_id', v.id);
    if (open.error) throw open.error;
    if (open.data.some(x => OPEN.includes(x.status))) return res.status(409).json({ error: 'This vehicle has bookings in progress. Pause it instead, or finish them first.' });
    await auth.removePhoto(v.photo_path).catch(() => {});
    const { error } = await supabase.from('rental_vehicles').delete().eq('id', v.id);
    if (error) throw error;
    res.json({ ok: true });
  }));
  router.post('/rentals/my-vehicles/:id/photo', ...rentalVendor, bigJson, handle(async (req, res) => {
    const v = await ownVehicle(req, res); if (!v) return;
    const img = auth.readImage(req.body);
    if (img.error) return res.status(img.status).json({ error: img.error });
    const path = 'rentals/vehicle-' + v.id;
    await auth.storePhoto(path, img.buf, img.type);
    const { error } = await supabase.from('rental_vehicles').update({ photo_path: path }).eq('id', v.id);
    if (error) throw error;
    res.json({ ok: true });
  }));
  router.post('/rentals/my-vehicles/:id/blocks', ...rentalVendor, handle(async (req, res) => {
    const v = await ownVehicle(req, res); if (!v) return;
    const b = req.body || {};
    if (!isDate(b.start) || !isDate(b.end) || b.end < b.start) return res.status(400).json({ error: 'Choose the first and last day to block.' });
    const clash = await supabase.from('rental_bookings').select('start_date, end_date, status').eq('vehicle_id', v.id);
    if (clash.error) throw clash.error;
    if (clash.data.some(x => (x.status === 'accepted' || x.status === 'picked_up') && overlaps(b.start, b.end, x.start_date, x.end_date))) return res.status(409).json({ error: 'A booking is already confirmed on some of those days.' });
    const { data, error } = await supabase.from('rental_blocks').insert({ vehicle_id: v.id, start_date: b.start, end_date: b.end, note: String(b.note || '').trim().slice(0, 100) || null }).select().single();
    if (error) throw error;
    res.status(201).json({ id: data.id, start: data.start_date, end: data.end_date, note: data.note || '' });
  }));
  router.delete('/rentals/blocks/:id', ...rentalVendor, handle(async (req, res) => {
    const id = Number(req.params.id);
    const bl = await supabase.from('rental_blocks').select('id, vehicle_id').eq('id', id).maybeSingle();
    if (bl.error) throw bl.error;
    if (!bl.data) return res.status(404).json({ error: 'Not found.' });
    const own = await supabase.from('rental_vehicles').select('id').eq('id', bl.data.vehicle_id).eq('vendor_id', req.user.id).maybeSingle();
    if (own.error) throw own.error;
    if (!own.data) return res.status(404).json({ error: 'Not found.' });
    const { error } = await supabase.from('rental_blocks').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  }));

  // ---------- sales and commission ----------
  router.get('/rentals/ledger', ...[enabled, ...auth.requireRole('vendor', 'admin')], handle(async (req, res) => {
    let q = supabase.from('rental_bookings').select('*').eq('status', 'returned');
    if (req.user.role === 'vendor') q = q.eq('vendor_id', req.user.id);
    const { data, error } = await q.order('returned_at', { ascending: false });
    if (error) throw error;
    const users = await usersById(data.map(b => b.vendor_id));
    const by = new Map();
    for (const b of data) {
      const v = by.get(b.vendor_id) || { vendorId: b.vendor_id, name: vendorName(users.get(b.vendor_id)), orders: 0, sales: 0, commission: 0, settled: 0 };
      v.orders++; v.sales = money(v.sales + Number(b.total)); v.commission = money(v.commission + Number(b.commission_amount || 0));
      if (b.commission_settled_at) v.settled = money(v.settled + Number(b.commission_amount || 0));
      by.set(b.vendor_id, v);
    }
    res.json({
      commissionPercent, vendors: [...by.values()].map(v => ({ ...v, owed: money(v.commission - v.settled) })),
      orders: req.user.role === 'vendor' ? data.map(b => ({ id: b.id, part: b.vehicle_title + ' (' + b.days + ' day' + (b.days > 1 ? 's' : '') + ')', total: Number(b.total), commission: Number(b.commission_amount || 0), settled: !!b.commission_settled_at, completedAt: b.returned_at })) : undefined
    });
  }));
  router.post('/rentals/vendors/:id/settle', ...adminOnly, handle(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Vendor not found.' });
    const { data, error } = await supabase.from('rental_bookings').update({ commission_settled_at: new Date().toISOString() })
      .eq('vendor_id', id).eq('status', 'returned').is('commission_settled_at', null).select();
    if (error) throw error;
    res.json({ settled: data.length });
  }));

  return { router, commissionPercent };
};
