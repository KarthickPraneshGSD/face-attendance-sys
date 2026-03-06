const CACHE = 'facesync-v3';
const PRECACHE = [
    '/',
    '/index.html',
    '/app.js',
    '/face-api.min.js',
    '/chart.min.js',
    '/manifest.json',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => { }))
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    // Cache-first for same-origin; network-first for CDN
    const url = new URL(e.request.url);
    if (url.origin === location.origin) {
        e.respondWith(
            caches.match(e.request).then(r => r || fetch(e.request).then(res => {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
                return res;
            }))
        );
    } else {
        e.respondWith(
            fetch(e.request).catch(() => caches.match(e.request))
        );
    }
});
