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
const INSTALL_MODES = ['none', 'shop', 'mobile'];   // accessories: fit it yourself, fitted at the seller's shop, or the seller comes to you
const INSTALL_TEXT = { shop: 'fitted at the seller\'s shop', mobile: 'fitted where the customer is (the seller comes to them)' };
const MAX_OPEN_PER_CUSTOMER = 15;
const MAX_MESSAGES_PER_ORDER = 500;
const commissionPercent = (() => {
  const n = Number(process.env.PARTS_COMMISSION_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 3;
})();
const money = n => Math.round(Number(n) * 100) / 100;
const jmd = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });

const AUTO_CONFIRM_MS = 3 * 24 * 60 * 60 * 1000;   // a customer who never confirms or reports a problem is taken to be happy after 3 days

module.exports = function partsRoutes({ supabase, handle, auth, push, subs }) {
  const router = express.Router();
  // Orders can be paid through AutoAid (Fygaro). Off until PARTS_ONLINE_PAYMENT=true and the Fygaro keys are set.
  const onlinePay = () => process.env.PARTS_ONLINE_PAYMENT === 'true' && !!subs && subs.gatewayReady();
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
  // rental-only companies are not parts vendors, and a parts-only vendor does not sell accessories
  const offersKind = (u, kind) => String(u.vendor_offers || 'parts').split(',').includes(kind === 'accessory' ? 'accessories' : 'parts');
  const kindOf = v => (v === 'accessory' ? 'accessory' : 'part');
  const vendorName = u => (u ? (u.business_name || u.name) : 'Removed vendor');

  // What each person may see. Contact details are shared only once the customer accepts an offer.
  function shape(o, viewer, users, vehicles, last) {
    const isCustomer = viewer.role === 'customer', isVendor = viewer.role === 'vendor';
    const deal = o.status === 'accepted' || o.status === 'completed';
    const c = users.get(o.customer_id), v = users.get(o.vendor_id), veh = vehicles.get(o.vehicle_id);
    return {
      id: o.id, part: o.part, status: o.status, kind: o.kind || 'part', installMode: o.install_mode && o.install_mode !== 'none' ? o.install_mode : null,
      vehicle: veh ? { id: veh.id, name: veh.year + ' ' + veh.type } : null,
      customer: c ? { name: c.name, ...(deal && !isCustomer ? { phone: c.phone || '', parish: c.parish || '' } : {}) } : { name: 'Removed customer' },
      vendor: v ? { id: v.id, name: vendorName(v), parish: v.parish || '', ...(deal && !isVendor ? { address: v.address || '', phone: v.phone || '' } : {}) } : { name: 'Removed vendor' },
      offer: o.offer_total == null ? null : { item: o.offer_item, condition: o.offer_condition, quantity: o.offer_quantity, unitPrice: Number(o.offer_unit_price), installFee: Number(o.offer_install_fee || 0), total: Number(o.offer_total) },
      ...(!isCustomer && o.commission_amount != null ? { commission: { percent: Number(o.commission_percent), amount: Number(o.commission_amount), settled: !!o.commission_settled_at } } : {}),
      rating: o.rating || null, review: o.review || '', open: !isClosed(o),
      payMode: o.pay_mode || 'in_person', paid: o.pay_status === 'paid', paidAmount: o.paid_amount == null ? null : Number(o.paid_amount), paysOnline: onlinePay(), settled: !!o.settled_at,
      ...(isCustomer && o.status === 'accepted' && o.pay_mode === 'platform' && o.pay_status !== 'paid' && onlinePay() && o.offer_total != null
        ? { payUrl: subs.checkoutUrl({ amount: Number(o.offer_total).toFixed(2), currency: subs.config.currency, custom_reference: 'part-' + o.id + '-' + Date.parse(o.accepted_at || o.updated_at || o.created_at) }, 3 * 3600) } : {}),
      ...(!isCustomer && o.payout_amount != null ? { payout: { amount: Number(o.payout_amount), settled: !!o.payout_settled_at } } : {}),
      ...(!isVendor && o.refund_status && o.refund_status !== 'none' ? { refund: { amount: Number(o.refund_amount || 0), status: o.refund_status, note: o.refund_note || '' } } : {}),
      ...(o.dispute_at ? { dispute: { at: o.dispute_at, note: o.dispute_note || '', resolvedAt: o.dispute_resolved_at || null, outcome: o.dispute_outcome || '' } } : {}),
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
  // a completed, paid order stays open for chat until the customer confirms it (or a dispute is decided)
  const reviewing = o => o.status === 'completed' && o.pay_mode === 'platform' && o.pay_status === 'paid' && !o.settled_at;
  const isClosed = o => (o.status === 'completed' || o.status === 'cancelled') && !reviewing(o);
  const noRefund = o => !o.refund_status || o.refund_status === 'none';
  async function alertAdmins(subject, text, url) {
    try {
      const { data } = await supabase.from('users').select('id, name, email').eq('role', 'admin').eq('active', true);
      if (!data || !data.length) return;
      if (push) { await push.notify(data.map(a => a.id), { title: subject, body: text.slice(0, 140), url: url || '/admin.html', tag: 'parts-pay', urgent: false }).catch(() => {}); await push.email(data, subject, text).catch(() => {}); }
      else if (mailer.ready()) for (const a of data) if (a.email) mailer.sendMail({ to: a.email, subject, text }).catch(() => {});
    } catch (e) { console.error('Could not alert the admin about an order:', e.message); }
  }
  const notify = async (userId, subject, text) => {   // best effort: never blocks or fails the request
    try {
      if (!mailer.ready()) return;
      const { data } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
      if (data && data.email) await mailer.sendMail({ to: data.email, subject, text: text + '\n\nSign in to AutoAid 24/7 to reply.' });
    } catch (e) { console.error('Could not send a parts notification:', e.message); }
  };

  // --- Customer: who can I order from? Vendors in my parish come first. ---
  router.get('/parts/vendors', ...customerOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('users').select('id, name, business_name, parish, experience, approved, active, email_verified, role, vendor_offers').eq('role', 'vendor');
    if (error) throw error;
    const kind = kindOf(req.query.kind);
    const list = data.filter(u => u.approved !== false && u.active !== false && u.email_verified !== false && offersKind(u, kind))
      .map(u => ({ id: u.id, name: vendorName(u), parish: u.parish || '', about: u.experience || '', nearYou: !!req.user.parish && u.parish === req.user.parish }))
      .sort((a, b) => (b.nearYou - a.nearYou) || a.name.localeCompare(b.name));
    res.json({ commissionPercent, vendors: list });
  }));

  // --- Start an order chat with a vendor ---
  router.post('/parts/orders', ...customerOnly, handle(async (req, res) => {
    const b = req.body || {};
    const kind = kindOf(b.kind), accessory = kind === 'accessory';
    const part = String(b.part || '').trim();
    if (part.length < 3 || part.length > 150) return res.status(400).json({ error: accessory ? 'Say what you want (3 to 150 characters), e.g. "LED headlight bulbs" or "black leather seat covers".' : 'Say which part you need (3 to 150 characters), e.g. "front brake pads".' });
    const install = accessory ? String(b.install || 'none') : null;
    if (accessory && !INSTALL_MODES.includes(install)) return res.status(400).json({ error: 'Choose how you want it fitted: no fitting, at the seller\'s shop, or where you are.' });
    const note = String(b.message || '').trim().slice(0, 1000);
    const vendor = await supabase.from('users').select('id, name, business_name, approved, active, email_verified, vendor_offers').eq('id', Number(b.vendorId)).eq('role', 'vendor').maybeSingle();
    if (vendor.error) throw vendor.error;
    if (!vendor.data || vendor.data.approved === false || vendor.data.active === false || vendor.data.email_verified === false || !offersKind(vendor.data, kind)) return res.status(400).json({ error: 'Choose a vendor from the list.' });
    const veh = await supabase.from('vehicles').select('id, type, year, vin').eq('id', Number(b.vehicleId)).eq('user_id', req.user.id).maybeSingle();
    if (veh.error) throw veh.error;
    if (!veh.data) return res.status(400).json({ error: 'Choose one of your vehicles, so the vendor gets the right part.' });
    const open = await supabase.from('part_orders').select('id, status').eq('customer_id', req.user.id);
    if (open.error) throw open.error;
    if (open.data.filter(o => !isClosed(o)).length >= MAX_OPEN_PER_CUSTOMER) return res.status(429).json({ error: 'You have a lot of open part orders. Finish or cancel some first.' });

    const { data, error } = await supabase.from('part_orders')
      .insert({ customer_id: req.user.id, vendor_id: vendor.data.id, vehicle_id: veh.data.id, part, kind, install_mode: install, status: 'chatting', customer_unread: false, vendor_unread: true }).select().single();
    if (error) throw error;
    const intro = (accessory ? 'I want: ' : 'I need: ') + part + (install && install !== 'none' ? '\nFitting: I want it ' + INSTALL_TEXT[install] + '.' : '') + '\nVehicle: ' + veh.data.year + ' ' + veh.data.type + (veh.data.vin ? ' (VIN ' + veh.data.vin + ')' : '') + (note ? '\n' + note : '');
    await addMessage(data.id, req.user.id, 'text', intro);
    notify(vendor.data.id, accessory ? 'New accessories request on AutoAid 24/7' : 'New parts request on AutoAid 24/7', req.user.name + ' is asking for: ' + part + ' (' + veh.data.year + ' ' + veh.data.type + ').' + (install && install !== 'none' ? ' They want it ' + INSTALL_TEXT[install] + '.' : ''));
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
    const accessory = o.kind === 'accessory';
    if (item.length < 2 || item.length > 150) return res.status(400).json({ error: accessory ? 'Describe what you are offering (brand, model, colour, fits).' : 'Describe the part you are offering (brand, number, fits).' });
    if (!CONDITIONS.includes(b.condition)) return res.status(400).json({ error: 'Choose new, used, aftermarket or reconditioned.' });
    const quantity = Number(b.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) return res.status(400).json({ error: 'Quantity must be a whole number from 1 to 50.' });
    const price = auth.parseAmount(b.unitPrice);
    if (price.error || price.value === null || price.value <= 0) return res.status(400).json({ error: 'Enter the price of one part in Jamaican dollars, e.g. 8500.' });
    let installFee = 0;
    if (accessory && b.installFee !== undefined && b.installFee !== null && String(b.installFee).trim() !== '') {
      const f = auth.parseAmount(b.installFee);
      if (f.error || f.value === null || f.value < 0 || f.value > 1000000) return res.status(400).json({ error: 'Enter the fitting charge in Jamaican dollars (0 if there is none).' });
      installFee = f.value;
    }
    const total = money(price.value * quantity + installFee);
    if (total > 10000000) return res.status(400).json({ error: 'That total is too large.' });
    await update(o, { status: 'offered', offer_item: item, offer_condition: b.condition, offer_quantity: quantity, offer_unit_price: price.value, offer_install_fee: installFee, offer_total: total, customer_unread: true });
    await addMessage(o.id, req.user.id, 'system', 'Offer: ' + quantity + ' x ' + item + ' (' + b.condition + ') at ' + jmd(price.value) + ' each' + (installFee > 0 ? ', plus ' + jmd(installFee) + ' for fitting' : accessory && o.install_mode && o.install_mode !== 'none' ? ', fitting included' : '') + '. Total ' + jmd(total) + '.');
    notify(o.customer_id, accessory ? 'You have an offer for your accessory' : 'You have an offer for your part', 'A vendor sent an offer for ' + o.part + ': ' + jmd(total) + '.');
    res.json({ ok: true, total });
  }));

  // --- Customer: accept or decline the offer ---
  router.post('/parts/orders/:id/offer/respond', ...customerOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.customer_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (o.status !== 'offered' || o.offer_total == null) return res.status(409).json({ error: 'There is no offer to answer.' });
    if (req.body && req.body.accept === true) {
      const commission = money(Number(o.offer_total) * commissionPercent / 100);
      const online = onlinePay();
      await update(o, { status: 'accepted', accepted_at: new Date().toISOString(), commission_percent: commissionPercent, commission_amount: commission, vendor_unread: true, pay_mode: online ? 'platform' : 'in_person' });
      const acc = o.kind === 'accessory';
      if (online) {
        await addMessage(o.id, req.user.id, 'system', 'Offer accepted. Pay ' + jmd(o.offer_total) + ' securely in the app. AutoAid 24/7 holds it, the seller ' + (acc && o.install_mode && o.install_mode !== 'none' ? 'fits it' : 'hands it over') + ' once it shows as paid, and the seller is paid after you confirm you are happy. Their address and phone are now showing.');
        notify(o.vendor_id, 'Offer accepted', 'The customer accepted your offer of ' + jmd(o.offer_total) + ' for ' + o.part + '. They will now pay in the app; you will be told when it is paid.');
        return res.json({ ok: true });
      }
      await addMessage(o.id, req.user.id, 'system', acc
        ? 'Offer accepted. ' + (o.install_mode === 'mobile' ? 'Agree a time in this chat for the seller to come and fit it, and pay them ' : o.install_mode === 'shop' ? 'Take your vehicle to the seller\'s shop to have it fitted, and pay them ' : 'Collect it from the seller and pay them ') + jmd(o.offer_total) + '. Their address and phone are now showing.'
        : 'Offer accepted. Collect the part from the vendor and pay them ' + jmd(o.offer_total) + '. Their address and phone are now showing.');
      notify(o.vendor_id, 'Offer accepted', 'The customer accepted your offer of ' + jmd(o.offer_total) + ' for ' + o.part + '. They will collect it.');
    } else {
      await update(o, { status: 'chatting', offer_item: null, offer_condition: null, offer_quantity: null, offer_unit_price: null, offer_install_fee: 0, offer_total: null, vendor_unread: true });
      await addMessage(o.id, req.user.id, 'system', 'Offer declined. You can keep chatting or send a new offer.');
    }
    res.json({ ok: true });
  }));

  // --- Vendor: the customer collected the part and paid ---
  router.post('/parts/orders/:id/complete', ...vendorOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.vendor_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (o.status !== 'accepted') return res.status(409).json({ error: 'Only an accepted order can be marked picked up.' });
    if (o.pay_mode === 'platform' && o.pay_status !== 'paid') return res.status(409).json({ error: 'The customer has not paid yet. Hand it over once the payment shows in this window.', code: 'payment_required' });
    await update(o, { status: 'completed', completed_at: new Date().toISOString(), customer_unread: true });
    if (o.pay_mode === 'platform') {
      await addMessage(o.id, req.user.id, 'system', 'The ' + (o.kind === 'accessory' ? 'seller' : 'vendor') + ' marked this order as ' + (o.kind === 'accessory' && o.install_mode && o.install_mode !== 'none' ? 'fitted' : 'handed over') + '. Customer: please confirm you are happy so the seller can be paid, or report a problem. If you do not answer within 3 days it is confirmed for you.');
      notify(o.customer_id, 'Please confirm your order', 'The seller marked ' + o.part + ' as done. Open AutoAid 24/7 to confirm you are happy, or report a problem.');
      return res.json({ ok: true });
    }
    await addMessage(o.id, req.user.id, 'system', o.kind === 'accessory' ? 'The seller marked this order as done and paid' + (o.install_mode && o.install_mode !== 'none' ? ' (fitted)' : '') + '. Thank you!' : 'The vendor marked this order as picked up and paid. Thank you!');
    res.json({ ok: true });
  }));

  // --- Either side can cancel until it is completed ---
  router.post('/parts/orders/:id/cancel', ...anyParty, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins can read orders but not change them.' });
    if (isClosed(o)) return res.status(409).json({ error: 'This order is already closed.' });
    const byCustomer = req.user.role === 'customer';
    const refundIt = o.pay_mode === 'platform' && o.pay_status === 'paid' && noRefund(o) && !o.settled_at;
    await update(o, { status: 'cancelled', commission_percent: null, commission_amount: null, [byCustomer ? 'vendor_unread' : 'customer_unread']: true,
      ...(refundIt ? { refund_status: 'due', refund_amount: Number(o.paid_amount), refund_note: 'Order cancelled before it was handed over: full refund.' } : {}) });
    await addMessage(o.id, req.user.id, 'system', (byCustomer ? 'The customer' : 'The vendor') + ' cancelled this order.' + (refundIt ? ' Your payment of ' + jmd(o.paid_amount) + ' will be refunded in full.' : ''));
    if (refundIt) alertAdmins('Order refund to send', 'A paid order was cancelled (#' + o.id + ', ' + o.part + '). Refund ' + jmd(o.paid_amount) + ' to the customer in Fygaro.', '/admin.html');
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

  // --- Paid through AutoAid: the customer confirms, then the seller is paid the price less the commission ---
  async function settle(o, note) {
    if (o.pay_mode !== 'platform' || o.pay_status !== 'paid' || o.settled_at) return o;
    const payout = money(Number(o.offer_total) - Number(o.commission_amount || 0));
    const now = new Date().toISOString();
    const done = await update(o, { settled_at: now, payout_amount: payout, commission_settled_at: now, vendor_unread: true, customer_unread: true });
    await addMessage(o.id, null, 'system', (note || 'The customer confirmed.') + ' The ' + (o.kind === 'accessory' ? 'seller' : 'vendor') + ' will be paid ' + jmd(payout) + ' (' + jmd(o.offer_total) + ' less AutoAid 24/7\'s ' + (o.commission_percent || commissionPercent) + '% commission). Thank you!');
    alertAdmins('Order to pay out', 'Order #' + o.id + ' (' + o.part + ') is confirmed. Pay the seller ' + jmd(payout) + '.', '/admin.html');
    return done;
  }
  if (subs && subs.registerPaymentHandler) {
    subs.registerPaymentHandler('part', async ({ orderId, amount, currency, transactionId }) => {
      const dup = await supabase.from('part_orders').select('id').eq('transaction_id', transactionId);
      if (!dup.error && dup.data.length) return;   // Fygaro sent the same notification twice
      const { data: o } = await supabase.from('part_orders').select('*').eq('id', orderId).maybeSingle();
      if (!o) { console.warn('Fygaro payment for an order that does not exist:', orderId, transactionId); return; }
      const fits = o.status === 'accepted' && o.pay_mode === 'platform' && o.pay_status !== 'paid' && o.offer_total != null && currency === subs.config.currency && Math.abs(amount - Number(o.offer_total)) < 0.01;
      try {
        if (fits) {
          await update(o, { pay_status: 'paid', paid_at: new Date().toISOString(), paid_amount: amount, transaction_id: transactionId, vendor_unread: true, customer_unread: true });
          await addMessage(o.id, null, 'system', 'Payment of ' + jmd(amount) + ' received. AutoAid 24/7 holds it. The ' + (o.kind === 'accessory' ? 'seller' : 'vendor') + ' can now ' + (o.kind === 'accessory' && o.install_mode && o.install_mode !== 'none' ? 'fit it' : 'hand it over') + '.');
          notify(o.vendor_id, 'The customer has paid', 'The customer paid ' + jmd(amount) + ' for ' + o.part + '. You can hand it over now.');
        } else {
          console.warn('Fygaro payment ' + transactionId + ' could not be used: order ' + orderId + ' is "' + o.status + '", got ' + amount + ' ' + currency + ', price ' + o.offer_total);
          const clean = o.status === 'cancelled' && o.pay_status !== 'paid' && noRefund(o);
          if (clean) {
            await update(o, { transaction_id: transactionId, refund_status: 'due', refund_amount: amount, refund_note: 'Payment arrived after the order was cancelled.', customer_unread: true });
            await addMessage(o.id, null, 'system', 'A payment of ' + jmd(amount) + ' arrived after this order was cancelled. It will be refunded in full.');
          } else await addMessage(o.id, null, 'system', 'A payment of ' + jmd(amount) + ' arrived that this order could not use. AutoAid 24/7 will look into it and refund it if it is not needed.');
          alertAdmins('Order payment to check', 'A payment of ' + jmd(amount) + ' (Fygaro transaction ' + transactionId + ') could not be used for order #' + o.id + '. ' + (clean ? 'It is on the refund list.' : 'Check it in Fygaro and refund it if it is a duplicate or the wrong amount.'), '/admin.html');
        }
      } catch (e) { if (!(e && e.code === '23505')) throw e; }
    });
  }
  router.post('/parts/orders/:id/confirm', ...customerOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.customer_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (!reviewing(o)) return res.status(409).json({ error: 'There is nothing to confirm on this order.' });
    if (o.dispute_at && !o.dispute_resolved_at) return res.status(409).json({ error: 'You reported a problem with this order. AutoAid 24/7 is looking into it.' });
    await settle(o, 'The customer confirmed they are happy with the order.');
    res.json({ ok: true });
  }));
  router.post('/parts/orders/:id/dispute', ...customerOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.customer_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
    if (!reviewing(o) || o.dispute_at) return res.status(409).json({ error: 'A problem can be reported once the seller marks the order done, until you confirm it.' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 600);
    if (note.length < 5) return res.status(400).json({ error: 'Tell us what is wrong (a few words) so AutoAid 24/7 can look into it.' });
    await update(o, { dispute_at: new Date().toISOString(), dispute_note: note, vendor_unread: true });
    await addMessage(o.id, req.user.id, 'system', 'The customer reported a problem: ' + note + ' The payment is held while AutoAid 24/7 looks into it. We will contact the customer and the ' + (o.kind === 'accessory' ? 'seller' : 'vendor') + '.');
    notify(o.vendor_id, 'A problem was reported on an order', 'The customer reported a problem with ' + o.part + ': ' + note + ' AutoAid 24/7 will contact you.');
    alertAdmins('Order dispute to review', 'The customer reported a problem with order #' + o.id + ' (' + o.part + '): ' + note + '. Contact the customer and the seller, then decide.', '/admin.html');
    res.json({ ok: true });
  }));
  router.post('/parts/orders/:id/resolve', ...adminOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (!reviewing(o) || !o.dispute_at || o.dispute_resolved_at) return res.status(409).json({ error: 'There is no open dispute on this order.' });
    const decision = req.body && req.body.decision, note = String((req.body && req.body.note) || '').trim().slice(0, 800);
    if (!['release', 'refund'].includes(decision)) return res.status(400).json({ error: 'Choose release (pay the seller) or refund (refund the customer).' });
    if (note.length < 5) return res.status(400).json({ error: 'Write what was decided and why.' });
    const decided = await update(o, { dispute_resolved_at: new Date().toISOString(), dispute_outcome: (decision === 'release' ? 'Seller paid. ' : 'Customer refunded. ') + note });
    if (decision === 'release') { await settle(decided, 'AutoAid 24/7 reviewed the problem and decided in the seller\'s favour: ' + note + '.'); }
    else {
      await update(decided, { settled_at: new Date().toISOString(), refund_status: 'due', refund_amount: Number(o.paid_amount), refund_note: 'Dispute decided for the customer.', commission_percent: null, commission_amount: null, customer_unread: true, vendor_unread: true });
      await addMessage(o.id, req.user.id, 'system', 'AutoAid 24/7 reviewed the problem and decided in the customer\'s favour: ' + note + '. Your payment of ' + jmd(o.paid_amount) + ' will be refunded in full.');
    }
    res.json({ ok: true });
  }));
  // what the admin does by hand: pay sellers, refund customers, decide disputes
  router.get('/parts/payouts', ...adminOnly, handle(async (req, res) => {
    const { data, error } = await supabase.from('part_orders').select('*').eq('pay_mode', 'platform');
    if (error) throw error;
    const users = await usersById(data.flatMap(o => [o.customer_id, o.vendor_id]));
    const det = new Map(((await supabase.from('users').select('id, payout_details').in('id', [...new Set(data.map(o => o.vendor_id))].concat(0))).data || []).map(u => [u.id, u.payout_details || '']));
    const by = new Map();
    for (const o of data.filter(x => x.payout_amount != null && !x.payout_settled_at)) {
      const v = users.get(o.vendor_id), p = by.get(o.vendor_id) || { vendorId: o.vendor_id, name: vendorName(v), phone: v ? v.phone || '' : '', amount: 0, orders: 0, payoutDetails: det.get(o.vendor_id) || '' };
      p.amount = money(p.amount + Number(o.payout_amount)); p.orders++; by.set(o.vendor_id, p);
    }
    const who = o => { const c = users.get(o.customer_id); return { name: c ? c.name : 'Removed customer', phone: c ? c.phone || '' : '' }; };
    res.json({
      payouts: [...by.values()],
      refunds: data.filter(o => o.refund_status === 'due').map(o => ({ id: o.id, part: o.part, amount: Number(o.refund_amount || 0), transactionId: o.transaction_id || '', note: o.refund_note || '', customer: who(o) })),
      disputes: data.filter(o => o.dispute_at && !o.dispute_resolved_at).map(o => ({ id: o.id, part: o.part, amount: Number(o.paid_amount || 0), note: o.dispute_note || '', customer: who(o), vendor: { name: vendorName(users.get(o.vendor_id)), phone: (users.get(o.vendor_id) || {}).phone || '' } }))
    });
  }));
  router.post('/parts/vendors/:id/payout-paid', ...adminOnly, handle(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Vendor not found.' });
    const { data, error } = await supabase.from('part_orders').update({ payout_settled_at: new Date().toISOString() }).eq('vendor_id', id).eq('pay_mode', 'platform').is('payout_settled_at', null).select();
    if (error) throw error;
    res.json({ paid: data.filter(o => o.payout_amount != null).length });
  }));
  router.post('/parts/orders/:id/refund-done', ...adminOnly, handle(async (req, res) => {
    const o = await loadOrder(req, res); if (!o) return;
    if (o.refund_status !== 'due') return res.status(409).json({ error: 'No refund is waiting on this order.' });
    await update(o, { refund_status: 'done', refund_done_at: new Date().toISOString(), customer_unread: true });
    await addMessage(o.id, req.user.id, 'system', 'Your refund of ' + jmd(o.refund_amount) + ' has been sent to your card.');
    res.json({ ok: true });
  }));
  // housekeeping: a customer who does not answer within 3 days is taken to be happy
  async function sweep(ageMs = AUTO_CONFIRM_MS) {
    const out = { autoConfirmed: 0 };
    try {
      const { data, error } = await supabase.from('part_orders').select('*').eq('status', 'completed').eq('pay_mode', 'platform');
      if (error) throw error;
      for (const o of data) if (o.pay_status === 'paid' && !o.settled_at && !o.dispute_at && o.completed_at && Date.now() - Date.parse(o.completed_at) >= ageMs) { await settle(o, 'The customer did not answer within 3 days, so the order is taken as confirmed.'); out.autoConfirmed++; }
    } catch (e) { console.error('Parts sweep failed:', e.message); }
    return out;
  }
  setTimeout(sweep, 3 * 60 * 1000).unref(); setInterval(sweep, 30 * 60 * 1000).unref();

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
      if (o.commission_settled_at || o.pay_mode === 'platform') v.settled = money(v.settled + Number(o.commission_amount || 0));   // paid through AutoAid: taken from the payout
      by.set(o.vendor_id, v);
    }
    const vendors = [...by.values()].map(v => ({ ...v, owed: money(v.commission - v.settled) }));
    res.json({
      commissionPercent, vendors,
      orders: req.user.role === 'vendor' ? data.map(o => ({ id: o.id, kind: o.kind || 'part', part: o.part, total: Number(o.offer_total), commission: Number(o.commission_amount || 0), settled: !!o.commission_settled_at, completedAt: o.completed_at })) : undefined
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

  return { router, commissionPercent, onlinePayment: onlinePay, sweep };
};
