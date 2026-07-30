const CACHE_NAME = 'yulia-top3-v1-0-2-search-chains';
const APP_SHELL = [
  './','./index.html','./styles.css?v=1.0.2','./app.js?v=1.0.2','./top3-data.js','./manifest.webmanifest',
  './icon-top3-yulia-v1.png','./icon-192.png','./icon-512.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);

  // Внешние запросы к источнику тиражей всегда идут в сеть и не попадают в PWA-кэш.
  if (requestUrl.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => {
      const copy=response.clone(); caches.open(CACHE_NAME).then(c=>c.put('./index.html',copy)); return response;
    }).catch(()=>caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => {
    const network=fetch(event.request).then(response => {
      if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(c=>c.put(event.request,copy));}
      return response;
    }).catch(()=>cached);
    return cached || network;
  }));
});
