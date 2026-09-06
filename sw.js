// BuenTrade push service worker — real ask 2026-09-06: "una notificacion donde yo le de ok y se
// ejecute... no me sirve un resumen." This is the piece that lets a push arrive on the trader's
// screen even when the tab isn't open, and land on a one-click action page when tapped — not a
// digest email nobody opens.
//
// Kept deliberately minimal: no offline caching, no asset precaching — this service worker exists
// ONLY to receive pushes and route notification clicks. Adding a fetch handler / cache strategy
// here would be a separate, unrelated feature (offline support) that nobody asked for.

// Without these two, a new version of this file sits "waiting" until every tab using the old one
// is closed — the trader could keep getting old-behavior pushes for hours after a real fix
// shipped, with no visible sign anything was wrong. skipWaiting + clients.claim make every update
// take over immediately, on the very next push.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = { title: 'BuenTrade', body: '', url: '/orders.html', actions: [], actionUrls: {} };
  try { data = event.data.json(); } catch (e) { /* non-JSON push, keep defaults */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url, actionUrls: data.actionUrls || {} },
      // Real ask 2026-09-06: "una notificacion donde yo le de ok y se ejecute" — up to 2 action
      // buttons right on the notification (e.g. "WhatsApp Planta"), each opening its own real
      // wa.me link with the message already written. A plain click (no action) falls back to
      // data.url, same as before this existed.
      actions: data.actions || [],
      requireInteraction: true, // a pickup/customs alert shouldn't auto-dismiss unseen
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const actionUrls = (event.notification.data && event.notification.data.actionUrls) || {};
  const url = (event.action && actionUrls[event.action]) || (event.notification.data && event.notification.data.url) || '/orders.html';
  const isExternal = /^https?:\/\//.test(url) && !url.startsWith(self.location.origin);

  event.waitUntil(
    (async () => {
      // A wa.me action always opens a fresh tab — reusing/focusing an existing app tab would
      // just navigate the trader's open Status tab away to WhatsApp, losing their place.
      if (isExternal) return self.clients.openWindow(url);
      // Real bug found 2026-09-06: this matched an existing tab by PATHNAME only, ignoring the
      // query string — an already-open Orders tab just got focused as-is, silently dropping the
      // ?focus=<order_number> that reprioritizes the blocking action queue to the exact order this
      // notification was about. Every notification is now REQUIRED to force a specific action
      // (see project_order_lifecycle_and_alerting_spec), so an existing tab must be navigated to
      // the new URL, not just brought forward untouched.
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const absoluteUrl = new URL(url, self.location.origin);
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin + absoluteUrl.pathname) && 'focus' in client) {
          if ('navigate' in client) await client.navigate(absoluteUrl.href);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })()
  );
});
