import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, computeFeatures, labelForward, findEpisodes, auc, FEATURES, HOUR_MS } from '../research/lib/analysis.mjs';
import { evaluate, createReservoir, RULES } from '../research/lib/signals.mjs';
import { walkBackward } from '../research/lib/history.mjs';
import { runStudy } from '../research/pump-study.mjs';
import { renderReport, episodesCsv } from '../research/lib/report.mjs';
import { createFakeHistoryFetch } from './helpers/fake-bybit-history.js';

const T0 = Date.UTC(2026, 0, 1);
const candle = (i, c, extra = {}) => ({ t: T0 + i * HOUR_MS, o: c, h: c, l: c, c, q: 1000, ...extra });

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- grilla

test('la grilla deja huecos donde faltan velas', () => {
  const f = buildFrame({ klines: [candle(0, 10), candle(1, 11), candle(3, 13)] });
  assert.equal(f.n, 4);
  assert.deepEqual([...f.c].map((v) => (Number.isNaN(v) ? null : v)), [10, 11, null, 13]);
});

test('OI y ratio long/short entran con una hora de retraso; el funding, al liquidarse', () => {
  const klines = [0, 1, 2, 3].map((i) => candle(i, 10));
  // Marcas al cierre de la hora 0 (= inicio de la hora 1).
  const f = buildFrame({
    klines,
    oi: [{ t: T0, oi: 100 }, { t: T0 + HOUR_MS, oi: 200 }],
    ls: [{ t: T0 + HOUR_MS, buy: 0.3 }],
    funding: [{ t: T0 + HOUR_MS, rate: -0.01 }, { t: T0 + 2 * HOUR_MS, rate: -0.02 }],
  });
  assert.deepEqual([...f.oi], [100, 200, 200, 200], 'la marca de t0+1h recién se usa en la hora 1');
  assert.ok(Number.isNaN(f.ls[0]) && f.ls[1] === 0.3);
  assert.deepEqual([...f.fund], [-0.01, -0.02, -0.02, -0.02], 'cada funding se conoce desde la hora en cuyo cierre se liquida, no antes');
});

// ---------------------------------------------------------------- sin mirar el futuro

test('ningún rasgo de la hora i cambia si se altera todo lo posterior a i', () => {
  const rnd = mulberry32(7);
  const n = 900;
  let p = 100;
  const klines = [];
  const oi = [];
  const ls = [];
  const funding = [];
  for (let i = 0; i < n; i++) {
    p *= 1 + (rnd() - 0.5) * 0.04;
    klines.push(candle(i, p, { h: p * 1.01, l: p * 0.99, q: 1000 + rnd() * 5000 }));
    oi.push({ t: T0 + i * HOUR_MS, oi: 5000 + rnd() * 1000 });
    ls.push({ t: T0 + i * HOUR_MS, buy: 0.4 + rnd() * 0.2 });
    if (i % 8 === 0) funding.push({ t: T0 + i * HOUR_MS, rate: (rnd() - 0.5) * 0.002 });
  }
  const full = computeFeatures(buildFrame({ klines, oi, ls, funding }));
  for (const i of [800, 850, 899 - 30]) {
    const cutT = T0 + (i + 1) * HOUR_MS; // todo lo marcado después del cierre de i
    const bump = (x) => (x.t >= cutT ? { ...x, c: x.c * 5, h: x.h * 5, l: x.l * 5, q: x.q * 50, oi: (x.oi ?? 0) * 9, buy: 0.99, rate: 0.5 } : x);
    const altered = computeFeatures(buildFrame({
      klines: klines.map((k) => (k.t > T0 + i * HOUR_MS ? bump({ ...k, t: k.t }) : k)),
      oi: oi.map((x) => (x.t >= cutT ? { ...x, oi: x.oi * 9 } : x)),
      ls: ls.map((x) => (x.t >= cutT ? { ...x, buy: 0.99 } : x)),
      funding: funding.map((x) => (x.t > cutT ? { ...x, rate: 0.5 } : x)),
    }));
    for (const [name] of FEATURES) {
      const a = full[name][i];
      const b = altered[name][i];
      assert.ok(Object.is(a, b) || a === b, `${name}[${i}] miró el futuro: ${a} != ${b}`);
    }
    assert.ok(FEATURES.every(([name]) => Number.isFinite(full[name][i])), `hora ${i}: todos los rasgos deberían existir`);
  }
});

test('valores exactos de los rasgos en una serie armada a mano', () => {
  const n = 1000;
  const i = 900;
  const klines = Array.from({ length: n }, (_, k) => {
    const c = k === i - 24 ? 80 : k === i - 4 ? 90 : k === i - 1 ? 95 : 100;
    const spread = k > i - 24 && k <= i ? 0.02 : 0.01; // rango doble en las últimas 24 h
    return { t: T0 + k * HOUR_MS, o: c, h: c * (1 + spread), l: c * (1 - spread), c, q: k === i ? 7000 : 1000 };
  });
  const oi = Array.from({ length: n }, (_, k) => ({ t: T0 + k * HOUR_MS, oi: k === i ? 1500 : k === i - 4 ? 1200 : 1000 }));
  const ls = Array.from({ length: n }, (_, k) => ({ t: T0 + k * HOUR_MS, buy: k === i ? 0.35 : 0.5 }));
  const funding = [{ t: T0 + (i - 3) * HOUR_MS, rate: -0.002 }];
  const x = computeFeatures(buildFrame({ klines, oi, ls, funding }));
  const eq = (name, expected) => assert.ok(Math.abs(x[name][i] - expected) < 1e-9, `${name}: ${x[name][i]} != ${expected}`);
  eq('ret_1h', 100 / 95 - 1);
  eq('ret_4h', 100 / 90 - 1);
  eq('ret_24h', 0.25);
  eq('vol_1h_x', 7); // 7000 contra una mediana de 1000
  eq('vol_24h_x', (23 * 1000 + 7000) / 24 / 1000);
  eq('oi_4h', 1500 / 1200 - 1);
  eq('oi_24h', 0.5);
  eq('funding', -0.002);
  eq('ls_buy', 0.35);
  eq('ls_24h', -0.15);
  eq('range_x', 2); // rango 4% contra 2%
});

test('la línea de base del volumen son los 7 días que terminan 24 h antes', () => {
  // Ventana correcta [i-192, i-24): 96 horas a 1000 y 72 a 3000 -> mediana 1000.
  // Si se corriera a [i-168, i] tendría mayoría de 3000 y daría otra cosa.
  const n = 400;
  const i = 399;
  const q = (k) => (k >= i - 24 ? 3000 : k >= i - 168 && k % 2 === 0 ? 3000 : 1000);
  const klines = Array.from({ length: n }, (_, k) => ({ t: T0 + k * HOUR_MS, o: 1, h: 1, l: 1, c: 1, q: q(k) }));
  const x = computeFeatures(buildFrame({ klines }));
  assert.equal(x.vol_1h_x[i], 3);
  assert.equal(x.vol_24h_x[i], 3);
});

// ---------------------------------------------------------------- etiqueta

test('la etiqueta mira solo las H velas siguientes, contra el cierre de la hora', () => {
  // cierres 10, 10, 10, 10; máximos 10, 12, 16, 11 -> desde la hora 0: máx 16 = +60%
  // La vela de entrada tiene máximo 20: no cuenta, porque ya pasó al entrar a su cierre.
  const klines = [candle(0, 10, { h: 20, l: 5 }), candle(1, 10, { h: 12 }), candle(2, 10, { h: 16, l: 8 }), candle(3, 10, { h: 11 })];
  const fwd = labelForward(buildFrame({ klines }), 2, 0.5);
  assert.equal(fwd.label[0], 1); // horas 1-2 llegan a 16
  assert.equal(fwd.label[1], 1); // horas 2-3 llegan a 16
  assert.ok(Number.isNaN(fwd.label[2]), 'sin 2 horas completas por delante no hay etiqueta');
  assert.ok(Math.abs(fwd.maxGain[0] - 0.6) < 1e-12);
  assert.ok(Math.abs(fwd.maxDrawdown[0] + 0.2) < 1e-12);
  assert.equal(fwd.retH[0], 0);
  const low = labelForward(buildFrame({ klines }), 1, 0.5);
  assert.equal(low.label[0], 0, 'con H=1 la hora 0 solo ve +20%');
});

test('episodios: tramos contiguos de horas con subida', () => {
  const label = Float64Array.from([0, 1, 1, 0, NaN, 1, 0, 1]);
  assert.deepEqual(findEpisodes(label), [{ start: 1, end: 2 }, { start: 5, end: 5 }, { start: 7, end: 7 }]);
});

// ---------------------------------------------------------------- AUC

test('AUC: separación perfecta, invertida, empates y un caso a mano', () => {
  assert.equal(auc([5, 6, 7], [1, 2, 3]), 1);
  assert.equal(auc([1, 2], [5, 6]), 0);
  assert.equal(auc([4, 4], [4, 4, 4]), 0.5);
  // pares (pos, neg): (3,1)(3,4)(3,2)(5,1)(5,4)(5,2) -> gana 5 de 6
  assert.ok(Math.abs(auc([3, 5], [1, 4, 2]) - 5 / 6) < 1e-12);
  assert.ok(Number.isNaN(auc([], [1])));
});

test('reservoir: tamaño fijo, determinista y cuenta todo lo visto', () => {
  const a = createReservoir(10, 1);
  const b = createReservoir(10, 1);
  for (let i = 0; i < 1000; i++) { a.push(i); b.push(i); }
  assert.equal(a.values.length, 10);
  assert.equal(a.seen, 1000);
  assert.deepEqual(a.values, b.values);
  assert.ok(a.values.some((v) => v > 500), 'tiene que tomar valores de toda la corrida');
});

// ---------------------------------------------------------------- evaluación

test('evaluación: precisión, lift, entradas con enfriamiento, atrapa y avisa antes', () => {
  // Un símbolo de 10 horas: la señal "volumen ≥5×" se enciende en 1, 2, 3 y 8;
  // hay subida desde las horas 3-4.
  const n = 10;
  const frame = { n, t0: T0 };
  const features = Object.fromEntries(FEATURES.map(([name]) => [name, new Float64Array(n).fill(NaN)]));
  for (const i of [1, 2, 3, 8]) features.vol_1h_x[i] = 6;
  const label = Float64Array.from([0, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
  const fwd = { label, retH: Float64Array.from({ length: n }, (_, i) => i / 100), maxGain: new Float64Array(n).fill(0.1), maxDrawdown: new Float64Array(n).fill(-0.05) };

  // Segundo símbolo: la señal se enciende recién al empezar el episodio.
  const features2 = Object.fromEntries(FEATURES.map(([name]) => [name, new Float64Array(n).fill(NaN)]));
  features2.vol_1h_x[5] = 6;
  const fwd2 = { ...fwd, label: Float64Array.from([0, 0, 0, 0, 0, 1, 1, 0, 0, 0]) };
  const only1 = evaluate([{ frame, features, fwd }], { horizon: 3, splitMs: Infinity });
  const both = evaluate([{ frame, features, fwd }, { frame, features: features2, fwd: fwd2 }], { horizon: 3, splitMs: Infinity });
  const r2 = both.rules.find((x) => x.id === 'vol1h_5x');
  assert.equal(both.episodes, 2);
  assert.equal(r2.catchRate, 1, 'los dos episodios se podían atrapar');
  assert.equal(r2.earlyRate, 0.5, 'pero solo el primero tuvo aviso previo');
  const res = only1;
  const r = res.rules.find((x) => x.id === 'vol1h_5x');
  assert.equal(res.hours, 10);
  assert.equal(res.episodes, 1);
  assert.equal(res.baseRate.all, 0.2);
  assert.equal(r.all.hours, 4);
  assert.equal(r.all.precision, 0.25); // solo la hora 3 terminó en subida
  assert.equal(r.all.lift, 1.25);
  // Entradas con enfriamiento de 3 h: hora 1 (bloquea 2 y 3) y hora 8.
  assert.equal(r.all.trades, 2);
  assert.equal(r.all.tradePrecision, 0);
  assert.equal(r.all.medianRet, (0.01 + 0.08) / 2);
  assert.equal(r.catchRate, 1, 'se encendió en la hora 3, dentro del episodio');
  assert.equal(r.earlyRate, 1, 'y también en las 24 h previas');
  const oi = res.rules.find((x) => x.id === 'oi4h_20');
  assert.equal(oi.all.hours, 0);
  assert.equal(oi.catchRate, 0);
});

test('las señales usan rasgos que existen', () => {
  const names = new Set(FEATURES.map(([n]) => n));
  const probe = new Proxy({}, { get: (_, key) => { assert.ok(names.has(key), `regla usa un rasgo inexistente: ${String(key)}`); return 0; } });
  for (const rule of RULES) rule.test(probe);
});

// ---------------------------------------------------------------- descarga

test('paginación hacia atrás: cubre el rango, sin duplicados, y corta si no hay progreso', async () => {
  const all = Array.from({ length: 50 }, (_, i) => ({ t: i * 10 }));
  const pages = [];
  const got = await walkBackward({
    startMs: 55, endMs: 400, time: (x) => x.t,
    fetchPage: async (end) => {
      pages.push(end);
      return all.filter((x) => x.t <= end).sort((a, b) => b.t - a.t).slice(0, 7);
    },
  });
  assert.deepEqual(got.map((x) => x.t), Array.from({ length: 35 }, (_, i) => 60 + i * 10));
  assert.deepEqual(pages, [400, 339, 269, 199, 129, 59], 'cada página arranca justo antes de la más vieja recibida');
  // Endpoint que ignora endTime: devuelve siempre la misma página (300..360).
  // El primer pedido avanza; el segundo no baja de endTime y ahí se corta.
  let calls = 0;
  const stuck = await walkBackward({ startMs: 0, endMs: 400, time: (x) => x.t, fetchPage: async () => { calls++; return all.slice(30, 37); } });
  assert.equal(calls, 2);
  assert.deepEqual(stuck.map((x) => x.t), [300, 310, 320, 330, 340, 350, 360]);
});

// ---------------------------------------------------------------- de punta a punta

test('estudio completo contra una API falsa: encuentra la subida y lo que la precedió', async () => {
  const now = Date.UTC(2026, 3, 1, 12, 30);
  const endMs = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
  const hours = (60 + 40) * 24;
  const start = endMs - (hours - 1) * HOUR_MS;
  const pumpAt = endMs - 20 * 24 * HOUR_MS; // subida 20 días antes del final

  function make(seed, { pump, oiRamp }) {
    const rnd = mulberry32(seed);
    const klines = [];
    const oi = [];
    const ls = [];
    const funding = [];
    let p = 1;
    for (let i = 0; i < hours; i++) {
      const t = start + i * HOUR_MS;
      p *= 1 + (rnd() - 0.5) * 0.01;
      let mult = 1;
      if (pump) {
        const k = (t - pumpAt) / HOUR_MS;
        if (k >= 0 && k < 6) mult = 1 + 0.15 * (k + 1); // +90% en 6 h
        else if (k >= 6) mult = Math.max(1, 1.9 - 0.02 * (k - 5));
      }
      const c = p * mult;
      klines.push({ t, o: c, h: c * 1.002, l: c * 0.998, c, q: 1000 * (1 + rnd()) });
      let o = 1000;
      if (oiRamp) {
        const k = (t - pumpAt) / HOUR_MS;
        if (k >= -24 && k < 0) o = 1000 + (1000 * (k + 24)) / 24; // OI se duplica en las 24 h previas
        else if (k >= 0) o = 2000;
      }
      oi.push({ t, oi: o });
      ls.push({ t, buy: 0.5 });
      if (i % 8 === 0) funding.push({ t, rate: 0.0001 });
    }
    return { klines, oi, ls, funding };
  }

  const { fetchImpl, requests } = createFakeHistoryFetch({
    AAAUSDT: make(1, { pump: true, oiRamp: true }), // OI se duplica antes de subir
    BBBUSDT: make(2, { pump: true, oiRamp: false }), // sube sin aviso en el OI
    CCCUSDT: make(3, { pump: false, oiRamp: true }), // OI se duplica y NO sube
    DDDUSDT: make(4, { pump: false, oiRamp: false }),
  });

  const result = await runStudy(
    { days: 60, threshold: 0.5, horizon: 24, concurrency: 2, symbols: null, maxSymbols: 0, cache: null, restUrl: 'https://api.bybit.com' },
    { fetchImpl, now, log: () => {} },
  );

  assert.equal(result.coverage.symbols, 4);
  // Solo horas del período (cierre posterior al inicio) con 24 h completas por delante:
  // de la 959 a la 2375 de cada símbolo. El calentamiento no cuenta.
  assert.equal(result.evaluation.hours, 4 * (2375 - 959 + 1));
  assert.equal(result.coverage.failed, 0);
  assert.equal(result.evaluation.episodes, 2);
  assert.deepEqual(result.episodes.map((e) => e.symbol).sort(), ['AAAUSDT', 'BBBUSDT']);
  for (const ep of result.episodes) {
    assert.ok(ep.startMs <= pumpAt + 6 * HOUR_MS && ep.startMs >= pumpAt - 24 * HOUR_MS, `${ep.symbol}: inicio fuera de la ventana`);
    assert.ok(ep.maxGain >= 0.5);
  }
  assert.equal(result.coverage.oi, 1);
  assert.equal(result.coverage.ls, 1);

  // La señal de OI atrapa la subida de AAA, no la de BBB, y se enciende en CCC sin subida.
  const rule = result.evaluation.rules.find((r) => r.id === 'oi24h_50');
  assert.equal(rule.catchRate, 0.5);
  assert.ok(rule.all.hours > 0 && rule.all.precision < 1, 'CCC tiene que aparecer como falso positivo');

  // Paginación real: pidió varias páginas de velas por símbolo.
  assert.ok(requests.filter((r) => r.startsWith('/v5/market/kline') && r.includes('AAAUSDT')).length >= 3);

  const md = renderReport(result);
  assert.match(md, /AAAUSDT/);
  assert.match(md, /Límites de este estudio/);
  assert.equal(episodesCsv(result.episodes).trim().split('\n').length, 3);
});
