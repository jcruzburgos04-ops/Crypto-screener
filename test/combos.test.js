import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Screener } from '../public/js/core/screener.js';
import { pineEma } from '../public/js/core/ema.js';
import {
  DAY_MS, EMA_LENGTHS, KLINE_LIMIT, passesRegimeFilter, passesTrendFilter, REGIME_FILTERS,
} from '../public/js/core/combos.js';
import { compareSortValues } from '../public/js/sorting.js';

// Tabla del régimen escrita literalmente como en la especificación, sin usar
// el código que se está probando.
const REGIME_TABLE = { 'true,true': 3, 'false,true': 2, 'true,false': 1, 'false,false': 0 };

// PRNG determinista: la prueba no puede depender del azar.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Largos variados: monedas veteranas (1000 velas) y jóvenes que no llegan a la
// EMA 600, ni a la 115, ni a la 34.
const LENGTHS = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 800, 650, 599, 450, 200, 114, 60, 33, 21, 20, 5];
const SYMBOLS = [];
const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const series = new Map(); // símbolo -> cierres de velas cerradas
const livePrice = new Map();

for (let i = 0; i < 120; i++) {
  const rnd = mulberry32(1000 + i);
  const n = LENGTHS[i % LENGTHS.length];
  const closes = [];
  let p = 100;
  // Tendencias que cambian de signo en tramos: produce todos los regímenes.
  let drift = (rnd() - 0.5) * 0.01;
  for (let k = 0; k < n; k++) {
    if (k % (40 + Math.floor(rnd() * 200)) === 0) drift = (rnd() - 0.5) * 0.02;
    p *= 1 + drift + (rnd() - 0.5) * 0.03;
    closes.push(p);
  }
  const symbol = `T${i}USDT`;
  SYMBOLS.push(symbol);
  series.set(symbol, closes);
  livePrice.set(symbol, closes.at(-1) * (1 + (rnd() - 0.5) * 0.04));
}

const source = {
  name: 'prueba-combos',
  loadInstruments: async () => SYMBOLS.map((s) => ({ symbol: s, category: 'linear', baseCoin: s.slice(0, -4), quoteCoin: 'USDT' })),
  loadTickers: async () => new Map(SYMBOLS.map((s) => [s, { price: String(livePrice.get(s)), change24h: 0, turnover24h: 1, openInterestValue: 0, fundingRate: 0 }])),
  loadDailyKlines: async (symbol) => {
    const closes = series.get(symbol);
    // Velas cerradas + la de hoy en curso (con un cierre viejo que el ticker debe pisar).
    return [
      ...closes.map((close, k) => ({ start: today - (closes.length - k) * DAY_MS, close })),
      { start: today, close: 1e9 },
    ];
  },
  createStream: () => ({ setSymbols() {}, stop() {}, connected: true, status: () => ({ connections: [] }) }),
};

let screener;
let rows;

before(async () => {
  screener = new Screener({
    config: { categories: ['linear'], maxSymbols: 0, tickerIntervalMs: 0, instrumentsIntervalMs: 0, klineConcurrency: 16, klineSpacingMs: 0 },
    source,
  });
  await screener.start();
  await screener.waitForKlines();
  rows = screener.snapshot([{ id: '10m', ms: 600_000 }]).rows;
});

after(() => screener.stop());

/** Lo esperado, calculado aparte sobre la serie COMPLETA + el precio vivo. */
function expectedFor(symbol) {
  const full = [...series.get(symbol), livePrice.get(symbol)];
  const emas = EMA_LENGTHS.map((n) => {
    const v = pineEma(full, n).at(-1);
    return Number.isNaN(v) ? null : v;
  });
  const bull = (f, s) => (f === null || s === null ? null : f >= s);
  const r = bull(emas[0], emas[1]);
  const m = bull(emas[2], emas[3]);
  const fondo = bull(emas[4], emas[5]);
  return {
    emas,
    rg: r === null || m === null ? null : REGIME_TABLE[`${r},${m}`],
    fd: fondo === null ? null : fondo ? 1 : 0,
    candles: full.length,
  };
}

const near = (a, b) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(b));

test('las seis EMAs de cada fila salen de toda la serie + la vela en curso', () => {
  assert.equal(rows.length, SYMBOLS.length);
  for (const row of rows) {
    const exp = expectedFor(row.s);
    assert.equal(row.kn, exp.candles, `${row.s}: velas contadas`);
    row.ema.forEach((v, i) => {
      if (exp.emas[i] === null) assert.equal(v, null, `${row.s} EMA ${EMA_LENGTHS[i]} debería ir vacía`);
      else assert.ok(near(v, exp.emas[i]), `${row.s} EMA ${EMA_LENGTHS[i]}: ${v} != ${exp.emas[i]}`);
    });
  }
});

test('calcular sobre las velas recortadas daría otra curva', () => {
  const row = rows.find((r) => r.kn === KLINE_LIMIT + 1);
  const full = [...series.get(row.s), livePrice.get(row.s)];
  const recortada = pineEma(full.slice(-120), 21).at(-1);
  assert.ok(near(row.ema[0], pineEma(full, 21).at(-1)));
  assert.ok(!near(row.ema[0], recortada), 'si coincidieran, esta prueba no distinguiría nada');
});

test('el régimen es correcto en TODAS las filas y hay filas donde rápido y medio difieren', () => {
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, null: 0 };
  for (const row of rows) {
    assert.equal(row.rg, expectedFor(row.s).rg, `${row.s}: régimen`);
    counts[row.rg]++;
  }
  // Sin filas R−M+ y R+M−, un régimen que ignorara al combo rápido pasaría igual.
  for (const state of [0, 1, 2, 3]) assert.ok(counts[state] > 0, `falta el estado ${state}: ${JSON.stringify(counts)}`);
  assert.ok(counts.null > 0, 'tiene que haber símbolos sin régimen (sin EMA 115)');
});

test('hay filas donde el régimen medio y el fondo 300/600 no coinciden', () => {
  const conFondo = rows.filter((r) => r.fd !== null && r.rg !== null);
  const medioAlcista = (r) => r.rg >= 2;
  assert.ok(conFondo.some((r) => medioAlcista(r) && r.fd === 0), 'medio ↑ con fondo ↓');
  assert.ok(conFondo.some((r) => !medioAlcista(r) && r.fd === 1), 'medio ↓ con fondo ↑');
});

test('fondo 300/600: alcistas + bajistas + sin_fondo = total, y sin_fondo > 0', () => {
  const alcistas = rows.filter((r) => passesTrendFilter(r.fd, 'up')).length;
  const bajistas = rows.filter((r) => passesTrendFilter(r.fd, 'down')).length;
  const sinFondo = rows.filter((r) => r.fd === null).length;
  assert.equal(alcistas + bajistas + sinFondo, rows.length);
  assert.ok(sinFondo > 0);
  assert.ok(alcistas > 0 && bajistas > 0);
  for (const r of rows) {
    // Sin EMA 600 no hay fondo, y no pasa por ningún lado del filtro.
    assert.equal(r.fd === null, r.kn < 600, `${r.s}: ${r.kn} velas`);
    if (r.fd === null) assert.ok(!passesTrendFilter(r.fd, 'up') && !passesTrendFilter(r.fd, 'down'));
  }
});

test('filtro de régimen: cuatro estados y los dos atajos del medio', () => {
  const count = (f) => rows.filter((r) => passesRegimeFilter(r.rg, f)).length;
  const exact = (v) => rows.filter((r) => r.rg === v).length;
  for (const v of [0, 1, 2, 3]) assert.equal(count(String(v)), exact(v));
  assert.equal(count('midUp'), exact(3) + exact(2));
  assert.equal(count('midDown'), exact(1) + exact(0));
  const sinRegimen = rows.filter((r) => r.rg === null).length;
  assert.equal(count('midUp') + count('midDown') + sinRegimen, rows.length);
  assert.equal(count('all'), rows.length);
  assert.deepEqual(Object.keys(REGIME_FILTERS).sort(), ['0', '1', '2', '3', 'all', 'midDown', 'midUp']);
});

test('lo que no imprimió va vacío en el JSON, nunca con un número', () => {
  const json = JSON.parse(JSON.stringify(rows));
  const joven = json.find((r) => r.kn === 22); // 21 cerradas + hoy: solo imprime la EMA 21
  assert.ok(Number.isFinite(joven.ema[0]));
  assert.deepEqual(joven.ema.slice(1), [null, null, null, null, null]);
  assert.equal(joven.rg, null);
  assert.equal(joven.fd, null);
  const bebe = json.find((r) => r.kn === 6);
  assert.deepEqual(bebe.ema, [null, null, null, null, null, null]);
});

test('ordenar por régimen va de 3 a 0 por número, con los vacíos al final', () => {
  const desc = rows.map((r) => r.rg).sort((a, b) => compareSortValues(a, b, -1));
  const firstNull = desc.indexOf(null);
  const nums = desc.slice(0, firstNull);
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
  assert.ok(desc.slice(firstNull).every((v) => v === null));
  assert.equal(nums[0], 3);
  assert.equal(nums.at(-1), 0);
  const asc = rows.map((r) => r.rg).sort((a, b) => compareSortValues(a, b, 1));
  assert.equal(asc[0], 0);
  assert.equal(asc.at(-1), null, 'también en ascendente los vacíos al final');
});

test('la vela en curso toma el precio del ticker, no el cierre viejo de la vela', () => {
  // La vela de hoy viene con close = 1e9; si se usara, todas las EMAs se dispararían.
  for (const row of rows.filter((r) => r.ema[0] !== null)) {
    assert.ok(row.ema[0] < 1e6, `${row.s}: usó el cierre de la vela en curso`);
  }
});

test('el período de descarga alcanza para la EMA más larga', () => {
  assert.ok(KLINE_LIMIT >= Math.max(...EMA_LENGTHS));
});

test('empate: rápida igual a lenta cuenta como alcista', async () => {
  const { comboBull, regime, evaluateCombos } = await import('../public/js/core/combos.js');
  assert.equal(comboBull(5, 5), true);
  assert.equal(comboBull(4.999, 5), false);
  assert.equal(comboBull(null, 5), null);
  // Precio constante: todas las EMAs valen lo mismo -> R+ M+ y fondo alcista.
  const flat = EMA_LENGTHS.map((n) => pineEma(new Array(700).fill(42), n).at(-1));
  assert.deepEqual(evaluateCombos(flat), { ema: flat, rg: 3, fd: 1 });
  assert.equal(regime(true, true), 3);
});
