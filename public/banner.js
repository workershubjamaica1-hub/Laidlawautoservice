// Shared AutoAid 24/7 header banner: rotates through the services we provide.
// Put <div class="slides" role="region" aria-roledescription="carousel" aria-label="Services we provide"></div> in the header.
(function () {
  const SERVICES = [
    { t: 'Roadside assistance', d: 'Flat tire, dead battery, out of fuel or locked out. Help comes to you.',
      i: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>' },
    { t: 'Wrecker / towing', d: 'Breakdown or accident? We send a tow truck to your location.',
      i: '<path d="M2 16V6h11v10M13 9h4l3 3v4h-2M2 16h2m5 0h6"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>' },
    { t: 'Diagnostics', d: 'Find the fault fast: warning lights, strange noises, rough running.',
      i: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8.5 11h5M11 8.5v5"/>' },
    { t: 'Mechanical repairs', d: 'Brakes, suspension, transmission, engine and more.',
      i: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>' },
    { t: 'Tire services', d: 'Flat tires, replacements and wear checks.',
      i: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>' },
    { t: 'Electrical', d: 'Batteries, alternators, wiring and lights.',
      i: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>' },
    { t: 'Routine maintenance', d: 'Oil changes, filters, fluids and safety inspections.',
      i: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9.5 14l2 2 3.5-4"/>' },
    { t: 'AutoAid AI, 24/7', d: 'Chat about any vehicle problem, any time of day or night.',
      i: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>' },
    { t: 'Technicians in your parish', d: 'Skilled professionals across all 14 parishes, close to you.',
      i: '<path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>' }
  ];

  const box = document.querySelector('.slides');
  if (!box) return;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let dots = box.querySelector('.dots');
  if (!dots) { dots = document.createElement('div'); dots.className = 'dots'; box.appendChild(dots); }
  let cur = 0, timer = null;

  const slides = SERVICES.map((s, n) => {
    const el = document.createElement('div');
    el.className = 'slide'; el.setAttribute('role', 'group'); el.setAttribute('aria-roledescription', 'slide');
    el.setAttribute('aria-label', (n + 1) + ' of ' + SERVICES.length);
    const ico = document.createElement('div'); ico.className = 'ico';
    const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = s.i; ico.appendChild(svg);   // icon markup comes from the fixed list above, never from user input
    const text = document.createElement('div');
    const t = document.createElement('strong'); t.textContent = s.t;
    const d = document.createElement('span'); d.className = 'line'; d.textContent = s.d;
    text.append(t, d); el.append(ico, text); box.insertBefore(el, dots);
    const dot = document.createElement('button'); dot.type = 'button'; dot.setAttribute('aria-label', 'Show ' + s.t);
    dot.addEventListener('click', () => { show(n); restart(); });
    dots.appendChild(dot);
    return el;
  });
  function show(n) {
    cur = (n + slides.length) % slides.length;
    slides.forEach((el, k) => { el.classList.toggle('on', k === cur); el.setAttribute('aria-hidden', k === cur ? 'false' : 'true'); });
    [...dots.children].forEach((b, k) => b.setAttribute('aria-current', k === cur ? 'true' : 'false'));
  }
  function stop() { clearInterval(timer); timer = null; }
  function restart() { stop(); if (!reduce && !document.hidden) timer = setInterval(() => show(cur + 1), 4500); }
  box.addEventListener('mouseenter', stop); box.addEventListener('mouseleave', restart);
  box.addEventListener('focusin', stop); box.addEventListener('focusout', restart);
  document.addEventListener('visibilitychange', restart);
  show(0); restart();
})();
