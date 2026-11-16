// =====================================================================
// sw.js — Service Worker (App Shell con rutas RELATIVAS)
// ---------------------------------------------------------------------
// Guarda en Cache Storage los archivos de la interfaz para que la app
// abra sin internet. Las rutas usan ./ para funcionar en el subdirectorio
// de GitHub Pages (/pwa-outbox-practica/).
// =====================================================================

// Cambia la versión cuando modifiques algún archivo del App Shell
const CACHE_NAME = 'outbox-shell-v3';

// Archivos del App Shell (todos relativos)
const STATIC = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db-helper.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];


// ---------------------------------------------------------------------
// install: precarga el App Shell en caché
// waitUntil hace que el SW no se instale hasta que termine la Promesa
// ---------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC))
      .then(() => self.skipWaiting()) // Activa la nueva versión sin esperar
  );
});


// ---------------------------------------------------------------------
// activate: borra cachés de versiones anteriores
// ---------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre))
      ))
      .then(() => self.clients.claim()) // Controla las pestañas abiertas
  );
});


// ---------------------------------------------------------------------
// fetch: Cache First solo para GET del mismo origen.
// Los POST a la API NO se interceptan: si fallan, app.js los encola
// en IndexedDB (patrón Outbox).
// ---------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Ignorar POST y peticiones a otros dominios (jsonplaceholder)
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true })
      .then((respuestaCache) => respuestaCache || fetch(req))
  );
});
