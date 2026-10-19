/**
 * server.js — Backend del Impostor Online (Node.js + Express + Socket.io)
 *
 * - Salas con código de 4 caracteres (sin letras ambiguas).
 * - El servidor elige palabra, pista e impostores; el cliente NUNCA los conoce
 *   hasta que le toca su turno y pulsa "Revelar palabra".
 * - Turnos secuenciales (Jugador 1, 2, 3...) con bloqueo en servidor.
 * - Reconexión: cada jugador tiene un `pid` (id persistente del navegador).
 *   Si se cae la conexión (p. ej. cambia a WhatsApp para pasar el enlace)
 *   dispone de 30 s para volver sin perder su lugar.
 *
 * Variables de entorno:
 *   PORT            Puerto (Render/Railway lo definen solos)
 *   ALLOWED_ORIGIN  Origen permitido por CORS, ej: https://everl0504.github.io
 */
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MIN_JUGADORES = 3;
const MAX_JUGADORES = 20;
const GRACIA_MS = 30000; // tiempo para reconectar antes de dar a alguien por perdido
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGIN } });
app.get('/', (_req, res) => res.send('Impostor backend OK'));

/* ------------------------------------------------------------------ */
/* Categorías: ./data/<categoria>.json  →  [{ palabra, pistas: [...] }] */
/* (la clave de la categoría es el nombre del archivo: animales, ...)   */
/* ------------------------------------------------------------------ */
function cargarCategorias() {
  const dir = path.join(__dirname, 'data');
  const cats = {};
  if (fs.existsSync(dir)) {
    for (const archivo of fs.readdirSync(dir)) {
      if (!archivo.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, archivo), 'utf8'));
        const banco = (Array.isArray(raw) ? raw : [])
          .map((x) => (typeof x === 'string' ? { palabra: x, pistas: [] }
            : { palabra: x && (x.palabra || x.nombre), pistas: Array.isArray(x && x.pistas) ? x.pistas : [] }))
          .filter((x) => x.palabra);
        if (banco.length) cats[path.basename(archivo, '.json')] = banco;
      } catch (e) {
        console.warn(`No se pudo leer ${archivo}:`, e.message);
      }
    }
  }
  if (!Object.keys(cats).length) {
    console.warn('⚠️ No hay categorías en ./data. Usando una de ejemplo.');
    cats.ejemplo = ['Pizza', 'Playa', 'Guitarra', 'Avión', 'Volcán'].map((p) => ({ palabra: p, pistas: [] }));
  }
  return cats;
}
const CATEGORIAS = cargarCategorias();
console.log('Categorías cargadas:', Object.keys(CATEGORIAS).join(', '));

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const elegir = (arr) => arr[Math.floor(Math.random() * arr.length)];
const limpiarNombre = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 16);
const limpiarPid = (p) => String(p || '').slice(0, 64);

function mezclar(arr) { // Fisher-Yates
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ------------------------------------------------------------------ */
/* Estado de salas (en memoria)                                        */
/* ------------------------------------------------------------------ */
/**
 * sala = {
 *   codigo, estado: 'espera' | 'revelando' | 'debate', hostPid,
 *   jugadores: [{ id (socket), pid, nombre, numero, conectado, abandono, timer }],
 *   turnoActual, categoria, impostoresN, config,
 *   palabraObj, pista, impostores: Set<numero>, primero, usadas: {cat: Set}
 * }
 */
const salas = new Map();
const salaDeSocket = new Map(); // socket.id -> código

function generarCodigo() {
  let c;
  do { c = Array.from({ length: 4 }, () => elegir(ALFABETO)).join(''); } while (salas.has(c));
  return c;
}

const vivos = (sala) => sala.jugadores.filter((j) => !j.abandono);

function snapshot(sala, j) { // todo lo que un jugador necesita para pintar su pantalla
  return {
    codigo: sala.codigo,
    estado: sala.estado,
    miNumero: j.numero,
    esHost: j.pid === sala.hostPid,
    total: sala.jugadores.length,
    categoria: sala.categoria,
    impostores: sala.impostoresN,
    turnoActual: sala.turnoActual,
    primero: sala.primero || null,
  };
}

/** Envía a cada jugador la lista actualizada (con su propio número y rol de host). */
function emitirJugadores(sala) {
  const lista = sala.jugadores.map((j) => ({
    numero: j.numero,
    nombre: j.nombre,
    conectado: j.conectado && !j.abandono,
    esHost: j.pid === sala.hostPid,
  }));
  for (const j of sala.jugadores) {
    if (!j.conectado) continue;
    io.to(j.id).emit('actualizar_jugadores', {
      codigo: sala.codigo, estado: sala.estado, minimo: MIN_JUGADORES,
      jugadores: lista, miNumero: j.numero, esHost: j.pid === sala.hostPid,
    });
  }
}

function emitirTurno(sala) {
  const actual = sala.jugadores.find((j) => j.numero === sala.turnoActual);
  io.to(sala.codigo).emit('cambio_turno', {
    turnoActual: sala.turnoActual,
    nombreTurno: actual ? actual.nombre : '',
  });
}

/** turnoActual++ saltando a quienes ya abandonaron; si no queda nadie → debate. */
function avanzarTurno(sala) {
  sala.turnoActual++;
  while (
    sala.turnoActual <= sala.jugadores.length &&
    sala.jugadores.find((j) => j.numero === sala.turnoActual).abandono
  ) sala.turnoActual++;

  if (sala.turnoActual > sala.jugadores.length) {
    sala.estado = 'debate';
    const p = elegir(vivos(sala));
    sala.primero = { numero: p.numero, nombre: p.nombre };
    io.to(sala.codigo).emit('comenzar_debate', { primero: sala.primero });
  } else {
    emitirTurno(sala);
  }
}

/** Arranca una ronda: elige palabra, pista e impostores (todo en el servidor). */
function iniciarRonda(sala, { categoria, impostores } = {}) {
  const cat = CATEGORIAS[categoria] ? categoria : elegir(Object.keys(CATEGORIAS));
  const banco = CATEGORIAS[cat];

  // No repetir palabras ya jugadas en esta sala
  const usadas = (sala.usadas[cat] = sala.usadas[cat] || new Set());
  let libres = banco.filter((p) => !usadas.has(p.palabra));
  if (!libres.length) { usadas.clear(); libres = banco; }
  const elegida = elegir(libres);
  usadas.add(elegida.palabra);

  const jug = vivos(sala);
  const nImp = Math.max(1, Math.min(Math.floor(jug.length / 2), parseInt(impostores, 10) || 1));

  sala.categoria = cat;
  sala.impostoresN = nImp;
  sala.config = { categoria: cat, impostores: nImp };
  sala.palabraObj = elegida;
  sala.pista = elegida.pistas.length ? elegir(elegida.pistas) : 'Sin pista disponible';
  sala.impostores = new Set(mezclar([...jug]).slice(0, nImp).map((j) => j.numero));
  sala.primero = null;
  sala.estado = 'revelando';
  sala.turnoActual = 0;

  io.to(sala.codigo).emit('partida_iniciada', {
    total: sala.jugadores.length, impostores: nImp, categoria: cat,
  });
  avanzarTurno(sala); // pone el turno en el primer jugador activo
}

/** Saca a un jugador (salió, o se agotó su tiempo de reconexión). */
function quitarJugador(sala, j) {
  if (!salas.has(sala.codigo) || !sala.jugadores.includes(j)) return;
  clearTimeout(j.timer);
  salaDeSocket.delete(j.id);

  if (sala.estado === 'espera') {
    sala.jugadores = sala.jugadores.filter((x) => x !== j);
    sala.jugadores.forEach((x, i) => (x.numero = i + 1)); // renumera 1..N
  } else {
    j.abandono = true;
    j.conectado = false;
  }

  const quedan = vivos(sala);
  if (!quedan.length) { salas.delete(sala.codigo); return; }

  if (j.pid === sala.hostPid) { // nuevo host
    sala.hostPid = (quedan.find((x) => x.conectado) || quedan[0]).pid;
  }
  if (sala.estado === 'revelando' && sala.turnoActual === j.numero) avanzarTurno(sala);
  emitirJugadores(sala);
}

/* ------------------------------------------------------------------ */
/* Eventos Socket.io                                                   */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
  const error = (mensaje) => socket.emit('error_sala', { mensaje });
  const miSala = () => salas.get(salaDeSocket.get(socket.id));
  const miJugador = (sala) => sala && sala.jugadores.find((j) => j.id === socket.id);

  /* --- Crear sala --- */
  socket.on('crear_sala', ({ nombre, pid } = {}) => {
    nombre = limpiarNombre(nombre); pid = limpiarPid(pid);
    if (!nombre || !pid) return error('Escribe tu nombre.');
    if (miSala()) return error('Ya estás en una sala.');

    const codigo = generarCodigo();
    const yo = { id: socket.id, pid, nombre, numero: 1, conectado: true, abandono: false, timer: null };
    const sala = {
      codigo, estado: 'espera', hostPid: pid, jugadores: [yo],
      turnoActual: 0, categoria: null, impostoresN: 1, config: null,
      palabraObj: null, pista: '', impostores: new Set(), primero: null, usadas: {},
    };
    salas.set(codigo, sala);
    salaDeSocket.set(socket.id, codigo);
    socket.join(codigo);

    socket.emit('sala_creada', snapshot(sala, yo));
    emitirJugadores(sala);
  });

  /* --- Unirse (código manual, ?sala=CODIGO o reconexión) --- */
  socket.on('unirse_sala', ({ nombre, codigo, pid } = {}) => {
    nombre = limpiarNombre(nombre); pid = limpiarPid(pid);
    codigo = String(codigo || '').trim().toUpperCase();
    if (!pid) return error('Falta identificador.');
    if (miSala()) return error('Ya estás en una sala.');

    const sala = salas.get(codigo);
    if (!sala) return error('Esa sala no existe o ya terminó.');

    // ¿Es alguien que vuelve? (misma pid) → recupera su lugar
    const previo = sala.jugadores.find((j) => j.pid === pid && !j.abandono);
    if (previo) {
      clearTimeout(previo.timer);
      salaDeSocket.delete(previo.id);
      previo.id = socket.id;
      previo.conectado = true;
      salaDeSocket.set(socket.id, codigo);
      socket.join(codigo);
      socket.emit('estado_actual', snapshot(sala, previo));
      emitirJugadores(sala);
      return;
    }

    if (!nombre) return error('Escribe tu nombre.');
    if (sala.estado !== 'espera') return error('La partida ya comenzó.');
    if (sala.jugadores.length >= MAX_JUGADORES) return error('La sala está llena.');

    // Número de turno secuencial
    const yo = { id: socket.id, pid, nombre, numero: sala.jugadores.length + 1, conectado: true, abandono: false, timer: null };
    sala.jugadores.push(yo);
    salaDeSocket.set(socket.id, codigo);
    socket.join(codigo);

    socket.emit('unido_sala', snapshot(sala, yo));
    emitirJugadores(sala);
  });

  /* --- El host inicia la partida --- */
  socket.on('iniciar_partida', ({ categoria, impostores } = {}) => {
    const sala = miSala(); const yo = miJugador(sala);
    if (!sala || !yo) return error('No estás en una sala.');
    if (yo.pid !== sala.hostPid) return error('Solo el host puede iniciar.');
    if (sala.estado !== 'espera') return;
    if (vivos(sala).length < MIN_JUGADORES) return error(`Se necesitan al menos ${MIN_JUGADORES} jugadores.`);
    iniciarRonda(sala, { categoria, impostores });
  });

  /* --- Jugar otra ronda con la misma configuración --- */
  socket.on('otra_ronda', () => {
    const sala = miSala(); const yo = miJugador(sala);
    if (!sala || !yo || yo.pid !== sala.hostPid || sala.estado !== 'debate') return;
    if (vivos(sala).length < MIN_JUGADORES) return error(`Se necesitan al menos ${MIN_JUGADORES} jugadores.`);
    iniciarRonda(sala, sala.config);
  });

  /* --- Volver a la sala de espera (para cambiar configuración) --- */
  socket.on('nueva_ronda', () => {
    const sala = miSala(); const yo = miJugador(sala);
    if (!sala || !yo || yo.pid !== sala.hostPid || sala.estado !== 'debate') return;
    sala.jugadores = sala.jugadores.filter((j) => !j.abandono);
    sala.jugadores.forEach((j, i) => (j.numero = i + 1));
    sala.estado = 'espera';
    sala.turnoActual = 0;
    sala.palabraObj = null; sala.primero = null;
    io.to(sala.codigo).emit('volver_sala');
    emitirJugadores(sala);
  });

  /* --- El jugador activo pide ver su palabra --- */
  socket.on('revelar_palabra', () => {
    const sala = miSala(); const yo = miJugador(sala);
    if (!sala || !yo || sala.estado !== 'revelando') return;
    if (yo.numero !== sala.turnoActual) return error('Todavía no es tu turno.'); // anti-trampas

    const esImpostor = sala.impostores.has(yo.numero);
    // Solo ESTE socket recibe su rol/palabra
    socket.emit('palabra_asignada', {
      rol: esImpostor ? 'impostor' : 'inocente',
      palabra: esImpostor ? null : sala.palabraObj.palabra,
      pista: esImpostor ? sala.pista : null,
      categoria: sala.categoria,
    });
  });

  /* --- "Entendido, memoricé mi rol" --- */
  socket.on('confirmar_palabra_vista', () => {
    const sala = miSala(); const yo = miJugador(sala);
    if (!sala || !yo || sala.estado !== 'revelando') return;
    if (yo.numero !== sala.turnoActual) return;
    avanzarTurno(sala); // turnoActual++ y notifica a todos (o comienza el debate)
  });

  /* --- Salir voluntariamente --- */
  socket.on('salir_sala', () => {
    const sala = miSala(); const yo = miJugador(sala);
    if (!sala || !yo) return;
    socket.leave(sala.codigo);
    quitarJugador(sala, yo);
  });

  /* --- Desconexión: se le da un margen para volver --- */
  socket.on('disconnect', () => {
    const sala = salas.get(salaDeSocket.get(socket.id));
    salaDeSocket.delete(socket.id);
    const yo = sala && sala.jugadores.find((j) => j.id === socket.id);
    if (!yo) return; // ya había reconectado con otro socket
    yo.conectado = false;
    emitirJugadores(sala);
    yo.timer = setTimeout(() => quitarJugador(sala, yo), GRACIA_MS);
  });
});

server.listen(PORT, () => console.log(`Impostor backend escuchando en puerto ${PORT}`));
