import test from 'node:test';
import assert from 'node:assert/strict';
import { pineEma, pineEmaState, pineEmaLive } from '../public/js/core/ema.js';
import { EMA_LENGTHS, KLINE_LIMIT } from '../public/js/core/combos.js';

// Valores esperados calculados a mano con la fórmula de ta.ema de Pine:
//   semilla = SMA de los N primeros (en el índice N-1), antes NaN;
//   después p = a*x + (1-a)*p, a = 2/(N+1).

const close = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${msg}: ${actual} != ${expected}`);

test('caso chico hecho a mano: N=3 sobre 2,4,6,8,10', () => {
  // a = 0.5; semilla = (2+4+6)/3 = 4; 0.5*8+0.5*4 = 6; 0.5*10+0.5*6 = 8
  const out = [...pineEma([2, 4, 6, 8, 10], 3)];
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
  assert.deepEqual(out.slice(2), [4, 6, 8]);
});

test('las longitudes de los combos son las del Pine', () => {
  assert.deepEqual(EMA_LENGTHS, [21, 34, 55, 115, 300, 600]);
});

for (const N of EMA_LENGTHS) {
  test(`EMA ${N}: exactamente N-1 NaN y la semilla es la SMA de los primeros N`, () => {
    const values = Array.from({ length: KLINE_LIMIT }, (_, i) => 100 + 7 * Math.sin(i / 5) + (i % 13));
    const out = pineEma(values, N);
    const nans = [...out].filter(Number.isNaN).length;
    assert.equal(nans, N - 1);
    for (let i = 0; i < N - 1; i++) assert.ok(Number.isNaN(out[i]), `índice ${i} debería ser NaN`);
    const sma = values.slice(0, N).reduce((s, x) => s + x, 0) / N;
    close(out[N - 1], sma, 'semilla');
  });

  test(`EMA ${N}: sobre una rampa x_i = i vale exactamente i − (N−1)/2`, () => {
    // Forma cerrada: la SMA de 0..N-1 es (N-1)/2, y con entrada lineal el
    // retraso estacionario de la EMA es (1-a)/a = (N-1)/2. Vale desde la semilla.
    const ramp = Array.from({ length: KLINE_LIMIT }, (_, i) => i);
    const out = pineEma(ramp, N);
    for (let i = N - 1; i < ramp.length; i++) close(out[i], i - (N - 1) / 2, `i=${i}`);
  });

  test(`EMA ${N}: tras un escalón decae como (1−a)^k`, () => {
    // N velas en 10 y luego todas en 30: semilla 10, después 30 + (10-30)(1-a)^k.
    const a = 2 / (N + 1);
    const values = Array.from({ length: KLINE_LIMIT }, (_, i) => (i < N ? 10 : 30));
    const out = pineEma(values, N);
    for (let k = 0; k <= KLINE_LIMIT - N; k++) close(out[N - 1 + k], 30 - 20 * (1 - a) ** k, `k=${k}`);
  });

  test(`EMA ${N}: la vela en curso en O(1) coincide con recalcular toda la serie`, () => {
    const base = Array.from({ length: N + 40 }, (_, i) => 50 + Math.cos(i / 3) * 4 + i * 0.01);
    for (const closedCount of [N - 3, N - 2, N - 1, N, N + 1, N + 39]) {
      if (closedCount < 0) continue;
      const closed = base.slice(0, closedCount);
      const live = 51.234;
      const expected = pineEma([...closed, live], N).at(-1);
      const got = pineEmaLive(pineEmaState(closed, N), live);
      if (Number.isNaN(expected)) assert.equal(got, null, `cerradas=${closedCount} no imprime todavía`);
      else close(got, expected, `cerradas=${closedCount}`);
    }
  });
}

test('no es ewm de pandas: adjust=False siembra con el primer valor', () => {
  const N = 21;
  const ramp = Array.from({ length: 200 }, (_, i) => i);
  const a = 2 / (N + 1);
  const ewm = [ramp[0]];
  for (let i = 1; i < ramp.length; i++) ewm.push(a * ramp[i] + (1 - a) * ewm[i - 1]);
  const pine = pineEma(ramp, N);
  assert.ok(!Number.isNaN(ewm[0]) && Number.isNaN(pine[0]), 'ewm imprime desde la primera vela, Pine no');
  assert.ok(Math.abs(ewm[N - 1] - pine[N - 1]) > 1, 'en la semilla difieren claramente');
});

test('con menos velas que N la serie entera queda vacía', () => {
  const out = pineEma([1, 2, 3], 21);
  assert.equal(out.length, 3);
  assert.ok([...out].every(Number.isNaN));
});
