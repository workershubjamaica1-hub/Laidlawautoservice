// partsRoutes.js — order car and truck parts from approved parts vendors, in a chat.
//
// Customers:  GET /parts/vendors, POST /parts/orders, GET /parts/orders, GET /parts/orders/:id,
//             POST /parts/orders/:id/messages, /offer/respond, /cancel, /rating
// Vendors:    GET /parts/orders, GET /parts/orders/:id, POST /parts/orders/:id/messages, /offer, /complete, /cancel, GET /parts/ledger
// Admin:      GET /parts/orders (all), GET /parts/ledger (every vendor), POST /parts/vendors/:id/settle
//
// How an order moves:  chatting -> offered (vendor sends an offer) -> accepted (customer accepts) -> completed (vendor marks
// it picked up and paid). Either side can cancel before it is completed. Customers collect the part from the vendor and pay the
// vendor directly for now; AutoAid's commission (PARTS_COMMISSION_PERCENT, default 3) is worked out when the offer is accepted
// and counted once the vendor marks the order completed. The admin settles each vendor's commission from the ledger.
const express = require('express');
const mailer = require('./mailer');

const CONDITIONS = ['new', 'used', 'aftermarket', 'reconditioned'];
const MAX_OPEN_PER_CUSTOMER = 15;
const MAX_MESSAGES_PER_ORDER = 500;
const commissionPercent = (() => {
  const n = Number(process.env.PARTS_COMMISSION_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 3;
})();
const money = n => Math.round(Number(n) * 100) / 100;
const jmd = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });

module.exports = function partsRoutes({ supabase, handle, auth }) {
  const router = express.Router();
  const enabled = (req, res, next) => (auth.PARTS.enabled ? next() : res.status(404).json({ error: 'Parts ordering is not switched on yet.' }));
  const customerOnly = [enabled, ...auth.requireRole('customer')];
  const vendorOnly = [enabled, ...auth.requireRole('vendor')];
  const adminOnly = [enabled, ...auth.requireRole('admin')];
  const anyParty = [enabled, ...auth.requireRole('customer', 'vendor', 'admin')];

  async function usersById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const { data, error } = await supabase.from('users').select('id, name, business_name, parish, address, phone').in('id', list);
    if (error) throw error;
    return new Map(data.map(u => [u.id, u]));
  }
  async function vehiclesById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const { data, error } = await supabase.from('vehicles').select('id, type, year').in('id', list);
    if (error) throw error;
    return new Map(data.map(v => [v.id, v]));
  }
  const vendorName = u => (u ? (u.business_name || u.name) : 'Removed vendor');

  // What each person may see. Contact details are shared only once the customer accepts an offer.
  function shape(o, viewer, users, vehicles, last) {
    const isCustomer = viewer.role === 'customer', isVendor = viewer.role === 'vendor';
    const deal = o.status === 'accepted' || o.status === 'completed';
    const c = users.get(o.customer_id), v = users.get(o.vendor_id), veh = vehicles.get(o.vehicle_id);
    return {
      id: o.id, part: o.part, status: o.status,
      vehicle: veh ? { id: veh.id, name: veh.year + ' ' + veh.type } : null,
      customer: c ? { name: c.name, ...(deal && !isCustomer ? { phone: c.phone || '', parish: c.parish || '' } : {}) } : { name: 'Removed customer' },
      vendor: v ? { id: v.id, name: vendorName(v), parish: v.parish || '', ...(deal && !isVendor ? { address: v.address || '', phone: v.phone || '' } : {}) } : { name: 'Removed vendor' },
      offer: o.offer_total == null ? null : { item: o.offer_item, condition: o.offer_condition, quantity: o.offer_quantity, unitPrice: Number(o.offer_unit_price), total: Number(o.offer_total) },
      ...(!isCustomer && o.commission_amount != null ? { commission: { percent: Number(o.commission_percent), amount: Number(o.commission_amount), settled: !!o.commission_settled_at } } : {}),
      rating: o.rating || null, review: o.review || '',
      unread: isCustomer ? !!o.customer_unread : isVendor ? !!o.vendor_unread : false,
      createdAt: o.created_at, updatedAt: o.updated_at, completedAt: o.completed_at || null,
      lastMessage: last || ''
    };
  }

  const canSee = (u, o) => u.role === 'admin' || o.customer_id === u.id || o.vendor_id === u.id;
  async function loadOrder(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { res.status(404).json({ error: 'Order not found.' }); return null; }
    const { data, error } = await supabase.from('part_orders').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data || !canSee(req.user, data)) { res.status(404).json({ error: 'Order not found.' }); return null; }
    return data;
  }
  async function addMessage(orderId, senderId, kind, body) {
    const { error } = await supabase.from('part_messages').insert({ order_id: orderId, sender_id: senderId, kind, body });
    if (error) throw error;
  }
  const touch = (patch) => ({ ...patch, updated_at: new Date().toISOString() });
  async function update(o, patch) {
    const { data, error } = await supabase.from('part_orders').update(touch(patch)).eq('id', o.id).select().single();
    if (error) throw error;
    return data;
  }
  const isClosed = o => o.status === 'completed' || o.status === 'cancelled';
  const notify = async (userId, subject, text) => {   // best effort: never blocks or fails the request
    try {
      if (!mailer.ready()) return;
      const { data } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
      if (data && data.email) await mailer.sendMail({ to: data.email, subject, text: text + '\n\nSign in to AutoAid 24/7 to reply.' });
    } catch (e) { console.error('Could not send a parts notification:', e.message); }
  };

  // --- Customer: who can I order from? Vendors in my parish come first. ---
  router.get('/parts/vendors', ...customerOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('users').select('id, name, business_name, parish, experience, approved, active, email_verified, role').eq('role', 'vendor');
    if (error) throw error;
    const list = data.filter(u => u.approved !== false && u.active !== false && u.email_verified !== false)
      .map(u => ({ id: u.id, name: vendorName(u), parish: u.parish || '', about: u.experience || '', nearYou: !!req.user.parish && u.parish === req.user.parish }))
      .sort((a, b) => (b.nearYou - a.nearYou) || a.name.localeCompare(b.name));
    res.json({ commissionPercent, vendors: list });
  }));

  // --- Start an order chat with a vendor ---
  router.post('/parts/orders', ...customerOnly, handle(async (req, res) => {
    const b = req.body || {};
    const part = String(b.part || '').trim();
    if (part.length < 3 || part.length > 150) return res.status(400).json({ error: 'Say which part you need (3 to 150 characters), e.g. "front brake pads".' });
    const note = String(b.message || '').trim().slice(0, 1000);
    const vendor = await supabase.from('users').select('id, name, business_name, approved, active, email_verified').eq('id', Number(b.vendorId)).eq('role', 'vendor').maybeSingle();
    if (vendor.error) throw vendor.error;
    if (!vendor.data || vendor.data.approved === false || vendor.data.active === false || vendor.data.email_verified === false) return res.status(400).json({ error: 'Choose a vendor from the list.' });
    const veh = await supabase.from('vehicles').select('id, type, year, vin').eq('id', Number(b.vehicleId)).eq('user_id', req.user.id).maybeSingle();
    if (veh.error) throw veh.error;
    if (!veh.data) return res.status(400).json({ error: 'Choose one of your vehicles, so the vendor gets the right part.' });
    const open = await supabase.from('part_orders').select('id, status').eq('customer_id', req.user.id);
    if (open.error) throw open.error;
    if (open.data.filter(o => !isClosed(o)).length >= MAX_OPEN_PER_CUSTOMER) return res.status(429).json({ error: 'You have a lot of open part orders. Finish or cancel some first.' });

    const { data, error } = await supabase.from('part_orders')
      .insert({ customer_id: req.user.id, vendor_id: vendor.data.id, vehicle_id: veh.data.id, part, status: 'chatting', customer_unread: false, vendor_unread: true }).select().single();
    if (error) throw error;
    const intro = 'I need: ' + part + '\nVehicle: ' + veh.data.year + ' ' + veh.data.type + (veh.data.vin ? ' (VIN ' + veh.data.vin + ')' : '') + (note ? '\n' + note : '');
    await addMessage(data.id, req.user.id, 'text', intro);
    notify(vendor.data.id, 'New parts request on AutoAid 24/7', req.user.name + ' is asking for: ' + part + ' (' + veh.data.year + ' ' + veh.data.type + ').');
    const users = await usersById([data.customer_id, data.vendor_id]);
    res.status(201).json(shape(data, req.user, users, new Map([[veh.data.id, veh.data]]), intro));
  }));

  // --- My orders (customer), my customers' orders (vendor), or every order (admin) ---
  router.get('/parts/orders', ...anyParty, handle(async (req, res) => {
    let q = supabase.from('part_orders').select('*');
    if (req.user.role === 'customer') q = q.eq('customer_id', req.user.id);
    else if (req.user.role === 'vendor') q = q.eq('vendor_id', req.user.id);
    const { data, error } = await q.order('updated_at', { ascending: false });
    if (error) throw error;
    const users = await usersById(data.flatMap(o => [o.customer_id, o.vendor_id]));
    const vehicles = await vehiclesById(data.map(o => o.vehicle_id));
    const ids = data.map(o => o.id);
    const last = new Map();
    if (ids.length) {
      const m = await supabase.from('part_messages').select('order_id, body, id').in('order_id', ids).order('id', { ascending: true });
      if (m.error) throw m.error;
      m.data.forEach(x => last.set(x.order_id, x.body));
    }
    res.json(data.map(o => shape(o, req.user, users, vehicles, (last.get(o.id) || '').slice(0, 90))));
  }));

  // --- One order with its chat. Opening it marks it read for the person looking. ---
  router.get('/parts/orders/:id', ...anyParty, handle(async (req, res) => {
    let o = await loadOrder(req, res); if (!o) return;
    const mine = req.user.role === 'customer' ? 'customer_unread' : req.user.role === 'vendor' ? 'vendor_unread' : null;
    if (mine && o[mine]) { const { data } = await supabase.from('part_orders').update({ [mine]: false }).eq('id', o.id).select().single(); if (data) o = data; }
    const m = await supabase.from('part_messages').select('*').eq('order_id', o.id).order('id', { ascending: true });
    if (m.error) throw m.error;
    const users = await usersById([o.customer_id, o.vendor_id, ...m.data.map(x => x.sender_id)]);
    const vehicles = await vehiclesById([o.vehicle_id]);
    res.json({
      order: shape(o, req.user, users, vehicles, ''),
      messages: m.data.map(x => ({
        id: x.id, kind: x.kind, body: x.body, createdAt: x.created_at,
        from: x.kind === 'system' ? 'system' : x.sender_id === req.user.id ? 'me' : 'them',
        sender: x.kind === 'system' ? '' : x.sender_id === o.vendor_id ? vendorName(users.get(x.sender_id)) : (users.get(x.sender_id) || {}).name || ''
      }))
    });
  }));

  // --- Chat message (the customer or the vendor of this order) ---
  router.post('/parts/orders/:id/messages', ...anyParty, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins can read orders but not write in them.' });
    if (isClosed(o)) return res.status(409).json({ error: 'This order is closed.' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Type a message first.' });
    if (body.length > 1000) return res.status(400).json({ error: 'That message is too long (1000 characters at most).' });
    const count = await supabase.from('part_messages').select('id').eq('order_id', o.id);
    if (count.error) throw count.error;
    if (count.data.length >= MAX_MESSAGES_PER_ORDER) return res.status(429).json({ error: 'This chat is full. Start a new order.' });
    await addMessage(o.id, req.user.id, 'text', body);
    const other = req.user.role === 'customer' ? { vendor_unread: true } : { customer_unread: true };
    await update(o, other);
    res.status(201).json({ ok: true });
  }));

  // --- Vendor: send (or change) the offer ---
  router.post('/parts/orders/:id/offer', ...vendorOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.vendor_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (o.status !== 'chatting' && o.status !== 'offered') return res.status(409).json({ error: 'An offer can only be sent while the order is open.' });
    const b = req.body || {};
    const item = String(b.item || '').trim();
    if (item.length < 2 || item.length > 150) return res.status(400).json({ error: 'Describe the part you are offering (brand, number, fits).' });
    if (!CONDITIONS.includes(b.condition)) return res.status(400).json({ error: 'Choose new, used, aftermarket or reconditioned.' });
    const quantity = Number(b.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) return res.status(400).json({ error: 'Quantity must be a whole number from 1 to 50.' });
    const price = auth.parseAmount(b.unitPrice);
    if (price.error || price.value === null || price.value <= 0) return res.status(400).json({ error: 'Enter the price of one part in Jamaican dollars, e.g. 8500.' });
    const total = money(price.value * quantity);
    if (total > 10000000) return res.status(400).json({ error: 'That total is too large.' });
    await update(o, { status: 'offered', offer_item: item, offer_condition: b.condition, offer_quantity: quantity, offer_unit_price: price.value, offer_total: total, customer_unread: true });
    await addMessage(o.id, req.user.id, 'system', 'Offer: ' + quantity + ' x ' + item + ' (' + b.condition + ') at ' + jmd(price.value) + ' each. Total ' + jmd(total) + '.');
    notify(o.customer_id, 'You have an offer for your part', 'A vendor sent an offer for ' + o.part + ': ' + jmd(total) + '.');
    res.json({ ok: true, total });
  }));

  // --- Customer: accept or decline the offer ---
  router.post('/parts/orders/:id/offer/respond', ...customerOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.customer_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (o.status !== 'offered' || o.offer_total == null) return res.status(409).json({ error: 'There is no offer to answer.' });
    if (req.body && req.body.accept === true) {
      const commission = money(Number(o.offer_total) * commissionPercent / 100);
      await update(o, { status: 'accepted', accepted_at: new Date().toISOString(), commission_percent: commissionPercent, commission_amount: commission, vendor_unread: true });
      await addMessage(o.id, req.user.id, 'system', 'Offer accepted. Collect the part from the vendor and pay them ' + jmd(o.offer_total) + '. Their address and phone are now showing.');
      notify(o.vendor_id, 'Offer accepted', 'The customer accepted your offer of ' + jmd(o.offer_total) + ' for ' + o.part + '. They will collect it.');
    } else {
      await update(o, { status: 'chatting', offer_item: null, offer_condition: null, offer_quantity: null, offer_unit_price: null, offer_total: null, vendor_unread: true });
      await addMessage(o.id, req.user.id, 'system', 'Offer declined. You can keep chatting or send a new offer.');
    }
    res.json({ ok: true });
  }));

  // --- Vendor: the customer collected the part and paid ---
  router.post('/parts/orders/:id/complete', ...vendorOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.vendor_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (o.status !== 'accepted') return res.status(409).json({ error: 'Only an accepted order can be marked picked up.' });
    await update(o, { status: 'completed', completed_at: new Date().toISOString(), customer_unread: true });
    await addMessage(o.id, req.user.id, 'system', 'The vendor marked this order as picked up and paid. Thank you!');
    res.json({ ok: true });
  }));

  // --- Either side can cancel until it is completed ---
  router.post('/parts/orders/:id/cancel', ...anyParty, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins can read orders but not change them.' });
    if (isClosed(o)) return res.status(409).json({ error: 'This order is already closed.' });
    const byCustomer = req.user.role === 'customer';
    await update(o, { status: 'cancelled', commission_percent: null, commission_amount: null, [byCustomer ? 'vendor_unread' : 'customer_unread']: true });
    await addMessage(o.id, req.user.id, 'system', (byCustomer ? 'The customer' : 'The vendor') + ' cancelled this order.');
    res.json({ ok: true });
  }));

  // --- Customer rates the vendor after pickup ---
  router.post('/parts/orders/:id/rating', ...customerOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.customer_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (o.status !== 'completed') return res.status(409).json({ error: 'You can rate once the order is completed.' });
    if (o.rating) return res.status(409).json({ error: 'You already rated this order.' });
    const rating = Number(req.body && req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
    await update(o, { rating, review: String((req.body && req.body.review) || '').trim().slice(0, 500) || null });
    res.json({ ok: true });
  }));

  // --- Sales and commission: a vendor sees their own, an admin sees every vendor ---
  router.get('/parts/ledger', ...[enabled, ...auth.requireRole('vendor', 'admin')], handle(async (req, res) => {
    let q = supabase.from('part_orders').select('*').eq('status', 'completed');
    if (req.user.role === 'vendor') q = q.eq('vendor_id', req.user.id);
    const { data, error } = await q.order('completed_at', { ascending: false });
    if (error) throw error;
    const users = await usersById(data.map(o => o.vendor_id));
    const by = new Map();
    for (const o of data) {
      const v = by.get(o.vendor_id) || { vendorId: o.vendor_id, name: vendorName(users.get(o.vendor_id)), orders: 0, sales: 0, commission: 0, settled: 0 };
      v.orders++; v.sales = money(v.sales + Number(o.offer_total)); v.commission = money(v.commission + Number(o.commission_amount || 0));
      if (o.commission_settled_at) v.settled = money(v.settled + Number(o.commission_amount || 0));
      by.set(o.vendor_id, v);
    }
    const vendors = [...by.values()].map(v => ({ ...v, owed: money(v.commission - v.settled) }));
    res.json({
      commissionPercent, vendors,
      orders: req.user.role === 'vendor' ? data.map(o => ({ id: o.id, part: o.part, total: Number(o.offer_total), commission: Number(o.commission_amount || 0), settled: !!o.commission_settled_at, completedAt: o.completed_at })) : undefined
    });
  }));

  // --- Admin: the vendor has paid AutoAid the commission they owed so far ---
  router.post('/parts/vendors/:id/settle', ...adminOnly, handle(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Vendor not found.' });
    const { data, error } = await supabase.from('part_orders').update({ commission_settled_at: new Date().toISOString() })
      .eq('vendor_id', id).eq('status', 'completed').is('commission_settled_at', null).select();
    if (error) throw error;
    res.json({ settled: data.length });
  }));

  return { router, commissionPercent };
};
