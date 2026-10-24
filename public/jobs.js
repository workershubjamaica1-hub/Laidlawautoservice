// Live jobs, shared by the customer app and the technician portal:
//   JobAlerts  the loud new-job sound, vibration, flashing title and browser notification
//   JobChat    the job window: waiting screen, chat, price and arrival time, arrived/done/confirm
// JobChat.create({ api, role, shopPhone, onChange }) -> { open(id), close(), renderList(el, jobs, emptyText) }   role is 'customer', 'staff' or 'admin'
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jmd = n => 'J$' + Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 });
  const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const clock = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const tel = p => esc(String(p).replace(/[^\d+]/g, ''));
  const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

  // ------------------------------------------------------------ alerts
  const JobAlerts = (function () {
    let ctx = null, ringTimer = null, flashTimer = null, stopTimer = null, baseTitle = '';
    function audio() {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { try { ctx = new AC(); } catch (_) {} } }
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(freq, at, dur, vol, type) {
      const c = ctx; if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(c.destination); o.start(at); o.stop(at + dur + 0.02);
    }
    function siren() {
      if (!audio()) return;
      const t = ctx.currentTime;
      for (let i = 0; i < 3; i++) { tone(960, t + i * 0.55, 0.26, 0.85); tone(720, t + i * 0.55 + 0.28, 0.26, 0.85); }
      try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (_) {}
    }
    function chime() {       // a short friendly sound for the customer
      if (!audio()) return;
      const t = ctx.currentTime; tone(660, t, 0.18, 0.3, 'sine'); tone(880, t + 0.2, 0.3, 0.3, 'sine');
    }
    function stop() {
      clearInterval(ringTimer); clearInterval(flashTimer); clearTimeout(stopTimer); ringTimer = flashTimer = stopTimer = null;
      if (baseTitle) { document.title = baseTitle; baseTitle = ''; }
      try { if (navigator.vibrate) navigator.vibrate(0); } catch (_) {}
    }
    function start(label) {
      stop();
      baseTitle = document.title; let on = false;
      siren(); ringTimer = setInterval(siren, 2400);
      flashTimer = setInterval(() => { on = !on; document.title = on ? '\u{1F6A8} ' + (label || 'NEW JOB') : baseTitle; }, 700);
      stopTimer = setTimeout(stop, 90000);   // never ring forever
    }
    function notify(title, body) {
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: 'autoaid-job', requireInteraction: true }); } catch (_) {}
    }
    function askPermission() { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {} }
    return { unlock: audio, start, stop, siren, chime, notify, askPermission, ringing: () => !!ringTimer, isReady: () => !!ctx && ctx.state === 'running' };
  })();

  // ------------------------------------------------------------ the job window
  const STAGE = { searching: 'Finding a technician', matched: 'Chatting', quoted: 'Price sent', agreed: 'Booked', working: 'Working', done_pending: 'Please confirm', closed: 'Completed', cancelled: 'Cancelled' };
  const PILL = { searching: 'pending', matched: 'pending', quoted: 'pending', agreed: 'in-progress', working: 'in-progress', done_pending: 'in-progress', closed: 'completed', cancelled: 'cancelled' };
  let categories = null;
  async function catLabel(c) {
    if (!categories) { try { categories = Object.fromEntries((await (await fetch('/categories')).json()).service.map(x => [x.value, x.label])); } catch (_) { categories = {}; } }
    return categories[c] || c;
  }
  const mapsLink = o => o.hasCoords || o.latitude != null ? 'https://www.google.com/maps?q=' + o.latitude + ',' + o.longitude : 'https://www.google.com/maps/search/' + encodeURIComponent(o.locationText + ', ' + o.parish + ', Jamaica');

  function create({ api, role, shopPhone: shopPhoneOpt, onChange }) {
    const shopPhone = () => (typeof shopPhoneOpt === 'function' ? shopPhoneOpt() : shopPhoneOpt) || '';
    let dlg = document.getElementById('dlg-jthread');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'modal wide thread'; dlg.id = 'dlg-jthread'; dlg.setAttribute('aria-labelledby', 'th-title');
      dlg.innerHTML =
        '<button class="modal-x" type="button" data-close aria-label="Close">&times;</button>' +
        '<div class="th-head"><div><h2 id="th-title"></h2><p class="th-sub" id="th-sub"></p></div><span id="th-pill"></span></div>' +
        '<div id="th-panel"></div>' +
        '<div class="th-log" id="th-log" role="log" aria-live="polite"></div>' +
        '<form id="th-form" novalidate><textarea id="th-text" rows="2" maxlength="1000" placeholder="Type a message. Enter to send, Shift+Enter for a new line." aria-label="Message"></textarea>' +
        '<button class="btn" id="th-send" type="submit">Send</button></form>' +
        '<p class="error" id="th-error" role="alert"></p>';
      document.body.appendChild(dlg);
    }
    const $ = id => dlg.querySelector('#' + id);
    let cur = null, timer = null, tick = null, lastStage = null;
    const isCustomer = role === 'customer', isTech = role === 'staff';

    function stop() { clearInterval(timer); clearInterval(tick); timer = tick = null; }
    dlg.addEventListener('close', () => { stop(); cur = null; lastStage = null; });

    function countdowns() {
      dlg.querySelectorAll('[data-until]').forEach(el => {
        const left = Date.parse(el.dataset.until) - Date.now();
        el.textContent = left >= 0 ? mmss(left) : 'late by ' + mmss(-left);
        el.classList.toggle('late', left < 0);
      });
      dlg.querySelectorAll('[data-since]').forEach(el => { el.textContent = mmss(Date.now() - Date.parse(el.dataset.since)); });
    }

    const summary = (o, dept) => '<div class="offer"><div><b>' + esc(dept) + ' &middot; ' + esc(o.vehicle ? o.vehicle.name : '') + '</b><small>' + esc(o.description) + '</small>' +
      '<small>' + esc(o.locationText ? 'At: ' + o.locationText : '') + (o.parish ? ' (' + esc(o.parish) + ')' : '') + '</small></div></div>';
    const quoteCard = o => o.quote ? '<div class="offer"><div><b>Price: ' + jmd(o.quote.amount) + (o.premiumPerk ? ' (parts and extras)' : '') + '</b><small>Arrives within ' + o.quote.etaMinutes + ' minutes after you agree</small>' + (o.quote.note ? '<small>' + esc(o.quote.note) + '</small>' : '') + '</div></div>' : '';

    function quoteForm(o) {
      const etas = [15, 30, 45, 60, 90, 120, 180, 240];
      return '<form class="offer-form" id="th-quote" novalidate><label for="q-amount">' + (o.premiumPerk ? 'Parts and extras the customer pays (J$, 0 if none)' : 'Your price for this job (J$)') + '</label>' +
        '<input id="q-amount" inputmode="decimal" placeholder="6500" value="' + (o.quote ? o.quote.amount : '') + '">' +
        '<div class="row"><div><label for="q-eta">I will arrive within</label><select id="q-eta">' + etas.map(m => '<option value="' + m + '"' + ((o.quote ? o.quote.etaMinutes : 45) === m ? ' selected' : '') + '>' + (m < 60 ? m + ' minutes' : (m / 60) + (m === 60 ? ' hour' : ' hours')) + '</option>').join('') + '</select></div>' +
        '<div><label for="q-note">Note (optional)</label><input id="q-note" maxlength="300" placeholder="What the price covers" value="' + esc(o.quote ? o.quote.note : '') + '"></div></div>' +
        '<p class="th-hint" id="q-fee"></p><button class="btn" type="submit">' + (o.stage === 'quoted' ? 'Send a new price' : 'Send price and arrival time') + '</button></form>';
    }

    function panel(o, dept) {
      const out = [];
      const phone = isCustomer ? (o.technician && o.technician.phone) : (o.customer && o.customer.phone);
      if (isCustomer) {
        if (o.stage === 'searching') {
          out.push('<div class="finding"><div class="spin" aria-hidden="true"></div><div><b>Finding a ' + esc(dept.toLowerCase()) + ' technician near you</b>' +
            '<p>Waiting <span data-since="' + esc(o.createdAt) + '">0:00</span>. The first available technician will accept and chat with you here. Keep this window open.</p>' +
            '<p class="th-hint">' + (o.onlineTechs > 0 ? '<strong>' + o.onlineTechs + '</strong> technician' + (o.onlineTechs > 1 ? 's are' : ' is') + ' online for this department right now.' :
              'No technician is online for this department at the moment. We will keep looking.' + (shopPhone() ? ' You can also call the shop: <a href="tel:' + tel(shopPhone()) + '">' + esc(shopPhone()) + '</a>.' : '')) + '</p></div></div>');
          out.push(summary(o, dept)); out.push('<div class="th-actions"><button class="btn ghost" type="button" data-act="cancel">Cancel request</button></div>');
        }
        if (o.stage === 'matched') { out.push(summary(o, dept)); out.push('<p class="th-hint"><strong>' + esc(o.technician.name) + '</strong> accepted your request. Chat below and describe the problem. They will send you a price and an arrival time.</p><div class="th-actions"><button class="btn ghost small" type="button" data-act="change">Ask for a different technician</button></div>'); }
        if (o.stage === 'quoted') {
          const pay = o.payUrl
            ? '<p class="th-hint">Pay securely on Fygaro. <strong>AutoAid 24/7 holds your payment</strong> and only pays <strong>' + esc(o.technician.name) + '</strong> after you confirm the job is done. If it does not go ahead, you are refunded.</p>' +
              '<div class="th-actions"><a class="btn" href="' + esc(o.payUrl) + '" target="_blank" rel="noopener">Agree and pay ' + jmd(o.quote.amount) + ' securely</a><button class="btn ghost" type="button" data-act="decline">Not this price</button><button class="btn ghost small" type="button" data-act="change">Different technician</button></div>' +
              '<p class="th-hint">After you pay, come back to this window. It updates by itself.</p>'
            : '<p class="th-hint">You pay <strong>' + esc(o.technician.name) + '</strong> in person when the job is done. Nothing is charged online.</p>' +
              '<div class="th-actions"><button class="btn" type="button" data-act="agree">Agree and book</button><button class="btn ghost" type="button" data-act="decline">Not this price</button><button class="btn ghost small" type="button" data-act="change">Different technician</button></div>';
          out.push(quoteCard(o) + pay);
        }
        if (o.stage === 'agreed') {
          out.push('<div class="deal"><b>Booked: ' + esc(o.technician.name) + ' is coming to you</b><p>Expected in <strong class="countdown" data-until="' + esc(o.etaDeadline) + '"></strong> (by ' + clock(o.etaDeadline) + ').' +
            (phone ? ' Phone: <a href="tel:' + tel(phone) + '">' + esc(phone) + '</a>.' : '') + '</p><p>' + (o.paid ? 'You paid <strong>' + jmd(o.paidAmount) + '</strong>. AutoAid 24/7 holds it until you confirm the job is done.' : 'Price: <strong>' + jmd(o.quote.amount) + '</strong>, paid to the technician in person.') + '</p></div>' +
            '<div class="th-actions"><button class="btn ghost small" type="button" data-act="cancel">Cancel this job</button></div>');
        }
        if (o.stage === 'working') out.push('<div class="deal"><b>' + esc(o.technician.name) + ' has arrived and is working on your vehicle</b>' + (phone ? '<p>Phone: <a href="tel:' + tel(phone) + '">' + esc(phone) + '</a></p>' : '') + '</div>');
        if (o.stage === 'done_pending') out.push('<div class="deal"><b>The technician says the job is done</b><p>' + (o.paid ? 'Check the work. When you confirm, AutoAid 24/7 pays the technician from your payment.' : 'Check the work, pay <strong>' + jmd(o.quote ? o.quote.amount : 0) + '</strong> to the technician in person, then confirm.') + '</p></div>' +
          (o.disputed ? '<p class="th-hint"><strong>You reported a problem.</strong> AutoAid 24/7 is looking into it' + (o.paid ? ' and your payment is held' : '') + '. You will be contacted.</p>' : '') +
          '<div class="th-actions"><button class="btn" type="button" data-act="confirm">Confirm the job is complete</button>' + (o.disputed ? '' : '<button class="btn ghost" type="button" data-act="dispute">Report a problem</button>') + '</div>');
        if (o.stage === 'closed') out.push('<div class="deal"><b>Job complete</b><p>' + (o.amount != null ? 'Price: ' + jmd(o.amount) + (o.paid ? ' (paid online)' : '') + '. ' : '') + 'Thank you for using AutoAid 24/7.</p></div>' + (o.rating ? '<p class="th-hint">You rated this job <span class="rated">' + '★'.repeat(o.rating) + '☆'.repeat(5 - o.rating) + '</span></p>' :
          '<div class="rate" data-value="0"><span>How was it?</span><span role="group" aria-label="Rating out of 5">' + [1, 2, 3, 4, 5].map(n => '<button type="button" class="star" data-star="' + n + '" aria-label="' + n + ' stars">★</button>').join('') + '</span><input class="rate-note" maxlength="500" placeholder="A few words (optional)" aria-label="Your comment"><button type="button" class="btn small" data-act="rate" disabled>Send rating</button></div>'));
      } else {
        out.push(summary(o, dept));
        if (['agreed', 'working', 'done_pending'].includes(o.stage)) {
          out.push('<div class="deal"><b>Customer: ' + esc(o.customer.name) + '</b><p>' + (phone ? 'Phone: <a href="tel:' + tel(phone) + '">' + esc(phone) + '</a>. ' : '') + 'Location: ' + esc(o.locationText) + ' (<a href="' + mapsLink(o) + '" target="_blank" rel="noopener">open in maps</a>)</p>' +
            (o.paid ? '<p><strong>The customer has paid ' + jmd(o.paidAmount) + ' online.</strong> Do not take cash. After they confirm the job you are paid <strong>' + jmd(o.paidAmount - (o.fee ? o.fee.amount : 0)) + '</strong> (price minus the AutoAid fee of ' + (o.fee ? o.fee.percent : 0) + '%).</p>'
              : '<p>Agreed price <strong>' + jmd(o.quote.amount) + '</strong>, collected in person.' + (o.fee ? ' AutoAid fee (' + o.fee.percent + '%): <strong>' + jmd(o.fee.amount) + '</strong>, counted once the customer confirms.' : '') + '</p>') +
            (o.stage === 'agreed' ? '<p>You promised to arrive in <strong class="countdown" data-until="' + esc(o.etaDeadline) + '"></strong> (by ' + clock(o.etaDeadline) + ').</p>' : '') + '</div>');
        }
        if (o.stage === 'matched' || o.stage === 'quoted') {
          out.push(quoteForm(o));
          out.push('<div class="th-actions"><button class="btn ghost small" type="button" data-act="release">Step back from this job</button></div>');
        }
        if (o.stage === 'agreed') out.push('<div class="th-actions"><button class="btn" type="button" data-act="arrived">I have arrived</button><button class="btn ghost" type="button" data-act="done">Mark the job done</button><button class="btn ghost small" type="button" data-act="release">I cannot make it</button></div>');
        if (o.stage === 'working') out.push('<div class="th-actions"><button class="btn" type="button" data-act="done">Mark the job done</button></div>');
        if (o.stage === 'done_pending') out.push('<p class="th-hint">' + (o.paid ? 'Waiting for the customer to confirm. Their payment is held by AutoAid 24/7 and is released to you once they confirm.' : 'Waiting for the customer to confirm. Collect <strong>' + jmd(o.quote ? o.quote.amount : 0) + '</strong> from them in person.') + '</p>' + (o.disputed ? '<div class="deal"><b>The customer reported a problem</b><p>' + esc(o.disputeNote) + '</p><p>AutoAid 24/7 will contact you both. The payment stays held until then.</p></div>' : ''));
        if (o.stage === 'closed') out.push('<p class="th-hint">Job complete' + (o.payout ? '. Your payout: <strong>' + jmd(o.payout.amount) + '</strong>' + (o.payout.settled ? ' (paid to you)' : ' (AutoAid will transfer it to your bank account)') : o.fee ? '. AutoAid fee: ' + jmd(o.fee.amount) + (o.fee.settled ? ' (settled)' : ' (due)') : '') + '.' + (o.rating ? ' Customer rating: <span class="rated">' + '★'.repeat(o.rating) + '☆'.repeat(5 - o.rating) + '</span>' : '') + '</p>');
      }
      if (o.stage === 'cancelled') out.push('<p class="th-hint">This job was cancelled.</p>');
      return out.join('');
    }

    async function draw(data, keepScroll) {
      const o = data.order, dept = await catLabel(o.category);
      const chatOpen = ['matched', 'quoted', 'agreed', 'working', 'done_pending'].includes(o.stage);
      $('th-title').textContent = dept + (o.vehicle ? ': ' + o.vehicle.name : '');
      $('th-sub').textContent = isCustomer ? (o.technician ? o.technician.name : 'Waiting for a technician') : (o.customer ? o.customer.name : '') + ' · ' + when(o.createdAt);
      $('th-pill').innerHTML = '<span class="pill st-' + PILL[o.stage] + '">' + esc(STAGE[o.stage] || o.stage) + '</span>';
      const typing = dlg.querySelector('#th-quote') && dlg.querySelector('#th-quote').contains(document.activeElement);
      if (!(typing && cur && cur.order && cur.order.stage === o.stage)) $('th-panel').innerHTML = panel(o, dept);
      const log = $('th-log'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      log.hidden = !chatOpen && !data.messages.length;
      log.innerHTML = data.messages.map(m => m.from === 'system'
        ? '<div class="pmsg system">' + esc(m.body) + '</div>'
        : '<div class="pmsg ' + m.from + '"><small>' + esc(m.from === 'me' ? 'You' : m.sender) + ' &middot; ' + esc(when(m.createdAt)) + '</small>' + esc(m.body).replace(/\n/g, '<br>') + '</div>').join('');
      if (!keepScroll || atBottom) log.scrollTop = log.scrollHeight;
      $('th-form').hidden = !chatOpen || role === 'admin';
      if (isCustomer && lastStage && lastStage !== o.stage && ['matched', 'quoted', 'done_pending'].includes(o.stage)) JobAlerts.chime();
      lastStage = o.stage;
      cur = { id: o.id, order: o, last: data.messages.length ? data.messages[data.messages.length - 1].id : 0 };
      countdowns();
      const fee = dlg.querySelector('#q-fee'), amt = dlg.querySelector('#q-amount');
      if (fee && amt) { const upd = () => { const v = Number(String(amt.value).replace(/[,\sJ$]/g, '')); fee.textContent = v > 0 && !o.premiumPerk ? 'AutoAid fee ' + (data.feePercent || 5) + '%: ' + jmd(Math.round(v * (data.feePercent || 5)) / 100) + ' (you keep ' + jmd(v - Math.round(v * (data.feePercent || 5)) / 100) + ').' + (data.onlinePayment ? ' The customer pays online first, and you are paid after they confirm.' : ' The customer pays you in person.') : ''; }; amt.addEventListener('input', upd); upd(); }
    }

    async function refresh(keepScroll) {
      if (!cur) return;
      try {
        const data = await api('/jobs/' + cur.id);
        const last = data.messages.length ? data.messages[data.messages.length - 1].id : 0;
        if (!cur.order || data.order.updatedAt !== cur.order.updatedAt || last !== cur.last || data.order.onlineTechs !== cur.order.onlineTechs || !keepScroll) { await draw(data, keepScroll); if (onChange) onChange(); }
      } catch (e) { /* the next poll tries again */ }
    }

    async function open(id) {
      $('th-error').textContent = '';
      cur = { id, order: null, last: 0 }; lastStage = null;
      const data = await api('/jobs/' + id);
      await draw(data, false);
      if (!dlg.open) dlg.showModal();
      stop(); timer = setInterval(() => refresh(true), 3000); tick = setInterval(countdowns, 1000);
      if (onChange) onChange();
    }

    async function act(path, body) {
      $('th-error').textContent = '';
      try { await api(path.startsWith('/service-request') ? path : '/jobs/' + cur.id + path, { method: 'POST', body: body || {} }); await refresh(false); }
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
      if (a === 'agree') act('/quote/respond', { accept: true });
      else if (a === 'decline') act('/quote/respond', { accept: false });
      else if (a === 'change') { if (confirm('Ask for a different technician? This one will be removed from your job.')) act('/change-technician'); }
      else if (a === 'cancel') { if (confirm(cur && cur.order && cur.order.paid ? 'Cancel this job? Your payment will be refunded.' : 'Cancel this job?')) act('/cancel'); }
      else if (a === 'dispute') { const note = prompt('What went wrong? (The payment is held while we look into it.)'); if (note) act('/dispute', { note }); }
      else if (a === 'confirm') { if (confirm('Confirm that the job is complete?')) act('/confirm'); }
      else if (a === 'release') { if (confirm(cur && cur.order && cur.order.paid ? 'Step back? The job ends and the customer is refunded.' : 'Step back from this job? It goes out to other technicians.')) act('/release'); }
      else if (a === 'arrived') act('/arrived');
      else if (a === 'done') { if (confirm('Mark this job as done?')) act('/done'); }
      else if (a === 'rate') { const box = btn.closest('.rate'); act('/service-request/' + cur.id + '/rating', { rating: Number(box.dataset.value), review: box.querySelector('.rate-note').value }); }
    });
    dlg.addEventListener('submit', async (e) => {
      if (e.target.id === 'th-quote') {
        e.preventDefault();
        act('/quote', { amount: dlg.querySelector('#q-amount').value, etaMinutes: Number(dlg.querySelector('#q-eta').value), note: dlg.querySelector('#q-note').value });
      }
    });
    $('th-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('th-text').value.trim();
      if (!text) return;
      $('th-send').disabled = true;
      try { await api('/jobs/' + cur.id + '/messages', { method: 'POST', body: { body: text } }); $('th-text').value = ''; await refresh(false); }
      catch (err) { $('th-error').textContent = err.message; }
      finally { $('th-send').disabled = false; $('th-text').focus(); }
    });
    $('th-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('th-form').requestSubmit(); } });

    async function renderList(el, jobs, emptyText) {
      if (!jobs.length) { el.innerHTML = '<p class="empty">' + esc(emptyText || 'No jobs yet.') + '</p>'; return; }
      const labels = await Promise.all(jobs.map(j => catLabel(j.category)));
      el.innerHTML = jobs.map((j, i) => '<button class="porder" type="button" data-job="' + j.id + '">' +
        '<span class="tile blue sm"><span class="ic" style="--m: var(--d-wrench)"></span></span>' +
        '<span class="p-main"><b>' + esc(labels[i]) + (j.vehicle ? ': ' + esc(j.vehicle.name) : '') + (j.unread ? '<i class="dot-new" title="New message"></i>' : '') + '</b>' +
          '<small>' + esc(isCustomer ? (j.technician ? j.technician.name : 'Finding a technician') : (j.customer ? j.customer.name : '') + (j.locationText ? ' · ' + j.locationText : '')) + '</small>' +
          '<small class="p-last">' + esc(j.description) + '</small></span>' +
        '<span class="p-side"><span class="pill st-' + PILL[j.stage] + '">' + esc(STAGE[j.stage] || j.stage) + '</span>' + (j.quote ? '<b>' + jmd(j.quote.amount) + '</b>' : '') + '</span></button>').join('');
    }
    return { open, close: () => dlg.close(), renderList, labelOf: catLabel };
  }

  window.JobAlerts = JobAlerts;
  window.JobChat = { create, STAGE, PILL, jmd, esc, mmss, catLabel };
})();
