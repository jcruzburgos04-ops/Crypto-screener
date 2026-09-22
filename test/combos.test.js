import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Screener } from '../public/js/core/screener.js';
import { pineEma } from '../public/js/core/ema.js';
import {
  COMBOS, COMBO_FILTERS, DAY_MS, EMA_LENGTHS, KLINE_LIMIT, NEAR_CROSS_PCT, STATE,
  comboBull, comboStatus, crossPrice, passesComboFilter,
} from '../public/js/core/combos.js';
import { pineEmaState } from '../public/js/core/ema.js';
import { compareSortValues } from '../public/js/sorting.js';

// El umbral de la especificación, escrito acá y no importado: si el código
// cambiara el suyo, la prueba tiene que darse cuenta.
const SPEC_NEAR_PCT = 5;

// ---------------------------------------------------------------- referencia
// Todo lo esperado se calcula recalculando las EMAs sobre la serie completa,
// sin usar crossPrice ni comboStatus.

const lastEma = (values, n) => {
  const v = pineEma(values, n).at(-1);
  return Number.isNaN(v) ? null : v;
};
/** ¿La rápida va arriba o igual si hoy el precio fuera p? */
const bullAt = (closed, p, c) => lastEma([...closed, p], c.fast) >= lastEma([...closed, p], c.slow);

/** Precio de cruce de hoy por bisección sobre la EMA recalculada entera. */
function bisectCross(closed, c) {
  const diff = (p) => lastEma([...closed, p], c.fast) - lastEma([...closed, p], c.slow);
  let lo = 1e-9;
  let hi = closed.at(-1) * 10;
  if (Math.sign(diff(lo)) === Math.sign(diff(hi))) return null;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (diff(mid) >= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Estado esperado de un combo, sin tocar el código probado. */
function expectedStatus(closed, live, c) {
  const full = [...closed, live];
  const fNow = lastEma(full, c.fast);
  const sNow = lastEma(full, c.slow);
  if (fNow === null || sNow === null) return null;
  const now = fNow >= sNow;
  const fY = lastEma(closed, c.fast);
  const sY = lastEma(closed, c.slow);
  if (fY === null || sY === null) return { code: now ? STATE.UP : STATE.DOWN };
  const yesterday = fY >= sY;
  if (yesterday !== now) return { code: now ? STATE.CROSS_UP : STATE.CROSS_DOWN };
  // Próxima: ¿moviendo el precio 5% en contra, hoy se da vuelta?
  const moved = live * (now ? 1 - SPEC_NEAR_PCT / 100 : 1 + SPEC_NEAR_PCT / 100);
  if (bullAt(closed, moved, c) !== now) return { code: now ? STATE.NEAR_DOWN : STATE.NEAR_UP, near: true, now };
  return { code: now ? STATE.UP : STATE.DOWN };
}

// ---------------------------------------------------------------- universo

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Largos variados: veteranas y jóvenes; 33, 114 y 599 cerradas son el día en
// que la vela de hoy completa la semilla de la 34, la 115 y la 600.
const LENGTHS = [999, 999, 999, 999, 999, 999, 999, 999, 800, 650, 599, 450, 200, 114, 60, 33, 21, 20, 5];
const SYMBOLS = [];
const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const series = new Map();
const livePrice = new Map();

function randomWalk(seed, n) {
  const rnd = mulberry32(seed);
  const closed = [];
  let p = 100;
  let drift = (rnd() - 0.5) * 0.01;
  for (let k = 0; k < n; k++) {
    if (k % (40 + Math.floor(rnd() * 200)) === 0) drift = (rnd() - 0.5) * 0.02;
    p *= 1 + drift + (rnd() - 0.5) * 0.03;
    closed.push(p);
  }
  return { closed, noise: (rnd() - 0.5) * 0.04 };
}

for (let i = 0; i < 192; i++) {
  const n = LENGTHS[i % LENGTHS.length];
  // Casos forzados: 0-1 al azar; 2-3 combo 1; 4-5 combo 2; 6-7 combo 3
  // (par = cruza hoy, impar = le falta ~3%). La dirección buscada se alterna
  // cada vuelta de 8 para tener cruces y próximas hacia los dos lados.
  const kind = i % 8;
  const combo = kind >= 2 ? COMBOS[Math.floor((kind - 2) / 2)] : null;
  const wantBullYesterday = Math.floor(i / 8) % 2 === 0;

  let seed = 5000 + i * 97;
  let { closed, noise } = randomWalk(seed, n);
  if (combo && n >= combo.slow) {
    // Probar semillas hasta que ayer cierre del lado buscado y el cruce de hoy
    // quede a un precio razonable (en 300/600 eso exige EMAs casi pegadas).
    for (let tries = 0; tries < 2000; tries++) {
      const bullY = lastEma(closed, combo.fast) >= lastEma(closed, combo.slow);
      const target = bullY === wantBullYesterday ? bisectCross(closed, combo) : null;
      const last = closed.at(-1);
      if (target !== null && target < last * 3 && target > last / 3) break;
      ({ closed, noise } = randomWalk(++seed, n));
    }
  }
  let live = closed.at(-1) * (1 + noise);
  if (combo && n >= combo.slow) {
    const target = bisectCross(closed, combo);
    if (target !== null) {
      const bullY = lastEma(closed, combo.fast) >= lastEma(closed, combo.slow);
      if (kind % 2 === 0) live = bullY ? target * 0.995 : target * 1.005; // cruza hoy
      else {
        // Le falta ~3% (próxima) o ~7% (no es próxima con el umbral de 5%).
        const gap = Math.floor(i / 16) % 2 === 0 ? 1.03 : 1.07;
        live = bullY ? target * gap : target / gap;
      }
    }
  }
  const symbol = `T${i}USDT`;
  SYMBOLS.push(symbol);
  series.set(symbol, closed);
  livePrice.set(symbol, live);
}

const source = {
  name: 'prueba-combos',
  loadInstruments: async () => SYMBOLS.map((s) => ({ symbol: s, category: 'linear', baseCoin: s.slice(0, -4), quoteCoin: 'USDT' })),
  loadTickers: async () => new Map(SYMBOLS.map((s) => [s, { price: String(livePrice.get(s)), change24h: 0, turnover24h: 1, openInterestValue: 0, fundingRate: 0 }])),
  loadDailyKlines: async (symbol) => {
    const closed = series.get(symbol);
    // Cerradas + la de hoy en curso con un cierre viejo que el ticker tiene que pisar.
    return [...closed.map((close, k) => ({ start: today - (closed.length - k) * DAY_MS, close })), { start: today, close: 1e9 }];
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

const near = (a, b, tol = 1e-8) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// ---------------------------------------------------------------- pruebas

test('las seis EMAs de cada fila salen de toda la serie + la vela en curso', () => {
  assert.equal(rows.length, SYMBOLS.length);
  for (const row of rows) {
    const full = [...series.get(row.s), livePrice.get(row.s)];
    assert.equal(row.kn, full.length);
    row.ema.forEach((v, i) => {
      const exp = lastEma(full, EMA_LENGTHS[i]);
      if (exp === null) assert.equal(v, null, `${row.s} EMA ${EMA_LENGTHS[i]} debería ir vacía`);
      else assert.ok(near(v, exp), `${row.s} EMA ${EMA_LENGTHS[i]}: ${v} != ${exp}`);
    });
  }
});

test('calcular sobre las velas recortadas daría otra curva', () => {
  const row = rows.find((r) => r.kn === KLINE_LIMIT);
  const full = [...series.get(row.s), livePrice.get(row.s)];
  assert.ok(near(row.ema[0], lastEma(full, 21)));
  assert.ok(!near(row.ema[0], lastEma(full.slice(-120), 21)));
});

test('precio de cruce: con p* hoy la rápida y la lenta quedan iguales', () => {
  let checked = 0;
  for (const [symbol, closed] of series) {
    for (const c of COMBOS) {
      if (closed.length < c.slow) continue;
      const target = crossPrice(lastEma(closed, c.fast), lastEma(closed, c.slow), c.fast, c.slow);
      if (!(target > 0)) continue;
      const f = lastEma([...closed, target], c.fast);
      const s = lastEma([...closed, target], c.slow);
      assert.ok(near(f, s, 1e-9), `${symbol} ${c.fast}/${c.slow}: ${f} != ${s} en p*=${target}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `solo se comprobaron ${checked}`);
});

test('el estado de cada combo es correcto en TODAS las filas', () => {
  for (const row of rows) {
    const closed = series.get(row.s);
    const live = livePrice.get(row.s);
    COMBOS.forEach((c, i) => {
      const exp = expectedStatus(closed, live, c);
      const got = row.cb[i];
      const where = `${row.s} ${c.fast}/${c.slow}`;
      if (exp === null) return assert.equal(got, null, `${where} debería ir vacío`);
      assert.equal(got[0], exp.code, `${where}: estado`);
      if (!exp.near) return assert.equal(got[1], null, `${where}: sin % fuera de "próxima"`);
      // El % informado: moverse un poco menos no alcanza para cruzar; un poco más, sí.
      const sign = exp.now ? -1 : 1;
      const at = (pct) => live * (1 + (sign * pct) / 100);
      assert.equal(bullAt(closed, at(got[1] - 0.02), c), exp.now, `${where}: con ${got[1] - 0.02}% no debería cruzar`);
      assert.equal(bullAt(closed, at(got[1] + 0.02), c), !exp.now, `${where}: con ${got[1] + 0.02}% debería cruzar`);
    });
  }
});

test('en cada combo aparecen los seis estados y también filas sin dato', () => {
  COMBOS.forEach((c, i) => {
    const seen = new Set(rows.map((r) => (r.cb[i] === null ? 'vacío' : r.cb[i][0])));
    for (const code of Object.values(STATE)) assert.ok(seen.has(code), `${c.fast}/${c.slow}: falta el estado ${code}`);
    assert.ok(seen.has('vacío'), `${c.fast}/${c.slow}: falta alguna fila sin dato`);
  });
});

test('el día que la vela de hoy completa la semilla no hay cruce ni próxima', () => {
  // 33 cerradas + hoy: la EMA 34 recién imprime, no existe "ayer" para comparar.
  const seedDay = rows.filter((r) => r.kn === 34);
  assert.ok(seedDay.length > 0);
  for (const r of seedDay) assert.ok([STATE.UP, STATE.DOWN].includes(r.cb[0][0]) && r.cb[0][1] === null, r.s);
});

test('filtros por combo: alcista + bajista + sin dato = total, y cada opción cuenta lo suyo', () => {
  COMBOS.forEach((c, i) => {
    const codes = rows.map((r) => r.cb[i]?.[0] ?? null);
    const count = (f) => codes.filter((code) => passesComboFilter(code, f)).length;
    const exact = (v) => codes.filter((code) => code === v).length;
    const sinDato = codes.filter((code) => code === null).length;
    const where = `${c.fast}/${c.slow}`;

    assert.ok(sinDato > 0, where);
    assert.equal(count('bull') + count('bear') + sinDato, rows.length, where);
    assert.equal(count('bull'), exact(STATE.UP) + exact(STATE.CROSS_UP) + exact(STATE.NEAR_DOWN), where);
    assert.equal(count('crossUp'), exact(STATE.CROSS_UP), where);
    assert.equal(count('crossDown'), exact(STATE.CROSS_DOWN), where);
    assert.equal(count('cross'), exact(STATE.CROSS_UP) + exact(STATE.CROSS_DOWN), where);
    assert.equal(count('nearUp'), exact(STATE.NEAR_UP), where);
    assert.equal(count('nearDown'), exact(STATE.NEAR_DOWN), where);
    assert.equal(count('near'), exact(STATE.NEAR_UP) + exact(STATE.NEAR_DOWN), where);
    assert.equal(count('all'), rows.length, where);
    for (const f of Object.keys(COMBO_FILTERS)) {
      if (f !== 'all') assert.equal(passesComboFilter(null, f), false, `${where}: un vacío pasó por "${f}"`);
    }
  });
});

test('lo que no imprimió va vacío en el JSON, nunca con un número', () => {
  const json = JSON.parse(JSON.stringify(rows));
  const joven = json.find((r) => r.kn === 22); // 21 cerradas + hoy: solo imprime la EMA 21
  assert.ok(Number.isFinite(joven.ema[0]));
  assert.deepEqual(joven.ema.slice(1), [null, null, null, null, null]);
  assert.deepEqual(joven.cb, [null, null, null]);
  const bebe = json.find((r) => r.kn === 6);
  assert.deepEqual(bebe.ema, [null, null, null, null, null, null]);
});

test('ordenar por un combo va de 5 a 0 por número, con los vacíos al final', () => {
  const desc = rows.map((r) => r.cb[0]?.[0] ?? null).sort((a, b) => compareSortValues(a, b, -1));
  const firstNull = desc.indexOf(null);
  const nums = desc.slice(0, firstNull);
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
  assert.ok(desc.slice(firstNull).every((v) => v === null));
  assert.equal(nums[0], STATE.UP);
  assert.equal(nums.at(-1), STATE.DOWN);
  const asc = rows.map((r) => r.cb[0]?.[0] ?? null).sort((a, b) => compareSortValues(a, b, 1));
  assert.equal(asc[0], STATE.DOWN);
  assert.equal(asc.at(-1), null, 'también en ascendente los vacíos al final');
});

test('la vela en curso toma el precio del ticker, no el cierre viejo de la vela', () => {
  for (const row of rows.filter((r) => r.ema[0] !== null)) assert.ok(row.ema[0] < 1e6, row.s);
});

test('empate: rápida igual a lenta cuenta como alcista', () => {
  assert.equal(comboBull(5, 5), true);
  assert.equal(comboBull(4.999, 5), false);
  assert.equal(comboBull(null, 5), null);
  // Precio constante: todas las EMAs iguales -> alcista, sin cruce en curso.
  const flat = new Array(700).fill(42);
  const fs = pineEmaState(flat, 21);
  const ss = pineEmaState(flat, 34);
  const status = comboStatus(fs, ss, 42, 42, 42);
  assert.equal(status[0], STATE.NEAR_DOWN, 'rápida = lenta: alcista, y cualquier baja la cruza');
});

test('el umbral de "próxima" es el de la especificación, y hay casos entre 5% y 10%', () => {
  assert.equal(NEAR_CROSS_PCT, SPEC_NEAR_PCT);
  // Filas a las que les falta entre 5% y 10%: con otro umbral cambiarían de estado.
  let between = 0;
  for (const row of rows) {
    COMBOS.forEach((c, i) => {
      const closed = series.get(row.s);
      if (closed.length < c.slow || row.cb[i] === null) return;
      const live = livePrice.get(row.s);
      const now = bullAt(closed, live, c);
      const flipsAt = (pct) => bullAt(closed, live * (1 + ((now ? -1 : 1) * pct) / 100), c) !== now;
      if (!flipsAt(5) && flipsAt(10)) between++;
    });
  }
  assert.ok(between > 0, 'sin casos entre 5% y 10% no se distingue el umbral');
});

test('el período de descarga alcanza para la EMA más larga', () => {
  assert.ok(KLINE_LIMIT >= Math.max(...EMA_LENGTHS));
});
