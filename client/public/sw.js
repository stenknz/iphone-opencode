const CACHE_NAME = 'opencode-v1';
const PRECACHE_URLS = ['/', '/index.html', '/src/main.tsx', '/src/App.tsx', '/src/App.css'];

const OFFLINE_FALLBACK = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0;text-align:center;padding:20px}div{max-width:320px}h2{margin-bottom:8px}p{color:#666}</style></head><body><div><h2>Connection lost</h2><p>Reconnecting\u2026</p></div></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(
          (cached) => cached || new Response(OFFLINE_FALLBACK, { headers: { 'Content-Type': 'text/html;charset=utf-8' } })
        )
      )
  );
});
