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

/** Un cruce es "próximo" si al precio le falta moverse menos que esto hoy. */
export const NEAR_CROSS_PCT = 5;

/**
 * Estado de un combo, numerado de más alcista a más bajista para ordenar.
 * El lado alcista (rápida ≥ lenta ahora) es 5, 4 y 3; el bajista, 2, 1 y 0.
 */
export const STATE = {
  UP: 5, // alcista
  CROSS_UP: 4, // cruce alcista en curso: ayer bajista, hoy alcista
  NEAR_DOWN: 3, // alcista, pero una baja de menos de 5% hoy la cruzaría
  NEAR_UP: 2, // bajista, pero una suba de menos de 5% hoy la cruzaría
  CROSS_DOWN: 1, // cruce bajista en curso: ayer alcista, hoy bajista
  DOWN: 0, // bajista
};

/** Alcista = la rápida arriba o igual que la lenta. null si alguna no imprimió. */
export function comboBull(fast, slow) {
  if (fast === null || slow === null || !Number.isFinite(fast) || !Number.isFinite(slow)) return null;
  return fast >= slow;
}

/**
 * Precio al que la rápida y la lenta quedan iguales en la vela de hoy.
 * Las dos EMAs de hoy son lineales en el precio:
 *   F = aF·p + (1−aF)·F_ayer      S = aS·p + (1−aS)·S_ayer
 * y F = S da  p* = ((1−aS)·S_ayer − (1−aF)·F_ayer) / (aF − aS).
 */
export function crossPrice(fastYesterday, slowYesterday, fastLength, slowLength) {
  const aF = 2 / (fastLength + 1);
  const aS = 2 / (slowLength + 1);
  return ((1 - aS) * slowYesterday - (1 - aF) * fastYesterday) / (aF - aS);
}

/**
 * Estado del combo en la vela diaria en curso.
 * @param {object} fastState estado de la EMA rápida sobre velas cerradas (pineEmaState)
 * @param {object} slowState estado de la EMA lenta
 * @param {number|null} fast valor de hoy de la rápida (null si no imprime)
 * @param {number|null} slow valor de hoy de la lenta
 * @param {number} live precio actual
 * @returns {[number, number|null] | null} [estado, % que le falta al precio] o null
 */
export function comboStatus(fastState, slowState, fast, slow, live) {
  const now = comboBull(fast, slow);
  if (now === null) return null;

  // Ayer: solo si las dos EMAs ya imprimían con las velas cerradas.
  const hadYesterday =
    fastState.count >= fastState.length && slowState.count >= slowState.length &&
    Number.isFinite(fastState.last) && Number.isFinite(slowState.last);
  if (!hadYesterday) return [now ? STATE.UP : STATE.DOWN, null];

  const before = fastState.last >= slowState.last;
  if (before !== now) return [now ? STATE.CROSS_UP : STATE.CROSS_DOWN, null];

  const target = crossPrice(fastState.last, slowState.last, fastState.length, slowState.length);
  if (target > 0 && Number.isFinite(live) && live > 0) {
    const pct = (Math.abs(target - live) / live) * 100;
    if (pct < NEAR_CROSS_PCT) return [now ? STATE.NEAR_DOWN : STATE.NEAR_UP, Number(pct.toFixed(2))];
  }
  return [now ? STATE.UP : STATE.DOWN, null];
}

/** Opciones del filtro de cada combo. Un combo sin dato no pasa por ninguna, salvo "todos". */
export const COMBO_FILTERS = {
  all: { label: 'todos', accepts: null },
  bull: { label: 'alcista', accepts: [STATE.UP, STATE.CROSS_UP, STATE.NEAR_DOWN] },
  bear: { label: 'bajista', accepts: [STATE.NEAR_UP, STATE.CROSS_DOWN, STATE.DOWN] },
  cross: { label: 'cruce en curso', accepts: [STATE.CROSS_UP, STATE.CROSS_DOWN] },
  crossUp: { label: 'cruce alcista en curso', accepts: [STATE.CROSS_UP] },
  crossDown: { label: 'cruce bajista en curso', accepts: [STATE.CROSS_DOWN] },
  near: { label: 'próximo cruce', accepts: [STATE.NEAR_UP, STATE.NEAR_DOWN] },
  nearUp: { label: 'próximo cruce alcista', accepts: [STATE.NEAR_UP] },
  nearDown: { label: 'próximo cruce bajista', accepts: [STATE.NEAR_DOWN] },
};

export function passesComboFilter(code, filter) {
  const def = COMBO_FILTERS[filter] ?? COMBO_FILTERS.all;
  if (def.accepts === null) return true;
  return code !== null && code !== undefined && def.accepts.includes(code);
}
