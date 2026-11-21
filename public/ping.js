// A loud alert for new activity on a page that refreshes itself: a red banner across the top of the screen, a siren that repeats until the person taps OK (or 60 seconds), vibration, a flashing tab title and (if allowed) a browser notification.
//   Ping.watch(key, items, title, body)   call it with the full list after every refresh. items need an id; "unread" means something new to read.
//   The first call for a key only learns what is already there, so opening the page never pings for old items.
(function () {
  let ctx = null, flash = null, baseTitle = '';
  function audio() {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { try { ctx = new AC(); } catch (_) {} } }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function stopFlash() { if (flash) { clearInterval(flash); flash = null; document.title = baseTitle; } }
  let ring = null, ringStop = null, banner = null;
  function siren() {
    if (!audio()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) { sq(960, t + i * 0.55, 0.26); sq(720, t + i * 0.55 + 0.28, 0.26); }
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (_) {}
  }
  function sq(freq, at, dur) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.8, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(ctx.destination); o.start(at); o.stop(at + dur + 0.02);
  }
  function dismiss() {
    clearInterval(ring); clearTimeout(ringStop); ring = ringStop = null;
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (_) {}
    if (banner) { banner.remove(); banner = null; }
    stopFlash();
  }
  function showBanner(title, body) {
    if (banner) banner.remove();
    banner = document.createElement('div'); banner.setAttribute('role', 'alert');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#B4322A;color:#fff;padding:16px;display:flex;gap:12px;align-items:center;justify-content:space-between;font:600 17px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);animation:pingflash 1s infinite';
    if (!document.getElementById('ping-style')) { const st = document.createElement('style'); st.id = 'ping-style'; st.textContent = '@keyframes pingflash{50%{background:#7a1d17}}'; document.head.appendChild(st); }
    const msg = document.createElement('div'); msg.textContent = '🔔 ' + (title || 'New activity') + (body ? ' - ' + body : '');
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'OK';
    btn.style.cssText = 'background:#fff;color:#B4322A;border:0;border-radius:8px;padding:10px 20px;font:700 16px system-ui,sans-serif;cursor:pointer';
    btn.addEventListener('click', dismiss);
    banner.append(msg, btn); document.body.appendChild(banner);
  }
  function ping(title, body) {
    dismiss();
    showBanner(title, body);
    siren(); ring = setInterval(siren, 2400); ringStop = setTimeout(dismiss, 60000);   // never rings forever
    if (document.hidden) {
      baseTitle = document.title; let on = false;
      flash = setInterval(() => { on = !on; document.title = on ? '🔔 ' + (title || 'New activity') : baseTitle; }, 800);
    }
    try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(title || 'AutoAid 24/7', { body: body || '', tag: 'autoaid-ping', requireInteraction: true }); } catch (_) {}
  }
  const seen = {};
  function watch(key, items, title, body) {
    const now = {}; let fresh = false;
    for (const it of items || []) now[it.id] = it.unread ? 'u' : 'r';
    if (seen[key]) for (const id in now) { if (!(id in seen[key]) || (now[id] === 'u' && seen[key][id] !== 'u')) fresh = true; }
    seen[key] = now;
    if (fresh) ping(title, body);
  }
  // browsers only allow sound after the person has touched the page once
  document.addEventListener('click', () => { audio(); if ('Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (_) {} } }, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) stopFlash(); });
  window.Ping = { watch, ping, dismiss, unlock: audio };
})();
