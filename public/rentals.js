// Shared by the customer app, the vendor page and the admin portal: rental bookings list and the chat window for one booking.
// RentalChat.create({ api, role, commissionPercent, onChange }) -> { renderList(el, bookings, emptyText), open(id), close() }
//   role is 'customer', 'vendor' or 'admin'. api(path, { method, body }) is the page's own fetch helper (adds the sign-in token).
// Also: RentalChat.prepareImage(file) shrinks a photo and returns base64 for the upload routes.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jmd = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });
  const STATUS = { requested: 'Requested', accepted: 'Accepted', picked_up: 'Out on rental', returned: 'Returned', declined: 'Declined', cancelled: 'Cancelled' };
  const PILL = { requested: 'pending', accepted: 'in-progress', picked_up: 'in-progress', returned: 'completed', declined: 'cancelled', cancelled: 'cancelled' };
  // the label on a booking: a returned vehicle that is waiting for the customer's answer, or in dispute, says so
  const stateLabel = b => b.status === 'returned' && b.returnCheck === 'waiting_customer' ? 'Return check' : b.status === 'returned' && b.returnCheck === 'disputed' && b.dispute && !b.dispute.resolvedAt ? 'Dispute' : (STATUS[b.status] || b.status);
  const statePill = b => b.status === 'returned' && (b.returnCheck === 'waiting_customer' || (b.returnCheck === 'disputed' && b.dispute && !b.dispute.resolvedAt)) ? 'pending' : PILL[b.status];
  const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const day = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const range = b => day(b.startDate) + ' to ' + day(b.endDate) + ' · ' + b.days + ' day' + (b.days > 1 ? 's' : '');
  const tel = p => esc(String(p).replace(/[^\d+]/g, ''));

  function prepareImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(blob => {
          if (!blob) return reject(new Error('Could not read that photo. Try another one.'));
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = () => reject(new Error('Could not read that photo. Try another one.'));
          r.readAsDataURL(blob);
        }, 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo we can read. Use a JPEG or PNG picture.')); };
      img.src = url;
    });
  }

  function create({ api, role, onChange }) {
    let dlg = document.getElementById('dlg-rthread');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'modal wide thread'; dlg.id = 'dlg-rthread'; dlg.setAttribute('aria-labelledby', 'th-title');
      dlg.innerHTML =
        '<button class="modal-x" type="button" data-close aria-label="Close">&times;</button>' +
        '<div class="th-head"><div><h2 id="th-title"></h2><p class="th-sub" id="th-sub"></p></div><span id="th-pill"></span></div>' +
        '<div id="th-panel"></div>' +
        '<div class="th-log" id="th-log" role="log" aria-live="polite"></div>' +
        '<form id="th-form" novalidate><textarea id="th-text" rows="2" maxlength="1000" placeholder="Type a message. Enter to send, Shift+Enter for a new line." aria-label="Message"></textarea>' +
        '<button class="btn" id="th-send" type="submit">Send</button></form>' +
        '<p class="error" id="th-error" role="alert"></p>' +
        '<div class="th-foot"><button type="button" class="linkbtn" id="th-cancel">Cancel this booking</button></div>';
      document.body.appendChild(dlg);
    }
    const $ = id => dlg.querySelector('#' + id);
    let cur = null, timer = null;

    function stop() { clearInterval(timer); timer = null; }
    dlg.addEventListener('close', () => { stop(); cur = null; });

    const summary = b => '<div class="offer"><div><b>' + esc(b.vehicle.title) + '</b><small>' + esc(range(b)) + '</small><small>' + jmd(b.dailyRate) + ' a day' + (b.deposit ? ' &middot; deposit ' + jmd(b.deposit) : '') + '</small></div>' +
      '<div class="offer-total"><small>Rent</small><b>' + jmd(b.total) + '</b></div></div>';
    const stars = n => '<span class="rated">' + '★'.repeat(n) + '☆'.repeat(5 - n) + '</span>';

    // overdue notice, late fee, and the condition check when the vehicle comes back
    function returnPanel(b) {
      const parts = [];
      const s = n => n + ' day' + (n > 1 ? 's' : '');
      if (b.overdue) parts.push('<div class="deal late"><b>Overdue by ' + s(b.overdue.days) + '</b><p>Each extra day is charged at ' + jmd(b.dailyRate) + ' (so far ' + jmd(b.overdue.fee) + '), as agreed in the Rental Agreement. ' + (role === 'customer' ? 'Please return the vehicle now or talk to the vendor.' : '') + '</p></div>');
      if (b.status !== 'returned') return parts.join('');
      const r = b.returnReport || {};
      if (b.late) parts.push('<p class="th-hint">Late return: ' + s(b.late.days) + ' extra, <strong>' + jmd(b.late.fee) + '</strong> &middot; ' + ({ due: 'due (AutoAid 24/7 will arrange the charge)', charged: 'charged', waived: 'waived' }[b.late.status] || '') + (b.late.note ? ' &middot; ' + esc(b.late.note) : '') + '</p>');
      if (b.returnCheck === 'waiting_customer') {
        parts.push(role === 'customer'
          ? '<div class="deal"><b>Please confirm the return</b><p>The vendor says the vehicle came back in the same condition' + (r.vendorNote ? ': &ldquo;' + esc(r.vendorNote) + '&rdquo;' : '') + '. Do you agree?</p><div class="th-actions"><button class="btn" type="button" data-act="check-agree">Yes, same condition</button><button class="btn ghost" type="button" data-act="check-disagree">No, I disagree</button></div></div>'
          : '<p class="th-hint">Waiting for the customer to confirm the vehicle came back in the same condition (taken as agreed after 3 days).</p>');
      }
      if (b.returnCheck === 'agreed') parts.push('<p class="th-hint">Both sides agree the vehicle came back in the same condition.</p>');
      if (b.returnCheck === 'disputed') {
        const resolved = b.dispute && b.dispute.resolvedAt;
        parts.push('<div class="deal late"><b>' + (resolved ? 'Dispute decided' : 'Dispute filed') + '</b>' +
          (r.vendorOk === false ? '<p>Vendor reported a problem: ' + esc(r.vendorNote) + '</p>' : '') +
          (r.customerOk === false ? '<p>Customer disagrees: ' + esc(r.customerNote) + '</p>' : '') +
          '<p>' + (resolved ? 'Decision: ' + esc(b.dispute.outcome) : 'AutoAid 24/7 will contact the customer and the vendor. You can add details in the chat below.') + '</p></div>');
        if (role === 'admin' && !resolved) parts.push('<div class="th-actions"><button class="btn" type="button" data-act="resolve">Record the decision</button></div>');
      }
      if (role === 'admin' && b.late && b.late.status === 'due') parts.push('<div class="th-actions"><button class="btn" type="button" data-act="late-charged">Late fee charged</button><button class="btn ghost" type="button" data-act="late-waived">Waive the late fee</button></div>');
      return parts.join('');
    }

    function panel(b) {
      const out = [summary(b)];
      if (role === 'customer') {
        if (b.status === 'requested') out.push('<p class="th-hint">Waiting for ' + esc(b.vendor.name) + ' to accept. You can chat with them meanwhile. Nothing is charged online: you pay the vendor in person.</p>');
        if (b.status === 'accepted') out.push('<div class="deal"><b>Your rental is confirmed</b><p>Collect it on <strong>' + esc(day(b.startDate)) + '</strong> from ' + esc(b.vendor.name) + (b.vendor.address ? ', ' + esc(b.vendor.address) : '') + (b.vendor.phone ? '<br>Phone: <a href="tel:' + tel(b.vendor.phone) + '">' + esc(b.vendor.phone) + '</a>' : '') + '</p><p>Bring your driver\'s licence. Pay the vendor <strong>' + jmd(b.total) + '</strong>' + (b.deposit ? ' plus the <strong>' + jmd(b.deposit) + '</strong> deposit' : '') + ' in person.</p><p>You agreed the vendor may charge you for any damage or loss' + (b.deposit ? ', up to the deposit,' : '') + ' using the card or deposit you give at pick-up.</p></div>');
        if (b.status === 'picked_up') out.push('<div class="deal"><b>The vehicle is with you</b><p>Return it by <strong>' + esc(day(b.endDate)) + '</strong> to ' + esc(b.vendor.name) + (b.vendor.phone ? '. Phone: <a href="tel:' + tel(b.vendor.phone) + '">' + esc(b.vendor.phone) + '</a>' : '') + '.</p></div>');
        if (b.status === 'returned') out.push(b.rating ? '<p class="th-hint">You rated this vendor ' + stars(b.rating) + '</p>'
          : '<div class="rate" data-value="0"><span>How was the rental?</span><span role="group" aria-label="Rating out of 5">' + [1, 2, 3, 4, 5].map(n => '<button type="button" class="star" data-star="' + n + '" aria-label="' + n + ' stars">★</button>').join('') + '</span>' +
            '<input class="rate-note" maxlength="500" placeholder="A few words (optional)" aria-label="Your comment"><button type="button" class="btn small" data-act="rate" disabled>Send rating</button></div>');
      } else {
        out.push('<p class="th-hint">Customer: <strong>' + esc(b.customer.name) + '</strong>' + (b.customer.phone ? ' &middot; <a href="tel:' + tel(b.customer.phone) + '">' + esc(b.customer.phone) + '</a>' : '') + (role === 'admin' ? ' &middot; vendor ' + esc(b.vendor.name) : '') + (b.note ? '<br>Note: ' + esc(b.note) : '') + (b.damageAuthorized ? '<br>The customer agreed you may charge them for damage or loss' + (b.deposit ? ' up to the ' + jmd(b.deposit) + ' deposit' : '') + ', using the card or deposit they give you at pick-up.' : '') + '</p>');
        const showLic = role !== 'customer' && ['accepted', 'picked_up', 'returned'].includes(b.status) && b.customer.hasLicence;
        if (showLic) out.push('<div class="th-actions"><button class="btn ghost small" type="button" data-act="licence">View driver\'s licence</button></div>');
        if (role === 'vendor') {
          if (b.status === 'requested') out.push('<div class="th-actions"><button class="btn" type="button" data-act="accept">Accept booking</button><button class="btn ghost" type="button" data-act="decline">Decline</button></div>');
          if (b.status === 'accepted') out.push('<div class="th-actions"><button class="btn" type="button" data-act="pickup">Mark handed over</button></div>');
          if (b.status === 'picked_up') out.push('<div class="th-actions"><button class="btn" type="button" data-act="return-good">Returned in the same condition</button><button class="btn ghost" type="button" data-act="return-problem">Returned with a problem</button></div>');
        }
        if (b.commission) out.push('<p class="th-hint">AutoAid commission (' + b.commission.percent + '% of the rent): ' + jmd(b.commission.amount) + (b.status === 'returned' ? (b.commission.settled ? ' &middot; settled' : ' &middot; due') : ' &middot; counted once the vehicle is returned') + '.</p>');
        if (b.status === 'returned' && b.rating) out.push('<p class="th-hint">Customer rating ' + stars(b.rating) + (b.review ? ' "' + esc(b.review) + '"' : '') + '</p>');
      }
      out.push(returnPanel(b));
      if (b.status === 'declined' || b.status === 'cancelled') out.push('<p class="th-hint">This booking was ' + b.status + '.</p>');
      return out.join('');
    }

    function draw(data, keepScroll) {
      const b = data.order;
      const closed = b.open === false;
      $('th-title').textContent = b.vehicle.title;
      $('th-sub').textContent = (role === 'customer' ? b.vendor.name : b.customer.name + (role === 'admin' ? ' with ' + b.vendor.name : '')) + ' · ' + range(b);
      $('th-pill').innerHTML = '<span class="pill st-' + statePill(b) + '">' + esc(stateLabel(b)) + '</span>';
      $('th-panel').innerHTML = panel(b);
      const log = $('th-log');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      log.innerHTML = data.messages.map(m => m.from === 'system'
        ? '<div class="pmsg system">' + esc(m.body) + '</div>'
        : '<div class="pmsg ' + m.from + '"><small>' + esc(m.from === 'me' ? 'You' : m.sender) + ' &middot; ' + esc(when(m.createdAt)) + '</small>' + esc(m.body).replace(/\n/g, '<br>') + '</div>').join('');
      if (!keepScroll || atBottom) log.scrollTop = log.scrollHeight;
      $('th-form').hidden = closed || role === 'admin';
      $('th-cancel').hidden = !['requested', 'accepted'].includes(b.status) || role === 'admin' || (role === 'vendor' && b.status === 'requested');
      cur = { id: b.id, order: b, last: data.messages.length ? data.messages[data.messages.length - 1].id : 0 };
    }

    async function refresh(keepScroll) {
      if (!cur) return;
      try {
        const data = await api('/rentals/bookings/' + cur.id);
        const last = data.messages.length ? data.messages[data.messages.length - 1].id : 0;
        if (!cur.order || data.order.updatedAt !== cur.order.updatedAt || last !== cur.last || !keepScroll) { draw(data, keepScroll); if (onChange) onChange(); }
      } catch (e) { /* the next poll tries again */ }
    }

    async function open(id) {
      $('th-error').textContent = '';
      cur = { id, order: null, last: 0 };
      const data = await api('/rentals/bookings/' + id);
      draw(data, false);
      if (!dlg.open) dlg.showModal();
      stop(); timer = setInterval(() => { if (!document.hidden) refresh(true); }, 6000);
      if (onChange) onChange();
    }

    async function act(path, body) {
      $('th-error').textContent = '';
      try { await api('/rentals/bookings/' + cur.id + path, { method: 'POST', body: body || {} }); await refresh(false); }
      catch (err) { $('th-error').textContent = err.message; }
    }

    dlg.addEventListener('click', async (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) { dlg.close(); return; }
      const star = e.target.closest('.star');
      if (star) {
        const box = star.closest('.rate'), n = Number(star.dataset.star);
        box.dataset.value = n;
        box.querySelectorAll('.star').forEach(b => b.classList.toggle('on', Number(b.dataset.star) <= n));
        box.querySelector('[data-act="rate"]').disabled = false;
        return;
      }
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const a = btn.dataset.act;
      if (a === 'accept') act('/accept');
      else if (a === 'decline') { const why = prompt('Reason for declining (optional):'); if (why !== null) act('/decline', { reason: why }); }
      else if (a === 'pickup') { if (confirm('Mark the vehicle as handed over to the customer?')) act('/pickup'); }
      else if (a === 'return-good') { const note = prompt('Any note on the fuel level or condition? (optional)'); if (note !== null) act('/return', { condition: 'good', note }); }
      else if (a === 'return-problem') { const note = prompt('Describe the problem (damage, missing items, fuel, dirt). AutoAid 24/7 will contact both of you.'); if (note) act('/return', { condition: 'problem', note }); }
      else if (a === 'check-agree') { if (confirm('Do you agree the vehicle came back in the same condition it was given to you?')) act('/return-check', { agree: true }); }
      else if (a === 'check-disagree') { const note = prompt('What do you disagree with? AutoAid 24/7 will contact both of you.'); if (note) act('/return-check', { agree: false, note }); }
      else if (a === 'resolve') { const outcome = prompt('Record the decision (what was decided, and what each side is charged or refunded):'); if (outcome) act('/resolve', { outcome }); }
      else if (a === 'late-charged') { const note = prompt('Note (optional), e.g. the card payment reference:'); if (note !== null) act('/late-fee', { status: 'charged', note }); }
      else if (a === 'late-waived') { const note = prompt('Why is it waived? (optional)'); if (note !== null) act('/late-fee', { status: 'waived', note }); }
      else if (a === 'rate') { const box = btn.closest('.rate'); act('/rating', { rating: Number(box.dataset.value), review: box.querySelector('.rate-note').value }); }
      else if (a === 'licence') {
        try { const r = await api('/rentals/bookings/' + cur.id + '/licence'); window.open(r.url, '_blank', 'noopener'); }
        catch (err) { $('th-error').textContent = err.message; }
      }
    });
    $('th-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('th-text').value.trim();
      if (!text) return;
      $('th-send').disabled = true;
      try { await api('/rentals/bookings/' + cur.id + '/messages', { method: 'POST', body: { body: text } }); $('th-text').value = ''; await refresh(false); }
      catch (err) { $('th-error').textContent = err.message; }
      finally { $('th-send').disabled = false; $('th-text').focus(); }
    });
    $('th-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('th-form').requestSubmit(); } });
    $('th-cancel').addEventListener('click', () => { if (confirm('Cancel this booking?')) act('/cancel'); });

    function renderList(el, bookings, emptyText) {
      if (!bookings.length) { el.innerHTML = '<p class="empty">' + esc(emptyText || 'No rentals yet.') + '</p>'; return; }
      el.innerHTML = bookings.map(b => '<button class="porder" type="button" data-booking="' + b.id + '">' +
        '<span class="tile blue sm"><span class="ic" style="--m: var(--d-car)"></span></span>' +
        '<span class="p-main"><b>' + esc(b.vehicle.title) + (b.unread ? '<i class="dot-new" title="New message"></i>' : '') + '</b>' +
          '<small>' + esc(role === 'customer' ? b.vendor.name : b.customer.name + (role === 'admin' ? ' with ' + b.vendor.name : '')) + ' &middot; ' + esc(range(b)) + '</small>' +
          '<small class="p-last">' + esc(b.lastMessage || '').replace(/\n/g, ' ') + '</small></span>' +
        '<span class="p-side"><span class="pill st-' + statePill(b) + '">' + esc(stateLabel(b)) + '</span><b>' + jmd(b.total) + '</b></span></button>').join('');
    }
    return { renderList, open, close: () => dlg.close() };
  }
  window.RentalChat = { create, prepareImage, jmd, esc };
})();
