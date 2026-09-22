// Combos de medias de la banda diaria del indicador de Pine (anclados a 1D).
// Con velas diarias el modo Automático del Pine toma la vía exacta, así que
// las longitudes van tal cual, sin escalar.
//
// ÚNICO lugar donde se define qué velas se descargan. Si cambia, cambia acá.

export const KLINE_INTERVAL = 'D'; // vela diaria de Bybit: abre a las 00:00 UTC
export const KLINE_LIMIT = 1000; // máximo de Bybit por pedido; un pedido por símbolo
export const DAY_MS = 24 * 60 * 60_000;

export const COMBOS = [
  { id: 'c1', fast: 21, slow: 34 }, // rápido: da el sesgo
  { id: 'c2', fast: 55, slow: 115 }, // medio
  { id: 'c3', fast: 300, slow: 600 }, // tendencia de fondo
];

/** Longitudes en el orden en que viajan en el snapshot (`ema`). */
export const EMA_LENGTHS = COMBOS.flatMap((c) => [c.fast, c.slow]);

/**
 * Alcista = la rápida arriba o igual que la lenta. null si alguna de las dos
 * no imprimió: no se puede afirmar nada, y no se inventa.
 */
export function comboBull(fast, slow) {
  if (fast === null || slow === null || !Number.isFinite(fast) || !Number.isFinite(slow)) return null;
  return fast >= slow;
}

/**
 * Régimen del combo 1 (rápido, R) contra el combo 2 (medio, M):
 *   3 = R+ M+   2 = R− M+   1 = R+ M−   0 = R− M−   null = no se puede afirmar
 */
export function regime(rapidoBull, medioBull) {
  if (rapidoBull === null || medioBull === null) return null;
  return (medioBull ? 2 : 0) + (rapidoBull ? 1 : 0);
}

export const REGIME_LABELS = { 3: 'R+ M+', 2: 'R− M+', 1: 'R+ M−', 0: 'R− M−' };

/** Opciones del filtro de régimen: los cuatro estados y dos atajos por el medio. */
export const REGIME_FILTERS = {
  all: { label: 'todos', accepts: null },
  3: { label: 'R+ M+', accepts: [3] },
  2: { label: 'R− M+', accepts: [2] },
  1: { label: 'R+ M−', accepts: [1] },
  0: { label: 'R− M−', accepts: [0] },
  midUp: { label: 'medio alcista', accepts: [3, 2] },
  midDown: { label: 'medio bajista', accepts: [1, 0] },
};

export function passesRegimeFilter(rg, filter) {
  const def = REGIME_FILTERS[filter] ?? REGIME_FILTERS.all;
  if (def.accepts === null) return true;
  return rg !== null && rg !== undefined && def.accepts.includes(rg);
}

/**
 * Filtro del fondo 300/600. Un símbolo sin EMA 600 (fd === null) no pasa por
 * NINGUNO de los dos lados: su fondo no se puede afirmar.
 */
export function passesTrendFilter(fd, filter) {
  if (filter === 'up') return fd === 1;
  if (filter === 'down') return fd === 0;
  return true;
}

/**
 * Lee los tres combos a partir de los valores de las seis EMAs (null = no
 * imprimió) y devuelve lo que viaja al navegador.
 */
export function evaluateCombos(emas) {
  const bulls = COMBOS.map((_, i) => comboBull(emas[2 * i], emas[2 * i + 1]));
  const fondo = bulls[2];
  return {
    ema: emas,
    rg: regime(bulls[0], bulls[1]),
    fd: fondo === null ? null : fondo ? 1 : 0,
  };
}
