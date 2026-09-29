// Estudio de eventos: ¿qué muestra un perpetuo ANTES de subir +50%?
//
// Todo es código puro sobre series horarias ya descargadas. Reglas del estudio:
//   - Sin mirar el futuro: la hora k solo usa velas con inicio <= k, y OI/ratio
//     long-short con una hora de retraso (no está documentado si su marca de
//     tiempo es el inicio o el fin del intervalo; se asume lo peor).
//   - La etiqueta mira SOLO el futuro: ¿el máximo de las próximas H velas llega
//     a +umbral sobre el cierre de la hora k? Es la pregunta de quien entra en k.
//   - Cada señal se mide contra TODAS las horas, no solo contra las de subida:
//     precisión (cuántas veces acierta) además de recall (cuántas detecta).

export const HOUR_MS = 3_600_000;

const nan = (n) => new Float64Array(n).fill(NaN);

/**
 * Arma una grilla horaria contigua con precio, volumen, OI, funding y ratio.
 * @param {object} series
 * @param {Array<{t,o,h,l,c,q}>} series.klines velas de 1h (t = inicio, q = turnover USD)
 * @param {Array<{t,oi}>} series.oi open interest (contratos) con su marca de tiempo
 * @param {Array<{t,rate}>} series.funding liquidaciones de funding
 * @param {Array<{t,buy}>} series.ls proporción de cuentas compradas (0..1)
 */
export function buildFrame({ klines, oi = [], funding = [], ls = [] }) {
  if (klines.length === 0) return null;
  const sorted = [...klines].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t;
  const n = Math.round((sorted.at(-1).t - t0) / HOUR_MS) + 1;
  const f = { n, t0, o: nan(n), h: nan(n), l: nan(n), c: nan(n), q: nan(n), oi: nan(n), fund: nan(n), ls: nan(n) };
  for (const k of sorted) {
    const i = Math.round((k.t - t0) / HOUR_MS);
    f.o[i] = k.o; f.h[i] = k.h; f.l[i] = k.l; f.c[i] = k.c; f.q[i] = k.q;
  }
  // Al cierre de la hora i (instante t0 + (i+1)h) se conoce lo marcado hasta
  // ese instante; OI y ratio además con una hora de retraso.
  fillAsOf(f.oi, oi, (x) => x.oi, t0, HOUR_MS);
  fillAsOf(f.ls, ls, (x) => x.buy, t0, HOUR_MS);
  fillAsOf(f.fund, funding, (x) => x.rate, t0, 0);
  return f;
}

/** out[i] = último valor con marca <= cierre de la hora i − lag. */
function fillAsOf(out, points, value, t0, lagMs) {
  const pts = [...points].filter((p) => Number.isFinite(p.t) && Number.isFinite(value(p))).sort((a, b) => a.t - b.t);
  let j = -1;
  for (let i = 0; i < out.length; i++) {
    const knownAt = t0 + (i + 1) * HOUR_MS - lagMs;
    while (j + 1 < pts.length && pts[j + 1].t <= knownAt) j++;
    if (j >= 0) out[i] = value(pts[j]);
  }
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : NaN);
const change = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b - 1 : NaN);

/** Nombres y descripción de cada rasgo, en el orden en que se calculan. */
export const FEATURES = [
  ['ret_1h', 'variación de precio en la última hora'],
  ['ret_4h', 'variación de precio en 4 h'],
  ['ret_24h', 'variación de precio en 24 h'],
  ['vol_1h_x', 'volumen de la última hora ÷ mediana horaria de los 7 días previos'],
  ['vol_24h_x', 'volumen medio de las últimas 24 h ÷ mediana horaria de los 7 días previos'],
  ['oi_4h', 'cambio del open interest (contratos) en 4 h'],
  ['oi_24h', 'cambio del open interest (contratos) en 24 h'],
  ['funding', 'último funding liquidado'],
  ['ls_buy', 'proporción de cuentas en largo (ratio long/short de Bybit)'],
  ['ls_24h', 'cambio de esa proporción en 24 h (puntos)'],
  ['range_x', 'rango medio de las velas en 24 h ÷ el de los 30 días previos (<1 = compresión)'],
];

/** Calcula los rasgos de cada hora usando solo el pasado. */
export function computeFeatures(f) {
  const out = Object.fromEntries(FEATURES.map(([name]) => [name, nan(f.n)]));
  const range = nan(f.n);
  for (let i = 0; i < f.n; i++) range[i] = ratio(f.h[i] - f.l[i], f.c[i]);

  for (let i = 0; i < f.n; i++) {
    out.ret_1h[i] = i >= 1 ? change(f.c[i], f.c[i - 1]) : NaN;
    out.ret_4h[i] = i >= 4 ? change(f.c[i], f.c[i - 4]) : NaN;
    out.ret_24h[i] = i >= 24 ? change(f.c[i], f.c[i - 24]) : NaN;

    if (i >= 168 + 24) {
      const base = median(Array.from(f.q.subarray(i - 168 - 24, i - 24)));
      out.vol_1h_x[i] = ratio(f.q[i], base);
      let sum = 0;
      let ok = true;
      for (let k = i - 23; k <= i; k++) { if (!Number.isFinite(f.q[k])) ok = false; sum += f.q[k]; }
      out.vol_24h_x[i] = ok ? ratio(sum / 24, base) : NaN;
    }
    out.oi_4h[i] = i >= 4 ? change(f.oi[i], f.oi[i - 4]) : NaN;
    out.oi_24h[i] = i >= 24 ? change(f.oi[i], f.oi[i - 24]) : NaN;
    out.funding[i] = f.fund[i];
    out.ls_buy[i] = f.ls[i];
    out.ls_24h[i] = i >= 24 && Number.isFinite(f.ls[i]) && Number.isFinite(f.ls[i - 24]) ? f.ls[i] - f.ls[i - 24] : NaN;

    if (i >= 720 + 24) {
      let recent = 0;
      let prior = 0;
      let ok = true;
      for (let k = i - 23; k <= i; k++) { if (!Number.isFinite(range[k])) ok = false; recent += range[k]; }
      for (let k = i - 720 - 24 + 1; k <= i - 24; k++) { if (!Number.isFinite(range[k])) ok = false; prior += range[k]; }
      out.range_x[i] = ok ? ratio(recent / 24, prior / 720) : NaN;
    }
  }
  return out;
}

/**
 * Resultado de entrar al cierre de la hora i y mirar las H horas siguientes.
 * label = 1 si el máximo llega a +threshold; NaN si no hay H horas completas.
 */
export function labelForward(f, horizon, threshold) {
  const label = nan(f.n);
  const maxGain = nan(f.n);
  const maxDrawdown = nan(f.n);
  const retH = nan(f.n);
  for (let i = 0; i + horizon < f.n; i++) {
    if (!Number.isFinite(f.c[i])) continue;
    let hi = -Infinity;
    let lo = Infinity;
    let ok = true;
    for (let k = i + 1; k <= i + horizon; k++) {
      if (!Number.isFinite(f.h[k]) || !Number.isFinite(f.l[k])) { ok = false; break; }
      if (f.h[k] > hi) hi = f.h[k];
      if (f.l[k] < lo) lo = f.l[k];
    }
    if (!ok) continue;
    maxGain[i] = hi / f.c[i] - 1;
    maxDrawdown[i] = lo / f.c[i] - 1;
    retH[i] = f.c[i + horizon] / f.c[i] - 1;
    label[i] = maxGain[i] >= threshold ? 1 : 0;
  }
  return { label, maxGain, maxDrawdown, retH };
}

/**
 * Episodios de subida: tramos contiguos de horas con label = 1. `start` es la
 * primera hora desde la que se podía entrar y ganar +umbral en H horas.
 */
export function findEpisodes(label) {
  const episodes = [];
  let start = -1;
  for (let i = 0; i <= label.length; i++) {
    const on = i < label.length && label[i] === 1;
    if (on && start === -1) start = i;
    if (!on && start !== -1) {
      episodes.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return episodes;
}

/**
 * AUC de Mann-Whitney: probabilidad de que una hora de subida tenga un valor
 * mayor que una hora cualquiera sin subida. 0,5 = no distingue nada; los
 * empates cuentan medio.
 */
export function auc(positives, negatives) {
  const pos = positives.filter(Number.isFinite);
  const neg = negatives.filter(Number.isFinite);
  if (pos.length === 0 || neg.length === 0) return NaN;
  const all = pos.map((v) => [v, 1]).concat(neg.map((v) => [v, 0])).sort((a, b) => a[0] - b[0]);
  let rankSumPos = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const avgRank = (i + j) / 2 + 1; // rangos 1-based con promedio en empates
    for (let k = i; k <= j; k++) if (all[k][1] === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

export { median };
