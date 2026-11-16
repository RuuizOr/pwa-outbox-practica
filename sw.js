// =====================================================================
// sw.js — Service Worker (App Shell + Background Sync)
// ---------------------------------------------------------------------
// 1. Guarda en Cache Storage el App Shell para abrir sin internet.
// 2. Escucha el evento 'sync' (Background Sync API) para reenviar los
//    reportes 'pendiente' aunque la pestaña esté cerrada.
// 3. Avisa a las pestañas abiertas con postMessage al terminar.
// Rutas relativas (./) para funcionar en /pwa-outbox-practica/.
// =====================================================================

// Fragmento A: importar el mini-wrapper de IndexedDB en el hilo del SW.
// El SW no tiene <script>, por eso se usa importScripts().
// Deja disponibles: obtenerTodosLosRegistros, actualizarEstadoRegistro, etc.
importScripts('./db-helper.js');

// Nueva versión de caché para forzar la actualización del SW en producción
const CACHE_STATIC_NAME = 'static-outbox-v2';

// Archivos del App Shell (todos relativos)
const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// URL de la API de prueba
const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';


// ---------------------------------------------------------------------
// notificarClientesActualizacion()  (Fragmento B)
// El SW no puede tocar el DOM. Busca todas las pestañas de la PWA y les
// manda un mensaje para que ellas mismas repinten la bandeja.
// ---------------------------------------------------------------------
function notificarClientesActualizacion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientes) => {
      clientes.forEach((cliente) => {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
    });
}


// ---------------------------------------------------------------------
// sincronizarPendientesSW()  (Fragmento C)
// Lee IndexedDB, filtra los 'pendiente', los reenvía en paralelo con
// Promise.all(), los marca 'sincronizado' y avisa a las pestañas.
// Devuelve TODA la cadena para que event.waitUntil() sepa cuándo terminó.
// ---------------------------------------------------------------------
function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
        return;
      }

      // Cada pendiente: POST -> actualizar estado en IndexedDB
      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.titulo,
            body: item.descripcion
          })
        })
          .then((respuesta) => {
            if (!respuesta.ok) {
              throw new Error('Error HTTP ' + respuesta.status + ' al sincronizar ID ' + item.id);
            }
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      // Al terminar todos los envíos, avisar a las pestañas abiertas
      return Promise.all(promesasDeEnvio)
        .then(() => notificarClientesActualizacion());
    });
}


// ---------------------------------------------------------------------
// install: precarga el App Shell en caché.
// cache: 'reload' evita que se guarde una copia vieja del caché HTTP.
// ---------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME)
      .then((cache) => cache.addAll(
        STATIC_FILES.map((url) => new Request(url, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting()) // Activa la nueva versión sin esperar
  );
});


// ---------------------------------------------------------------------
// activate: borra cachés de versiones anteriores y toma control
// ---------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_STATIC_NAME)
          .map((nombre) => caches.delete(nombre))
      ))
      .then(() => self.clients.claim())
  );
});


// ---------------------------------------------------------------------
// fetch: Cache First solo para GET del mismo origen.
// Los POST a la API no se interceptan (los maneja el patrón Outbox).
// ---------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true })
      .then((respuestaCache) => respuestaCache || fetch(req))
  );
});


// ---------------------------------------------------------------------
// sync  (Fragmento D)
// El navegador lo dispara solo cuando detecta conexión estable, aunque
// la pestaña esté cerrada. Si la Promesa falla, el navegador reintenta.
// ---------------------------------------------------------------------
self.addEventListener('sync', (event) => {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === 'sync-reportes') {
    event.waitUntil(
      sincronizarPendientesSW()
        .catch((error) => {
          console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
          // Relanzar el error = pedir al navegador un reintento automático
          throw error;
        })
    );
  }
});
