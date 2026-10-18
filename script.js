// ════════════════ ESTADO ════════════════
const MIN_JUG = 3, MAX_JUG = 20;
let numJugadores = 4, numImpostores = 1, catSeleccionada = 'animales';
let palabraActualObj = null, pistaActual = '';
let listaRoles = [], turnoActual = 0, cargando = false;

const cacheDatos = {};   // categoría -> palabras (evita recargar el JSON)
const usadas = {};       // categoría -> Set de palabras ya jugadas (evita repetir)

const EMOJIS = { animales: '🐾', futbolistas: '⚽', paises: '🌍', peliculas: '🎬', videojuegos: '🎮' };
const $ = id => document.getElementById(id);

// ════════════════ CONTROL DE PANTALLAS ════════════════
// Una sola pantalla activa; la nueva aparece solo cuando la anterior ya se ocultó.
// `busy` bloquea toques dobles durante la transición (evita saltarse turnos).
const Screens = {
  current: 'screen-config',
  busy: false,
  DELAY: 240,

  init() {
    document.querySelectorAll('.screen').forEach(s => {
      const on = s.id === this.current;
      s.classList.toggle('active', on);
      s.inert = !on;
      s.setAttribute('aria-hidden', String(!on));
    });
  },

  go(toId, beforeShow) {
    if (this.busy || toId === this.current) return false;
    const from = $(this.current), to = $(toId);
    if (!to) return false;
    this.busy = true;
    from.classList.remove('active');
    from.inert = true;
    from.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      if (beforeShow) beforeShow();
      to.inert = false;
      to.setAttribute('aria-hidden', 'false');
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
});

// ════════════════ CONFIGURACIÓN ════════════════
const maxImpostores = () => Math.floor(numJugadores / 2);

function actualizarSteppers() {
  $('vp').textContent = numJugadores;
  $('vi').textContent = numImpostores;
}

function adj(tipo, val) {
  if (Screens.current !== 'screen-config') return;
  if (tipo === 'p') {
    numJugadores = Math.max(MIN_JUG, Math.min(MAX_JUG, numJugadores + val));
    numImpostores = Math.min(numImpostores, maxImpostores()); // siempre válido
  } else {
    numImpostores = Math.max(1, Math.min(maxImpostores(), numImpostores + val));
  }
  actualizarSteppers();
}

function setCat(btn, cat) {
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('sel'));
  btn.classList.add('sel');
  catSeleccionada = cat;
}

let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ════════════════ UTILIDADES ════════════════
const azar = arr => arr[Math.floor(Math.random() * arr.length)];

function mezclar(arr) { // Fisher-Yates
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function cargarCategoria(cat) {
  if (cacheDatos[cat]) return cacheDatos[cat];
  const resp = await fetch(`./data/${cat}.json`);
  if (!resp.ok) throw new Error('No se pudo cargar el archivo');
  return (cacheDatos[cat] = await resp.json());
}

function elegirPalabra(banco, cat) {
  const usadasCat = usadas[cat] || (usadas[cat] = new Set());
  let libres = banco.filter(p => !usadasCat.has(p.palabra));
  if (!libres.length) { usadasCat.clear(); libres = banco; } // reinicia al agotar
  const elegida = azar(libres);
  usadasCat.add(elegida.palabra);
  return elegida;
}

// ════════════════ FLUJO DEL JUEGO ════════════════
async function startGame() {
  if (cargando || Screens.busy) return;
  cargando = true;
  try {
    const banco = await cargarCategoria(catSeleccionada);
    if (!Array.isArray(banco) || !banco.length) {
      showToast('⚠️ La categoría está vacía');
      return;
    }
    palabraActualObj = elegirPalabra(banco, catSeleccionada);
    const pistas = palabraActualObj.pistas || [];
    pistaActual = pistas.length ? azar(pistas) : 'Sin pista disponible';

    listaRoles = mezclar([
      ...Array(numImpostores).fill('IMPOSTOR'),
      ...Array(numJugadores - numImpostores).fill('INOCENTE')
    ]);
    turnoActual = 0;
    Screens.go('screen-turn', prepararPantallaTurno);
  } catch (err) {
    console.error(err);
    showToast('⚠️ Error al cargar los datos de ' + catSeleccionada);
  } finally {
    cargando = false;
  }
}

function prepararPantallaTurno() {
  const actual = turnoActual + 1;
  $('badge-cat').textContent = catSeleccionada.toUpperCase();
  $('tnum').textContent = actual;
  $('ptxt').textContent = `${actual} / ${numJugadores}`;
  $('pbar').style.width = `${(actual / numJugadores) * 100}%`;
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
  if (Screens.current !== 'screen-turn' || Screens.busy) return;
  const esImpostor = listaRoles[turnoActual] === 'IMPOSTOR';
  const emoji = EMOJIS[catSeleccionada] || '❓';

  Screens.go('screen-reveal', () => {
    const wcWord = $('wc-text');
    if (esImpostor) {
      $('wcard').classList.add('impostor-card');
      $('wc-label').textContent = 'Tu rol';
      wcWord.textContent = 'ERES EL IMPOSTOR';
      wcWord.classList.add('imp');
      $('wc-hint').style.display = 'inline-block';
      $('wc-hint').textContent = `💡 Pista: "${pistaActual}"`;
      $('wc-tag').textContent = '🤫 Mantén el secreto';
    } else {
      $('wcard').classList.remove('impostor-card');
      $('wc-label').textContent = 'Tu palabra secreta';
      wcWord.textContent = palabraActualObj.palabra;
      wcWord.classList.remove('imp');
      $('wc-hint').style.display = 'none';
      $('wc-tag').textContent = `${emoji} ${catSeleccionada.toUpperCase()}`;
    }
  });
}

function ackWord() {
  if (Screens.current !== 'screen-reveal' || Screens.busy) return;
  turnoActual++;
  if (turnoActual < numJugadores) {
    Screens.go('screen-turn', () => { limpiarReveal(); prepararPantallaTurno(); });
  } else {
    Screens.go('screen-done', () => {
      limpiarReveal();
      $('st-p').textContent = numJugadores;
      $('st-i').textContent = numImpostores;
      $('st-c').textContent = EMOJIS[catSeleccionada] || '❓';
      $('starter').textContent = `🎲 Empieza hablando el Jugador ${Math.floor(Math.random() * numJugadores) + 1}`;
    });
  }
}

function nextRound() {
  if (Screens.current !== 'screen-done') return;
  startGame();
}

function goHome() {
  if (Screens.current !== 'screen-done') return;
  Screens.go('screen-config');
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