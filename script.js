// ════════════════ CONFIGURACIÓN ════════════════
// URL de tu backend desplegado (Render, Railway, Fly...). NO es la de GitHub Pages.
const BACKEND_URL = 'https://TU-BACKEND.onrender.com';
const MIN_JUG = 3;

const EMOJIS = { animales: '🐾', futbolistas: '⚽', paises: '🌍', peliculas: '🎬', videojuegos: '🎮' };
const $ = id => document.getElementById(id);

// ════════════════ ESTADO ════════════════
// Config que solo usa el host al iniciar (el servidor valida todo)
let numImpostores = 1, catSeleccionada = 'animales';

// Estado de la sala según lo que informa el servidor
const estado = {
  codigo: null, miNumero: 0, esHost: false, fase: 'join',   // join | espera | revelando | debate
  jugadores: [], total: 0, impostores: 1, categoria: 'animales',
  turnoActual: 0, pendiente: false                           // pendiente: esperando palabra del servidor
};

// Identidad persistente por pestaña: permite recuperar el lugar si se cae la conexión
const pid = sessionStorage.getItem('impostor_pid') || (() => {
  const v = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  sessionStorage.setItem('impostor_pid', v);
  return v;
})();

// ════════════════ CONTROL DE PANTALLAS ════════════════
// Una sola pantalla activa; la nueva aparece cuando la anterior ya se ocultó.
// Como ahora los cambios llegan del servidor, si hay una transición en curso
// la petición se pone en cola en vez de descartarse.
const Screens = {
  current: 'screen-join',
  busy: false,
  DELAY: 240,

  init() {
    document.querySelectorAll('.screen').forEach(s => {
      const on = s.id === this.current;
      s.classList.toggle('active', on);
      s.inert = !on;
    });
  },

  go(toId, beforeShow) {
    if (this.busy) { setTimeout(() => this.go(toId, beforeShow), 60); return true; } // cola
    if (toId === this.current) { if (beforeShow) beforeShow(); return true; }        // refrescar en sitio
    const from = $(this.current), to = $(toId);
    if (!to) return false;
    this.busy = true;
    if (document.activeElement) document.activeElement.blur();
    from.classList.remove('active');
    from.inert = true;
    setTimeout(() => {
      if (beforeShow) beforeShow();
      to.inert = false;
      to.scrollTop = 0;
      to.classList.add('active');
      this.current = toId;
      this.busy = false;
    }, this.DELAY);
    return true;
  }
};

document.addEventListener('DOMContentLoaded', () => {
  Screens.init();
  actualizarSteppers();
  initBackgroundCanvas();

  // Prefill: nombre guardado y código del enlace (?sala=CODIGO)
  $('in-nombre').value = localStorage.getItem('impostor_nombre') || '';
  const deUrl = codigoDeUrl();
  if (deUrl) {
    $('in-codigo').value = deUrl;
    if (!$('in-nombre').value) $('in-nombre').focus();
  }
  // Código siempre en mayúsculas y solo alfanumérico
  $('in-codigo').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('in-codigo').addEventListener('keydown', e => { if (e.key === 'Enter') unirseSala(); });
});

// ════════════════ UTILIDADES ════════════════
let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

const codigoDeUrl = () =>
  (new URLSearchParams(location.search).get('sala') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

const enlaceInvitacion = () => `${location.origin}${location.pathname}?sala=${estado.codigo}`;
const nombreDe = n => (estado.jugadores.find(j => j.numero === n) || {}).nombre || '';

function emitir(evento, datos) {
  if (!socket || !socket.connected) {
    showToast('⏳ Conectando con el servidor… prueba en unos segundos');
    return false;
  }
  socket.emit(evento, datos);
  return true;
}

// ════════════════ CONEXIÓN SOCKET.IO ════════════════
const socket = (typeof io === 'function')
  ? io(BACKEND_URL, { transports: ['websocket', 'polling'] })
  : null;
let reconectando = false;

function limpiarSesion() {
  sessionStorage.removeItem('impostor_sala');
  Object.assign(estado, { codigo: null, miNumero: 0, esHost: false, fase: 'join', jugadores: [], turnoActual: 0, pendiente: false });
  history.replaceState(null, '', location.pathname); // quita ?sala=
}

if (socket) {
  // Al conectar (o RE-conectar): volver a la sala guardada o entrar por el enlace
  socket.on('connect', () => {
    const nombre = localStorage.getItem('impostor_nombre') || '';
    const guardada = sessionStorage.getItem('impostor_sala');
    if (guardada) {
      reconectando = true;
      socket.emit('unirse_sala', { codigo: guardada, nombre, pid });
    } else if (codigoDeUrl() && nombre && Screens.current === 'screen-join') {
      showToast(`Entrando a la sala ${codigoDeUrl()}…`);
      socket.emit('unirse_sala', { codigo: codigoDeUrl(), nombre, pid });
    }
  });

  socket.on('connect_error', () => showToast('⚠️ No se pudo conectar con el servidor'));

  socket.on('error_sala', ({ mensaje }) => {
    showToast('⚠️ ' + mensaje);
    if (reconectando) { // la sala guardada ya no existe
      reconectando = false;
      limpiarSesion();
      Screens.go('screen-join');
    }
    estado.pendiente = false;
    if (Screens.current === 'screen-turn') renderTurno();
  });

  // sala_creada: muestra el código y la opción de copiar el enlace
  socket.on('sala_creada', aplicarEstado);
  socket.on('unido_sala', aplicarEstado);
  socket.on('estado_actual', aplicarEstado); // tras reconectar

  // actualizar_jugadores: contador y lista de la sala de espera
  socket.on('actualizar_jugadores', ({ jugadores, miNumero, esHost }) => {
    estado.jugadores = jugadores;
    estado.miNumero = miNumero;
    estado.esHost = esHost;
    renderLobby();
    if (Screens.current === 'screen-turn') renderTurno();
    renderBotonesFinal();
  });

  socket.on('partida_iniciada', ({ total, impostores, categoria }) => {
    Object.assign(estado, { fase: 'revelando', total, impostores, categoria, turnoActual: 0, pendiente: false });
    Screens.go('screen-turn', () => { limpiarReveal(); renderTurno(); });
  });

  // cambio_turno: habilita/deshabilita el botón según sea mi turno
  socket.on('cambio_turno', ({ turnoActual }) => {
    estado.turnoActual = turnoActual;
    estado.pendiente = false;
    if (turnoActual === estado.miNumero && navigator.vibrate) navigator.vibrate(200);
    Screens.go('screen-turn', () => { limpiarReveal(); renderTurno(); });
  });

  // Solo yo recibo mi rol/palabra, y únicamente cuando es mi turno
  socket.on('palabra_asignada', datos => {
    estado.pendiente = false;
    Screens.go('screen-reveal', () => pintarReveal(datos));
  });

  socket.on('comenzar_debate', ({ primero }) => mostrarDebate(primero));

  socket.on('volver_sala', () => {
    estado.fase = 'espera';
    Screens.go('screen-lobby', renderLobby);
  });
}

/** Aplica el estado completo que manda el servidor (crear / unirse / reconectar). */
function aplicarEstado(s) {
  reconectando = false;
  Object.assign(estado, {
    codigo: s.codigo, miNumero: s.miNumero, esHost: s.esHost, fase: s.estado,
    total: s.total, impostores: s.impostores || 1, categoria: s.categoria || catSeleccionada,
    turnoActual: s.turnoActual || 0, pendiente: false
  });
  sessionStorage.setItem('impostor_sala', s.codigo);

  if (s.estado === 'espera') {
    Screens.go('screen-lobby', renderLobby);
  } else if (s.estado === 'revelando') {
    // Si estaba mirando mi palabra cuando se cayó la conexión, no la oculto
    if (Screens.current === 'screen-reveal' && s.turnoActual === s.miNumero) return;
    Screens.go('screen-turn', () => { limpiarReveal(); renderTurno(); });
  } else {
    mostrarDebate(s.primero);
  }
}

// ════════════════ ENTRAR / SALIR DE SALA ════════════════
function nombreIngresado() {
  const n = $('in-nombre').value.trim();
  if (!n) { showToast('✏️ Escribe tu nombre'); $('in-nombre').focus(); return null; }
  localStorage.setItem('impostor_nombre', n);
  return n;
}

function crearSala() {
  const nombre = nombreIngresado();
  if (nombre) emitir('crear_sala', { nombre, pid });
}

function unirseSala() {
  const nombre = nombreIngresado();
  if (!nombre) return;
  const codigo = $('in-codigo').value.trim().toUpperCase();
  if (codigo.length !== 4) { showToast('🔑 El código tiene 4 caracteres'); $('in-codigo').focus(); return; }
  emitir('unirse_sala', { nombre, codigo, pid });
}

async function copiarEnlace() {
  try {
    await navigator.clipboard.writeText(enlaceInvitacion());
    showToast('🔗 Enlace copiado');
  } catch {
    prompt('Copia este enlace:', enlaceInvitacion());
  }
}

function salirSala() {
  if (socket && socket.connected) socket.emit('salir_sala');
  limpiarSesion();
  Screens.go('screen-join');
}

// ════════════════ SALA DE ESPERA ════════════════
const maxImpostores = () => Math.max(1, Math.floor(estado.jugadores.length / 2));

function actualizarSteppers() { $('vi').textContent = numImpostores; }

function adj(tipo, val) {
  if (Screens.current !== 'screen-lobby' || !estado.esHost || tipo !== 'i') return;
  numImpostores = Math.max(1, Math.min(maxImpostores(), numImpostores + val));
  actualizarSteppers();
}

function setCat(btn, cat) {
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('sel'));
  btn.classList.add('sel');
  catSeleccionada = cat;
}

function renderLobby() {
  $('room-code').textContent = estado.codigo || '----';
  const n = estado.jugadores.length;
  $('lobby-count').textContent = n;

  const ul = $('player-list');
  ul.replaceChildren();
  for (const j of estado.jugadores) {
    const li = document.createElement('li');
    li.textContent = `Jugador ${j.numero} · ${j.nombre}`
      + (j.esHost ? ' 👑' : '')
      + (j.numero === estado.miNumero ? ' (tú)' : '')
      + (j.conectado ? '' : ' · reconectando…');
    ul.appendChild(li);
  }

  // Solo el host ve la configuración y el botón de comenzar
  $('host-config').hidden = !estado.esHost;
  $('btn-start').hidden = !estado.esHost;
  $('lobby-wait').hidden = estado.esHost;

  numImpostores = Math.min(numImpostores, maxImpostores());
  actualizarSteppers();

  const faltan = MIN_JUG - n;
  const btn = $('btn-start');
  btn.disabled = faltan > 0;
  btn.textContent = faltan > 0 ? `Faltan ${faltan} jugador${faltan > 1 ? 'es' : ''}` : '▶ Comenzar';
}

// ════════════════ FLUJO DEL JUEGO ════════════════
function startGame() { // solo host: el servidor elige palabra, pista e impostores
  if (!estado.esHost) return;
  emitir('iniciar_partida', { categoria: catSeleccionada, impostores: numImpostores });
}

function renderTurno() {
  const t = estado.turnoActual;
  const esMio = t > 0 && t === estado.miNumero;
  const btn = $('btn-reveal');

  $('badge-cat').textContent = (estado.categoria || '').toUpperCase();
  $('tnum').textContent = t > 0 ? t : '…';
  $('ptxt').textContent = `${Math.max(t, 1)} / ${estado.total}`;
  $('pbar').style.width = `${(Math.max(t, 1) / Math.max(estado.total, 1)) * 100}%`;

  if (esMio) {
    $('tinstr').textContent = 'Es tu turno. Asegúrate de que nadie vea tu pantalla.';
    btn.textContent = '🔍  Revelar palabra';
    btn.disabled = estado.pendiente;
  } else {
    const quien = nombreDe(t);
    $('tinstr').textContent = t > 0
      ? `Esperando al Jugador ${t}${quien ? ' (' + quien + ')' : ''}…`
      : 'Esperando al siguiente jugador…';
    btn.textContent = t > 0 ? `⏳  Esperando al Jugador ${t}...` : '⏳  Esperando...';
    btn.disabled = true;
  }
}

function limpiarReveal() { // la palabra nunca queda en el DOM entre turnos
  $('wc-text').textContent = '—';
  $('wc-text').classList.remove('imp');
  $('wc-hint').style.display = 'none';
  $('wc-hint').textContent = '';
  $('wc-tag').textContent = '';
  $('wcard').classList.remove('impostor-card');
}

function showReveal() {
  if (Screens.current !== 'screen-turn') return;
  if (estado.turnoActual !== estado.miNumero || estado.pendiente) return;
  estado.pendiente = true;
  $('btn-reveal').disabled = true;
  if (!emitir('revelar_palabra')) { estado.pendiente = false; renderTurno(); }
}

function pintarReveal({ rol, palabra, pista, categoria }) {
  const wcWord = $('wc-text');
  const emoji = EMOJIS[categoria] || '❓';
  if (rol === 'impostor') {
    $('wcard').classList.add('impostor-card');
    $('wc-label').textContent = 'Tu rol';
    wcWord.textContent = 'ERES EL IMPOSTOR';
    wcWord.classList.add('imp');
    $('wc-hint').style.display = 'inline-block';
    $('wc-hint').textContent = `💡 Pista: "${pista}"`;
    $('wc-tag').textContent = '🤫 Mantén el secreto';
  } else {
    $('wcard').classList.remove('impostor-card');
    $('wc-label').textContent = 'Tu palabra secreta';
    wcWord.textContent = palabra;
    wcWord.classList.remove('imp');
    $('wc-hint').style.display = 'none';
    $('wc-tag').textContent = `${emoji} ${(categoria || '').toUpperCase()}`;
  }
}

function ackWord() {
  if (Screens.current !== 'screen-reveal') return;
  estado.turnoActual = 0; // mientras llega la respuesta del servidor mostramos "esperando"
  if (!emitir('confirmar_palabra_vista')) return;
  Screens.go('screen-turn', () => { limpiarReveal(); renderTurno(); });
}

// ════════════════ FIN DE REVELACIÓN / DEBATE ════════════════
function mostrarDebate(primero) {
  estado.fase = 'debate';
  Screens.go('screen-done', () => {
    limpiarReveal();
    $('st-p').textContent = estado.total;
    $('st-i').textContent = estado.impostores;
    $('st-c').textContent = EMOJIS[estado.categoria] || '❓';
    $('starter').textContent = primero
      ? `🎲 Empieza hablando el Jugador ${primero.numero} · ${primero.nombre}` : '';
    renderBotonesFinal();
  });
}

function renderBotonesFinal() {
  $('btn-again').hidden = !estado.esHost;
  $('btn-home').hidden = !estado.esHost;
  $('done-wait').hidden = estado.esHost;
}

function nextRound() { // solo host: misma configuración, nueva palabra
  if (Screens.current === 'screen-done' && estado.esHost) emitir('otra_ronda');
}

function goHome() { // solo host: vuelve a la sala para cambiar categoría/impostores
  if (Screens.current === 'screen-done' && estado.esHost) emitir('nueva_ronda');
}

// ════════════════ FONDO ANIMADO ════════════════
function initBackgroundCanvas() {
  const canvas = $('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h;
  const resize = () => { w = canvas.width = innerWidth; h = canvas.height = innerHeight; };
  resize();
  addEventListener('resize', resize);

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const particles = Array.from({ length: 30 }, () => ({
    x: Math.random() * w, y: Math.random() * h,
    r: Math.random() * 2 + 1,
    vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4
  }));

  function dibujar() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0, 200, 255, 0.4)';
    for (const p of particles) {
      if (!reduce) {
        p.x = (p.x + p.vx + w) % w;
        p.y = (p.y + p.vy + h) % h;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduce) requestAnimationFrame(dibujar);
  }
  dibujar();
}

// ════════════════ SERVICE WORKER ════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registrado:', reg.scope))
      .catch(err => console.error('Error al registrar el Service Worker:', err));
  });
}
