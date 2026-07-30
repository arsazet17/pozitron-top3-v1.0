const CACHE_NAME = 'yulia-top3-v1-0-3-clean-start';
const OFFLINE_INDEX = './index.html';
const APP_SHELL = [
  './index.html',
  './styles.css?v=1.0.3',
  './app.js?v=1.0.3',
  './top3-data.js',
  './manifest.webmanifest',
  './icon-top3-yulia-v1.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async url => {
      const request = new Request(url, { cache: 'reload' });
      const response = await fetch(request);
      if (!response.ok) throw new Error(`Не удалось закэшировать ${url}: ${response.status}`);
      await cache.put(url, response);
      if (url === './index.html') await cache.put(OFFLINE_INDEX, response.clone());
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (url.pathname.endsWith('/sw.js')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(OFFLINE_INDEX, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(OFFLINE_INDEX)) || Response.error();
      }
    })());
    return;
  }

  const destination = event.request.destination;
  const mustBeFresh = destination === 'script' || destination === 'style' || url.pathname.endsWith('.webmanifest');

  if (mustBeFresh) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(event.request)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
