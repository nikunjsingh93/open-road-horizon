// Open Road service worker: makes the game installable and playable offline.
//  - the page (index.html) is fetched network-first so new deployments show up, falling back to the cache offline
//  - hashed JS/CSS and everything else is served cache-first and refreshed in the background
const VERSION = 'openroad-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './assets/car.glb'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(CORE.map((u) => cache.add(u).catch(() => {})));      // one missing file must not abort the install
    // also cache the bundle files the page references so the very first offline start already works
    try {
      const html = await (await fetch('./index.html', { cache: 'no-store' })).text();
      const urls = [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map(m => m[1]);
      await Promise.all(urls.map(u => cache.add(new URL(u, self.registration.scope).href).catch(() => {})));
    } catch (err) { /* offline install */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url);
  if (url.pathname.includes('/__save')) return;
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(VERSION); c.put('./index.html', res.clone()); return res;
      } catch (err) { return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error(); }
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
