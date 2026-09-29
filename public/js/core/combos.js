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

/**
 * Recorre las velas CERRADAS una vez y anota dónde fue el último cruce.
 * Usa comboBull, el mismo criterio de "alcista" que el resto del screener.
 * @param {ArrayLike<number>} fastSeries pineEma de la rápida sobre las cerradas
 * @param {ArrayLike<number>} slowSeries pineEma de la lenta sobre las cerradas
 * @returns {{lastCross:number, lastBull:boolean|null, firstBoth:number}}
 *   lastCross: índice de la última vela donde cambió de lado (-1 si nunca);
 *   lastBull: lado al cierre de ayer (null si la lenta aún no imprimía);
 *   firstBoth: primera vela con las dos EMAs impresas (-1 si ninguna).
 */
export function scanClosedCrosses(fastSeries, slowSeries) {
  let lastCross = -1;
  let firstBoth = -1;
  let prev = null;
  for (let t = 0; t < slowSeries.length; t++) {
    const bull = comboBull(fastSeries[t], slowSeries[t]);
    if (bull === null) continue;
    if (firstBoth === -1) firstBoth = t;
    else if (bull !== prev) lastCross = t;
    prev = bull;
  }
  return { lastCross, lastBull: prev, firstBoth };
}

/**
 * Velas desde el último cruce, con la vela de hoy (en curso) = 0, ayer = 1…
 * Si no se vio ningún cruce, la edad es solo un MÍNIMO: no hubo cruce en las
 * últimas `edad` velas, pero no se sabe cuándo fue el anterior.
 * @param {object} scan resultado de scanClosedCrosses
 * @param {number} closedCount cantidad de velas cerradas (= índice de la de hoy)
 * @param {boolean} nowBull lado de hoy
 * @returns {[number, boolean]} [edad, esMinimo]
 */
export function crossAge(scan, closedCount, nowBull) {
  const today = closedCount;
  if (scan.lastBull !== null && scan.lastBull !== nowBull) return [0, false]; // cruza hoy
  if (scan.lastCross >= 0) return [today - scan.lastCross, false];
  const first = scan.firstBoth === -1 ? today : scan.firstBoth; // -1: la lenta imprime recién hoy
  return [today - first, true];
}

/**
 * Filtro por antigüedad del último cruce: rango [min, max] en velas.
 * Sin límites no filtra. Con límites, un combo sin dato no pasa; y uno sin
 * cruce a la vista (edad = mínimo) solo pasa si el mínimo alcanza para
 * afirmarlo: nunca con un tope, porque no se sabe cuán viejo es.
 */
export function passesCrossAgeFilter(status, min = 0, max = Infinity) {
  if (min <= 0 && max === Infinity) return true;
  if (status === null || status === undefined) return false;
  const [, , age, isMinimum] = status;
  if (isMinimum) return max === Infinity && age >= min;
  return age >= min && age <= max;
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
