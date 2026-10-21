// Shared by the customer app and the vendor page: the parts order list and the chat window for one order.
// PartsChat.create({ api, role, commissionPercent, onChange }) -> { renderList(el, orders), open(id), close() }
//   role is 'customer', 'vendor' or 'admin'. api(path, { method, body }) is the page's own fetch helper (adds the sign-in token).
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jmd = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });
  const STATUS = { chatting: 'Chatting', offered: 'Offer sent', accepted: 'Accepted', completed: 'Completed', cancelled: 'Cancelled' };
  const COND = { new: 'New', used: 'Used', aftermarket: 'Aftermarket', reconditioned: 'Reconditioned' };
  const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function create({ api, role, commissionPercent, onChange }) {
    let dlg = document.getElementById('dlg-thread');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'modal wide thread'; dlg.id = 'dlg-thread'; dlg.setAttribute('aria-labelledby', 'th-title');
      dlg.innerHTML =
        '<button class="modal-x" type="button" data-close aria-label="Close">&times;</button>' +
        '<div class="th-head"><div><h2 id="th-title"></h2><p class="th-sub" id="th-sub"></p></div><span id="th-pill"></span></div>' +
        '<div id="th-panel"></div>' +
        '<div class="th-log" id="th-log" role="log" aria-live="polite"></div>' +
        '<form id="th-form" novalidate><textarea id="th-text" rows="2" maxlength="1000" placeholder="Type a message. Enter to send, Shift+Enter for a new line." aria-label="Message"></textarea>' +
        '<button class="btn" id="th-send" type="submit">Send</button></form>' +
        '<p class="error" id="th-error" role="alert"></p>' +
        '<div class="th-foot"><button type="button" class="linkbtn" id="th-cancel">Cancel this order</button></div>';
      document.body.appendChild(dlg);
    }
    const $ = id => dlg.querySelector('#' + id);
    let cur = null, timer = null, offerOpen = false;

    function stop() { clearInterval(timer); timer = null; }
    dlg.addEventListener('close', () => { stop(); cur = null; });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); if (e.target.closest('[data-close]')) dlg.close(); });

    const summary = o => o.offer
      ? '<div class="offer"><div><b>' + esc(o.offer.item) + '</b><small>' + esc(COND[o.offer.condition] || o.offer.condition) + ' &middot; ' + o.offer.quantity + ' &times; ' + jmd(o.offer.unitPrice) + '</small></div><div class="offer-total"><small>Total</small><b>' + jmd(o.offer.total) + '</b></div></div>'
      : '';

    function panel(o) {
      const out = [];
      const closed = o.status === 'completed' || o.status === 'cancelled';
      if (role === 'customer') {
        if (o.status === 'chatting') out.push('<p class="th-hint">Chat with the vendor. They will send you an offer with the price. You only pay when you collect the part.</p>');
        if (o.status === 'offered') out.push(summary(o) + '<div class="th-actions"><button class="btn" type="button" data-act="accept">Accept offer</button><button class="btn ghost" type="button" data-act="decline">Decline</button></div>');
        if (o.status === 'accepted') out.push(summary(o) + '<div class="deal"><b>Collect your part</b><p>' + esc(o.vendor.name) + (o.vendor.address ? ', ' + esc(o.vendor.address) : '') + (o.vendor.phone ? '<br>Phone: <a href="tel:' + esc(String(o.vendor.phone).replace(/[^\d+]/g, '')) + '">' + esc(o.vendor.phone) + '</a>' : '') +
          '</p><p>Pay <strong>' + jmd(o.offer.total) + '</strong> to the vendor when you collect it.</p></div>');
        if (o.status === 'completed') {
          out.push(summary(o));
          out.push(o.rating ? '<p class="th-hint">You rated this vendor <span class="rated">' + '★'.repeat(o.rating) + '☆'.repeat(5 - o.rating) + '</span></p>'
            : '<div class="rate" data-value="0"><span>How was the vendor?</span><span role="group" aria-label="Rating out of 5">' + [1, 2, 3, 4, 5].map(n => '<button type="button" class="star" data-star="' + n + '" aria-label="' + n + ' stars">★</button>').join('') + '</span>' +
              '<input class="rate-note" maxlength="500" placeholder="A few words (optional)" aria-label="Your comment"><button type="button" class="btn small" data-act="rate" disabled>Send rating</button></div>');
        }
      } else {
        if (o.status === 'chatting' || o.status === 'offered') {
          if (o.status === 'offered') out.push(summary(o));
          out.push('<div class="th-actions"><button class="btn' + (o.status === 'offered' ? ' ghost' : '') + '" type="button" data-act="offer-toggle">' + (o.status === 'offered' ? 'Change offer' : 'Send an offer') + '</button></div>');
          out.push('<form class="offer-form" id="th-offer" novalidate' + (offerOpen ? '' : ' hidden') + '>' +
            '<label for="of-item">Part you are offering</label><input id="of-item" maxlength="150" placeholder="Brand, part number, what it fits" value="' + esc(o.offer ? o.offer.item : '') + '">' +
            '<div class="row"><div><label for="of-cond">Condition</label><select id="of-cond">' + Object.entries(COND).map(([v, l]) => '<option value="' + v + '"' + (o.offer && o.offer.condition === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>' +
            '<div><label for="of-qty">Quantity</label><input id="of-qty" type="number" min="1" max="50" value="' + (o.offer ? o.offer.quantity : 1) + '"></div>' +
            '<div><label for="of-price">Price of one (J$)</label><input id="of-price" inputmode="decimal" placeholder="8500" value="' + (o.offer ? o.offer.unitPrice : '') + '"></div></div>' +
            '<p class="th-hint" id="of-total"></p><button class="btn" type="submit">Send offer to customer</button></form>');
        }
        if (o.status === 'accepted') out.push(summary(o) + '<div class="deal"><b>The customer accepted. They will collect the part from you.</b><p>Customer: ' + esc(o.customer.name) + (o.customer.phone ? ' &middot; <a href="tel:' + esc(String(o.customer.phone).replace(/[^\d+]/g, '')) + '">' + esc(o.customer.phone) + '</a>' : '') + '</p>' +
          '<p>They pay you <strong>' + jmd(o.offer.total) + '</strong> in person.' + (o.commission ? ' AutoAid commission (' + o.commission.percent + '%): <strong>' + jmd(o.commission.amount) + '</strong>, due once you mark it picked up.' : '') + '</p></div>' +
          (role === 'vendor' ? '<div class="th-actions"><button class="btn" type="button" data-act="complete">Mark picked up and paid</button></div>' : ''));
        if (o.status === 'completed') out.push(summary(o) + (o.commission ? '<p class="th-hint">AutoAid commission (' + o.commission.percent + '%): ' + jmd(o.commission.amount) + (o.commission.settled ? ' &middot; settled' : ' &middot; due') + '.</p>' : '') +
          (o.rating ? '<p class="th-hint">Customer rating <span class="rated">' + '★'.repeat(o.rating) + '☆'.repeat(5 - o.rating) + '</span>' + (o.review ? ' "' + esc(o.review) + '"' : '') + '</p>' : ''));
      }
      if (closed && o.status === 'cancelled') out.push('<p class="th-hint">This order was cancelled.</p>');
      return out.join('');
    }

    function draw(data, keepScroll) {
      const o = data.order;
      const closed = o.status === 'completed' || o.status === 'cancelled';
      $('th-title').textContent = o.part;
      $('th-sub').textContent = (role === 'customer' ? o.vendor.name : o.customer.name + (role === 'admin' ? ' with ' + o.vendor.name : '')) + (o.vehicle ? ' · ' + o.vehicle.name : '');
      $('th-pill').innerHTML = '<span class="pill st-' + esc(o.status === 'chatting' ? 'pending' : o.status === 'offered' ? 'in-progress' : o.status === 'accepted' ? 'in-progress' : o.status) + '">' + esc(STATUS[o.status] || o.status) + '</span>';
      const keepOffer = dlg.querySelector('#th-offer') && !dlg.querySelector('#th-offer').hidden;
      const typing = dlg.querySelector('#th-offer') && dlg.querySelector('#th-offer').contains(document.activeElement);
      if (!(typing && cur && cur.order && cur.order.status === o.status)) { $('th-panel').innerHTML = panel(o); if (keepOffer && dlg.querySelector('#th-offer')) offerOpen = true; }
      const log = $('th-log');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      log.innerHTML = data.messages.map(m => m.from === 'system'
        ? '<div class="pmsg system">' + esc(m.body) + '</div>'
        : '<div class="pmsg ' + m.from + '"><small>' + esc(m.from === 'me' ? 'You' : m.sender) + ' &middot; ' + esc(when(m.createdAt)) + '</small>' + esc(m.body).replace(/\n/g, '<br>') + '</div>').join('');
      if (!keepScroll || atBottom) log.scrollTop = log.scrollHeight;
      $('th-form').hidden = closed || role === 'admin';
      $('th-cancel').hidden = closed || role === 'admin';
      cur = { id: o.id, order: o, last: data.messages.length ? data.messages[data.messages.length - 1].id : 0 };
      updateTotal();
    }

    function updateTotal() {
      const t = dlg.querySelector('#of-total'); if (!t) return;
      const q = Number(dlg.querySelector('#of-qty').value), p = Number(String(dlg.querySelector('#of-price').value).replace(/[,\sJ$]/g, ''));
      t.textContent = q > 0 && p > 0 ? 'Total ' + jmd(q * p) + (commissionPercent ? '. AutoAid commission (' + commissionPercent + '%): ' + jmd(Math.round(q * p * commissionPercent) / 100) + '.' : '') : '';
    }

    async function refresh(keepScroll) {
      if (!cur) return;
      try {
        const data = await api('/parts/orders/' + cur.id);
        const changed = !cur.order || data.order.updatedAt !== cur.order.updatedAt || (data.messages.length ? data.messages[data.messages.length - 1].id : 0) !== cur.last;
        if (changed || !keepScroll) { draw(data, keepScroll); if (onChange) onChange(); }
      } catch (e) { /* the next poll tries again */ }
    }

    async function open(id) {
      $('th-error').textContent = ''; offerOpen = false;
      cur = { id, order: null, last: 0 };
      const data = await api('/parts/orders/' + id);
      draw(data, false);
      if (!dlg.open) dlg.showModal();
      stop(); timer = setInterval(() => { if (!document.hidden) refresh(true); }, 6000);
      if (onChange) onChange();
    }

    async function act(path, body, then) {
      $('th-error').textContent = '';
      try { await api('/parts/orders/' + cur.id + path, { method: 'POST', body: body || {} }); if (then) then(); await refresh(false); }
      catch (err) { $('th-error').textContent = err.message; }
    }

    $('th-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('th-text').value.trim();
      if (!text) return;
      $('th-send').disabled = true;
      try { await api('/parts/orders/' + cur.id + '/messages', { method: 'POST', body: { body: text } }); $('th-text').value = ''; await refresh(false); }
      catch (err) { $('th-error').textContent = err.message; }
      finally { $('th-send').disabled = false; $('th-text').focus(); }
    });
    $('th-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('th-form').requestSubmit(); } });
    $('th-cancel').addEventListener('click', () => { if (confirm('Cancel this order?')) act('/cancel'); });

    dlg.addEventListener('input', (e) => { if (e.target.closest('#th-offer')) updateTotal(); });
    dlg.addEventListener('submit', async (e) => {
      if (e.target.id !== 'th-offer') return;
      e.preventDefault();
      await act('/offer', { item: dlg.querySelector('#of-item').value, condition: dlg.querySelector('#of-cond').value, quantity: Number(dlg.querySelector('#of-qty').value), unitPrice: dlg.querySelector('#of-price').value }, () => { offerOpen = false; });
    });
    dlg.addEventListener('click', (e) => {
      const star = e.target.closest('.star');
      if (star) {
        const box = star.closest('.rate'), n = Number(star.dataset.star);
        box.dataset.value = n;
        box.querySelectorAll('.star').forEach(b => b.classList.toggle('on', Number(b.dataset.star) <= n));
        box.querySelector('[data-act="rate"]').disabled = false;
        return;
      }
      const b = e.target.closest('[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'offer-toggle') { offerOpen = !offerOpen; const f = dlg.querySelector('#th-offer'); if (f) { f.hidden = !offerOpen; if (offerOpen) dlg.querySelector('#of-item').focus(); } }
      else if (a === 'accept') act('/offer/respond', { accept: true });
      else if (a === 'decline') act('/offer/respond', { accept: false });
      else if (a === 'complete') { if (confirm('Mark this order as picked up and paid?')) act('/complete'); }
      else if (a === 'rate') { const box = b.closest('.rate'); act('/rating', { rating: Number(box.dataset.value), review: box.querySelector('.rate-note').value }); }
    });

    function renderList(el, orders, emptyText) {
      if (!orders.length) { el.innerHTML = '<p class="empty">' + esc(emptyText || 'No part orders yet.') + '</p>'; return; }
      el.innerHTML = orders.map(o => '<button class="porder" type="button" data-order="' + o.id + '">' +
        '<span class="tile blue sm"><span class="ic" style="--m: var(--d-doc)"></span></span>' +
        '<span class="p-main"><b>' + esc(o.part) + (o.unread ? '<i class="dot-new" title="New message"></i>' : '') + '</b>' +
          '<small>' + esc(role === 'customer' ? o.vendor.name : o.customer.name + (role === 'admin' ? ' with ' + o.vendor.name : '')) + (o.vehicle ? ' &middot; ' + esc(o.vehicle.name) : '') + '</small>' +
          '<small class="p-last">' + esc(o.lastMessage || '').replace(/\n/g, ' ') + '</small></span>' +
        '<span class="p-side"><span class="pill st-' + esc(o.status === 'chatting' ? 'pending' : o.status === 'offered' || o.status === 'accepted' ? 'in-progress' : o.status) + '">' + esc(STATUS[o.status] || o.status) + '</span>' +
          (o.offer ? '<b>' + jmd(o.offer.total) + '</b>' : '') + '</span></button>').join('');
    }
    return { renderList, open, close: () => dlg.close() };
  }
  window.PartsChat = { create, jmd, esc };
})();
