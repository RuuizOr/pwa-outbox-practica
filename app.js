// =====================================================================
// app.js — Patrón Outbox + Background Sync (hilo principal / UI)
// ---------------------------------------------------------------------
// - CREATE: si el POST falla sin red, se guarda como 'pendiente' y se
//           registra la etiqueta 'sync-reportes' en el Service Worker
// - READ:   dibuja la bandeja de salida desde IndexedDB
// - UPDATE: lo hace sw.js con el evento 'sync'. Si el navegador no tiene
//           SyncManager (Safari/iOS, Firefox), lo hace app.js con 'online'
// - DELETE: botón para purgar los registros ya sincronizados
// Todo con .then() / .catch() / Promise.all(), sin async/await.
// =====================================================================

// URL de la API de prueba (acepta POST y responde 201)
const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

// Referencias al DOM
const form = document.getElementById('form-incidencia');
const inputTitulo = document.getElementById('titulo');
const inputDescripcion = document.getElementById('descripcion');
const listaOutbox = document.getElementById('lista-outbox');
const btnPurgar = document.getElementById('btn-purgar');
const badgeRed = document.getElementById('badge-red');


// ---------------------------------------------------------------------
// Fragmento G: escuchar mensajes que manda sw.js con postMessage.
// Cuando el SW termina de sincronizar en segundo plano, avisa con
// tipo 'OUTBOX_SINCRONIZADO' y aquí repintamos la bandeja.
// ---------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });
}


// ---------------------------------------------------------------------
// registrarServiceWorker()
// Registra sw.js con ruta RELATIVA (./) para que funcione en el
// subdirectorio de GitHub Pages (/pwa-outbox-practica/).
// ---------------------------------------------------------------------
function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('./sw.js')
    .then((reg) => console.log('[SW] Registrado con scope:', reg.scope))
    .catch((error) => console.error('[SW] Error al registrar:', error));
}


// ---------------------------------------------------------------------
// actualizarIndicadorRed()
// Cambia el texto y color del badge según navigator.onLine.
// ---------------------------------------------------------------------
function actualizarIndicadorRed() {
  if (navigator.onLine) {
    badgeRed.textContent = 'En Línea';
    badgeRed.className = 'badge online';
  } else {
    badgeRed.textContent = 'Sin Conexión';
    badgeRed.className = 'badge offline';
  }
}


// ---------------------------------------------------------------------
// renderizarColaOutbox()  —  READ
// Lee todos los registros, limpia el <ul> y crea un <li> por registro
// con su título, estado y hora. Devuelve la Promesa para encadenar.
// ---------------------------------------------------------------------
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      // Limpia la lista antes de redibujar
      listaOutbox.innerHTML = '';

      if (registros.length === 0) {
        const vacio = document.createElement('li');
        vacio.className = 'vacio';
        vacio.textContent = 'La bandeja está vacía.';
        listaOutbox.appendChild(vacio);
        return;
      }

      // Más recientes primero
      registros.reverse().forEach((item) => {
        const li = document.createElement('li');

        // Bloque izquierdo: título + hora
        const info = document.createElement('div');
        info.className = 'item-info';

        const titulo = document.createElement('strong');
        titulo.textContent = item.titulo; // textContent evita inyectar HTML

        const hora = document.createElement('small');
        hora.textContent = ' · ' + new Date(item.fechaCreacion).toLocaleTimeString();

        info.appendChild(titulo);
        info.appendChild(hora);

        // Bloque derecho: etiqueta de estado (pendiente / sincronizado)
        const estado = document.createElement('span');
        estado.className = 'estado ' + item.estado;
        estado.textContent = item.estado;

        li.appendChild(info);
        li.appendChild(estado);
        listaOutbox.appendChild(li);
      });
    })
    .catch((error) => console.error('[Outbox] Error al leer la bandeja:', error));
}


// ---------------------------------------------------------------------
// procesarEnvioReporte(datosFormulario)  —  CREATE
// Intenta el POST. Si funciona, guarda como 'sincronizado'.
// Si la red falla (.catch): guarda como 'pendiente' y, si el navegador
// soporta Background Sync, registra la etiqueta 'sync-reportes' para que
// sw.js reenvíe aunque se cierre la pestaña (Fragmento E).
// ---------------------------------------------------------------------
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datosFormulario)
  })
    .then((respuesta) => {
      // fetch solo falla por red; un 4xx/5xx lo convertimos en error
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      // Envío exitoso: bitácora local como sincronizado
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => {
          // Detección de soporte para Background Sync API
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            return navigator.serviceWorker.ready
              .then((registro) => {
                console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
                return registro.sync.register('sync-reportes');
              })
              .catch((error) => {
                // Si falla el registro, el dato sigue seguro en IndexedDB
                console.error('[Outbox] No se pudo registrar el sync:', error);
              });
          }
        });
    })
    .then(() => renderizarColaOutbox());
}


// ---------------------------------------------------------------------
// sincronizarPendientesFallback()  —  UPDATE (respaldo)
// Es la sincronizarPendientes() de la práctica anterior, renombrada.
// Solo se usa en navegadores SIN SyncManager (Safari/iOS, Firefox).
// Lee todo, filtra 'pendiente', reenvía con Promise.all() y actualiza.
// ---------------------------------------------------------------------
function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      // Cada pendiente se convierte en: POST -> actualizar estado
      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      // Espera a que terminen todos los reenvíos
      return Promise.all(promesasDeEnvio);
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    });
}


// ---------------------------------------------------------------------
// Formulario (submit)
// Evita la recarga, toma los valores, los envía y limpia el formulario.
// ---------------------------------------------------------------------
form.addEventListener('submit', (e) => {
  e.preventDefault(); // Sin esto la página se recarga

  const datos = {
    titulo: inputTitulo.value.trim(),
    descripcion: inputDescripcion.value.trim()
  };

  procesarEnvioReporte(datos)
    .then(() => form.reset())
    .catch((error) => console.error('[Outbox] Error al procesar el envío:', error));
});


// ---------------------------------------------------------------------
// Botón "Purgar Sincronizados"  —  DELETE
// Lee todo, filtra los 'sincronizado', los elimina en paralelo con
// Promise.all() y redibuja la bandeja. Los pendientes NO se tocan.
// ---------------------------------------------------------------------
btnPurgar.addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const enviados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(enviados.map((item) => eliminarRegistro(item.id)));
    })
    .then((resultados) => {
      console.log('[Outbox] Registros purgados:', resultados.length);
      return renderizarColaOutbox();
    })
    .catch((error) => console.error('[Outbox] Error al purgar:', error));
});


// ---------------------------------------------------------------------
// Eventos de conectividad  (Fragmento F)
// online: actualiza el badge. Solo sincroniza desde la UI si el navegador
// NO tiene SyncManager; si lo tiene, lo hace sw.js. Así se evita que
// app.js y sw.js manden el mismo POST duplicado (condición de carrera).
// offline: solo actualiza el badge
// ---------------------------------------------------------------------
window.addEventListener('online', () => {
  actualizarIndicadorRed();

  // Degradación elegante: fallback solo para navegadores sin Background Sync
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);


// ---------------------------------------------------------------------
// Arranque de la app
// ---------------------------------------------------------------------
registrarServiceWorker();
actualizarIndicadorRed();
renderizarColaOutbox();
