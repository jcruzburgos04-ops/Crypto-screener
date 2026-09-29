// Señales candidatas y su evaluación honesta: cuántas veces aciertan, no solo
// cuántas subidas "tenían" la señal.

import { findEpisodes, median } from './analysis.mjs';

const fin = Number.isFinite;

/** Señales a evaluar. Cada una mira solo rasgos del pasado de la hora i. */
export const RULES = [
  { id: 'vol1h_5x', desc: 'volumen de la hora ≥ 5× lo normal', test: (x) => x.vol_1h_x >= 5 },
  { id: 'vol24h_3x', desc: 'volumen de 24 h ≥ 3× lo normal', test: (x) => x.vol_24h_x >= 3 },
  { id: 'oi4h_20', desc: 'open interest +20% en 4 h', test: (x) => x.oi_4h >= 0.2 },
  { id: 'oi24h_50', desc: 'open interest +50% en 24 h', test: (x) => x.oi_24h >= 0.5 },
  { id: 'fund_neg', desc: 'funding ≤ −0,1% (shorts pagando)', test: (x) => x.funding <= -0.001 },
  { id: 'oi24h_20_fund_neg', desc: 'OI +20% en 24 h y funding < 0 (shorts acumulándose)', test: (x) => x.oi_24h >= 0.2 && x.funding < 0 },
  { id: 'ls_short_oi', desc: 'mayoría de cuentas en corto (<40% largos) y OI +10% en 24 h', test: (x) => x.ls_buy < 0.4 && x.oi_24h >= 0.1 },
  { id: 'ret24h_20', desc: 'ya subió +20% en 24 h (subirse al movimiento)', test: (x) => x.ret_24h >= 0.2 },
  { id: 'ret4h_15_vol', desc: '+15% en 4 h con volumen de la hora ≥ 5×', test: (x) => x.ret_4h >= 0.15 && x.vol_1h_x >= 5 },
  { id: 'squeeze_vol', desc: 'compresión (rango ≤ 0,5× lo normal) y volumen ≥ 3×', test: (x) => x.range_x <= 0.5 && x.vol_1h_x >= 3 },
];

function rowAt(features, i) {
  const row = {};
  for (const [name, values] of Object.entries(features)) row[name] = values[i];
  return row;
}

function newStats() {
  return { hours: 0, hits: 0, trades: 0, tradeHits: 0, ret: [], gain: [], dd: [] };
}

/**
 * Acumulador: se le pasan los símbolos de a uno (para no tener cientos de MB
 * en memoria) y al final devuelve el resumen.
 * @param {{horizon:number, splitMs:number}} opts splitMs separa primera y segunda mitad
 */
export function createEvaluator({ horizon, splitMs }) {
  const halves = ['all', 'first', 'second'];
  const base = Object.fromEntries(halves.map((h) => [h, { hours: 0, hits: 0 }]));
  const stats = Object.fromEntries(RULES.map((r) => [r.id, Object.fromEntries(halves.map((h) => [h, newStats()]))]));
  const episodeHits = Object.fromEntries(RULES.map((r) => [r.id, { catch: 0, early: 0 }]));
  let episodes = 0;

  function add({ frame, features, fwd }) {
    const cooldown = Object.fromEntries(RULES.map((r) => [r.id, -1]));
    const fired = Object.fromEntries(RULES.map((r) => [r.id, new Uint8Array(frame.n)]));

    for (let i = 0; i < frame.n; i++) {
      const lab = fwd.label[i];
      if (lab !== 0 && lab !== 1) continue;
      const half = frame.t0 + (i + 1) * 3_600_000 < splitMs ? 'first' : 'second';
      for (const h of ['all', half]) { base[h].hours++; base[h].hits += lab; }
      const row = rowAt(features, i);
      for (const rule of RULES) {
        if (!rule.test(row)) continue;
        fired[rule.id][i] = 1;
        const tradable = i > cooldown[rule.id];
        if (tradable) cooldown[rule.id] = i + horizon - 1; // una entrada por ventana
        for (const h of ['all', half]) {
          const st = stats[rule.id][h];
          st.hours++;
          st.hits += lab;
          if (tradable) {
            st.trades++;
            st.tradeHits += lab;
            st.ret.push(fwd.retH[i]);
            st.gain.push(fwd.maxGain[i]);
            st.dd.push(fwd.maxDrawdown[i]);
          }
        }
      }
    }

    for (const ep of findEpisodes(fwd.label)) {
      episodes++;
      for (const rule of RULES) {
        const f = fired[rule.id];
        let caught = false;
        for (let i = ep.start; i <= ep.end && !caught; i++) caught = f[i] === 1;
        let early = false;
        for (let i = Math.max(0, ep.start - 24); i < ep.start && !early; i++) early = f[i] === 1;
        if (caught) episodeHits[rule.id].catch++;
        if (early) episodeHits[rule.id].early++;
      }
    }
  }

  function summarize(st, b) {
    const baseRate = b.hours ? b.hits / b.hours : NaN;
    const precision = st.hours ? st.hits / st.hours : NaN;
    const rets = st.ret.filter(fin);
    return {
      hours: st.hours,
      precision,
      lift: precision / baseRate,
      trades: st.trades,
      tradePrecision: st.trades ? st.tradeHits / st.trades : NaN,
      medianRet: median(st.ret),
      meanRet: rets.length ? rets.reduce((a, v) => a + v, 0) / rets.length : NaN,
      medianMaxGain: median(st.gain),
      medianMaxDrawdown: median(st.dd),
    };
  }

  function result() {
    return {
      episodes,
      hours: base.all.hours,
      baseRate: Object.fromEntries(halves.map((h) => [h, base[h].hours ? base[h].hits / base[h].hours : NaN])),
      rules: RULES.map((rule) => ({
        id: rule.id,
        desc: rule.desc,
        ...Object.fromEntries(halves.map((h) => [h, summarize(stats[rule.id][h], base[h])])),
        catchRate: episodes ? episodeHits[rule.id].catch / episodes : NaN,
        earlyRate: episodes ? episodeHits[rule.id].early / episodes : NaN,
      })),
    };
  }

  return { add, result };
}

/** Atajo para pocos símbolos (pruebas). */
export function evaluate(symbols, opts) {
  const ev = createEvaluator(opts);
  for (const s of symbols) ev.add(s);
  return ev.result();
}

/**
 * Muestra uniforme de tamaño fijo (reservoir) con azar determinista: el AUC
 * contra millones de horas sin subida no necesita guardarlas todas.
 */
export function createReservoir(size, seed = 12345) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const items = [];
  let seen = 0;
  return {
    push(value) {
      seen++;
      if (items.length < size) items.push(value);
      else {
        const j = Math.floor(rand() * seen);
        if (j < size) items[j] = value;
      }
    },
    get values() { return items; },
    get seen() { return seen; },
  };
}
