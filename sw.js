const CACHE_NAME = 'yulia-top3-v1-0-22';
const OFFLINE_URL = './index.html';
const LIVE_FILE = './top3-live.json';
const ASSETS = [
  './index.html', './repair.html', './styles.css?v=1.0.22', './app.js?v=1.0.22',
  './top3-data.js?v=1.0.22', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-top3-yulia-v1.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(ASSETS.map(async url => {
      const response = await fetch(new Request(url, {cache:'reload'}));
      if (response.ok) await cache.put(url, response.clone());
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  const isLive = url.pathname.endsWith('/top3-live.json');
  if (isLive) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, {cache:'no-store'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const cache = await caches.open(CACHE_NAME);
        await cache.put(LIVE_FILE, response.clone());
        return response;
      } catch {
        return (await caches.match(LIVE_FILE)) || Response.error();
      }
    })());
    return;
  }

  const isNavigation = event.request.mode === 'navigate';
  const isCode = ['script','style'].includes(event.request.destination) || url.pathname.endsWith('.webmanifest');
  if (isNavigation || isCode) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, {cache:'no-store'});
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
          const isHome = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
          if (isNavigation && isHome) await cache.put(OFFLINE_URL, response.clone());
        }
        return response;
      } catch {
        const exact = await caches.match(event.request);
        if (exact) return exact;
        return isNavigation ? (await caches.match(OFFLINE_URL) || Response.error()) : Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) (await caches.open(CACHE_NAME)).put(event.request, response.clone());
    return response;
  })());
});
