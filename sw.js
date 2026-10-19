/**
 * sw.js — Service Worker del Impostor Online
 *
 * 1) Configuración y script de la red de anuncios (NO modificar estas líneas).
 * 2) Caché del juego: network-first (siempre intenta la versión más nueva y,
 *    sin internet, usa la copia guardada). Ignora todo lo que no sea de tu
 *    propio dominio (backend/Socket.io, anuncios, fuentes) para no interferir.
 *
 * Sube el número de CACHE cada vez que quieras forzar una actualización.
 */

/* ── 1) Red de anuncios ── */
self.options = {
    "domain": "5gvci.com",
    "zoneId": 12073538
}
self.lary = ""
// try/catch: si un bloqueador de anuncios bloquea el dominio, el juego sigue funcionando
try {
  importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw');
} catch (err) {
  console.warn('Script de anuncios no disponible:', err);
}

/* ── 2) Caché del juego ── */
const CACHE = 'impostor-v3';
const ARCHIVOS = ['./', './index.html', './script.js', './styles.css'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return; // backend, anuncios, fuentes: no tocar

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia));
        }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
