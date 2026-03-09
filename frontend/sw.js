const CACHE = 'facesync-v6';

self.addEventListener('install', e => {
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
    // Only cache GET requests from same origin
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    
    // EXCLUDE Firebase SDK requests from being intercepted by the Service Worker
    // This prevents the SW from interfering with Firestore real-time listeners (WebSockets/Long-polling)
    if (url.hostname.includes('googleapis.com') || url.hostname.includes('firebaseapp.com')) {
        return; 
    }

    if (url.origin !== location.origin) {
        // For CDN/external: network first, fallback to cache
        e.respondWith(
            fetch(e.request).catch(() => caches.match(e.request))
        );
        return;
    }
    // For same-origin: network first — store successful responses in cache
    e.respondWith(
        fetch(e.request).then(res => {
            // Only cache valid responses (not 404 etc.)
            if (res && res.status === 200) {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
            }
            return res;
        }).catch(() => caches.match(e.request))
    );
});
