// AutoAid 24/7 service worker: shows phone notifications (even when the site is closed) and opens the right page when one is tapped.
// It does not cache anything: the site always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});   // present so the browser treats the site as installable; the network answers every request

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { title: 'AutoAid 24/7', body: event.data ? event.data.text() : '' }; }
  const urgent = !!d.urgent;
  event.waitUntil(self.registration.showNotification(d.title || 'AutoAid 24/7', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: urgent,                                      // an emergency stays on screen until someone acts on it
    vibrate: urgent ? [500, 200, 500, 200, 500, 200, 500] : [200, 100, 200],
    icon: '/icon-192.png',
    badge: '/favicon.png',
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.location.origin) && 'focus' in c) { return c.navigate(url).then(() => c.focus()).catch(() => c.focus()); }
    }
    return self.clients.openWindow(url);
  }));
});
