// =====================================================================
// db-helper.js — Mini-wrapper promisificado de IndexedDB (Vanilla JS)
// ---------------------------------------------------------------------
// Traduce la API nativa de IndexedDB (basada en eventos onsuccess/onerror)
// a Promesas, para poder encadenarla con .then() / .catch() igual que fetch().
// Se carga en el HTML con <script src="./db-helper.js"> y en el
// Service Worker con importScripts('./db-helper.js').
// =====================================================================

// Nombre de la base de datos (aparece en DevTools > Application > IndexedDB)
const DB_NAME = 'pwa-outbox-db';
// Versión del esquema. Si agregas o cambias Object Stores, súbela (1 -> 2)
const DB_VERSION = 1;
// Nombre del Object Store (equivalente a una "tabla")
const STORE_NAME = 'transacciones_pendientes';


// ---------------------------------------------------------------------
// Pieza 1: abrirDB()
// Abre (o crea) la base de datos y devuelve una Promesa que se resuelve
// con el objeto IDBDatabase listo para crear transacciones.
// ---------------------------------------------------------------------
function abrirDB() {
  return new Promise((resolve, reject) => {
    // Pide abrir la BD con ese nombre y versión
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // Solo se dispara si la BD no existe o si DB_VERSION es mayor a la actual.
    // Es el ÚNICO lugar donde se pueden crear o borrar Object Stores.
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Evita crear el store dos veces si ya existe
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // keyPath 'id' + autoIncrement: IndexedDB genera IDs 1, 2, 3...
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };

    // BD abierta correctamente: resolvemos con la conexión
    request.onsuccess = (event) => resolve(event.target.result);
    // Fallo al abrir (permisos, versión menor, etc.): rechazamos
    request.onerror = (event) => reject(event.target.error);
  });
}


// ---------------------------------------------------------------------
// Pieza 2: guardarRegistro(datos)
// Inserta un objeto en el store y resuelve con el ID que se le asignó.
// Resuelve hasta tx.oncomplete para garantizar que ya se escribió en disco.
// ---------------------------------------------------------------------
function guardarRegistro(datos) {
  // Primero abrimos la BD; el return encadena la siguiente Promesa
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      // Transacción de escritura sobre nuestro store
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // add() inserta el objeto (falla si el id ya existe)
      const req = store.add(datos);
      let idGenerado;

      // La petición fue aceptada: aquí ya conocemos el ID generado,
      // pero el dato aún NO está confirmado en disco
      req.onsuccess = (event) => {
        idGenerado = event.target.result;
      };

      // La transacción hizo commit: ahora sí el dato está guardado
      tx.oncomplete = () => resolve(idGenerado);
      // Si la transacción falla, se revierte y rechazamos la Promesa
      tx.onerror = (event) => reject(event.target.error);
    });
  });
}


// ---------------------------------------------------------------------
// Pieza 3: obtenerTodosLosRegistros()
// Lee todos los objetos del store y resuelve con un arreglo.
// ---------------------------------------------------------------------
function obtenerTodosLosRegistros() {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      // 'readonly' porque solo consultamos (permite lecturas simultáneas)
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      // getAll() trae todos los registros en un arreglo
      const req = store.getAll();

      // Resolvemos con el arreglo de objetos
      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = (event) => reject(event.target.error);
    });
  });
}


// ---------------------------------------------------------------------
// Pieza 5 (Tema 5.2): actualizarEstadoRegistro(id, nuevoEstado)
// UPDATE: dentro de UNA sola transacción 'readwrite' lee el registro con
// get(id) y lo sobrescribe con put() ya con el nuevo estado.
// Se usa para pasar un registro de 'pendiente' a 'sincronizado'.
// ---------------------------------------------------------------------
function actualizarEstadoRegistro(id, nuevoEstado) {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // 1. Leer el registro actual por su llave primaria
      const reqGet = store.get(id);

      reqGet.onsuccess = (event) => {
        const registro = event.target.result;
        // Si no existe, rechazamos y no escribimos nada
        if (!registro) {
          reject(new Error('No se encontró el registro con ID: ' + id));
          return;
        }

        // 2. Cambiar el estado y sobrescribir con put() (misma llave = update)
        registro.estado = nuevoEstado;
        registro.fechaSincronizacion = Date.now();
        store.put(registro);
      };

      // 3. Resolver hasta que la transacción haga commit en disco
      tx.oncomplete = () => resolve(true);
      tx.onerror = (event) => reject(event.target.error);
    });
  });
}


// ---------------------------------------------------------------------
// Pieza 4: eliminarRegistro(id)
// Borra un registro por su llave primaria (id) y resuelve con true.
// Se usa para limpiar la cola cuando el servidor confirma la recepción.
// ---------------------------------------------------------------------
function eliminarRegistro(id) {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      // 'readwrite' porque borrar modifica el store
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // Elimina el objeto cuya llave sea igual a id
      store.delete(id);

      // Confirmamos hasta que la transacción termina
      tx.oncomplete = () => resolve(true);
      tx.onerror = (event) => reject(event.target.error);
    });
  });
}
