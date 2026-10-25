// Registers the service worker on every page so AutoAid can be installed on a phone and can receive notifications.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
}
