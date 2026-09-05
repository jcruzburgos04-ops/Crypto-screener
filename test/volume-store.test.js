import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VolumeStore,
  FINE_BUCKET_MS,
  FINE_SLOTS,
  COARSE_BUCKET_MS,
  COARSE_SPAN_MS,
  MAX_WINDOW_MS,
} from '../public/js/core/volume-store.js';

const T0 = 1_800_000_000_000; // instante fijo, alineado a minuto

test('el delta es compras menos ventas dentro de la ventana', () => {
  const store = new VolumeStore(T0);
  store.addTrade('BTCUSDT', T0, 1000, true, T0);
  store.addTrade('BTCUSDT', T0 + 1000, 400, false, T0 + 1000);

  const [w] = store.read('BTCUSDT', [10 * 60_000]);
  assert.equal(w.buy, 1000);
  assert.equal(w.sell, 400);
  assert.equal(w.delta, 600);
  assert.equal(w.total, 1400);
});

test('los trades salen de la ventana cuando el tiempo avanza', () => {
  const store = new VolumeStore(T0);
  store.addTrade('ETHUSDT', T0, 500, true, T0);

  const before = store.read('ETHUSDT', [60_000])[0];
  assert.equal(before.delta, 500);

  // 2 minutos después ya no cabe en la ventana de 1m, pero sí en la de 10m.
  const later = T0 + 2 * 60_000;
  store.advance(later);
  assert.equal(store.read('ETHUSDT', [60_000])[0].delta, 0);
  assert.equal(store.read('ETHUSDT', [10 * 60_000])[0].delta, 500);
});

test('varias ventanas se leen consistentes en una sola pasada', () => {
  const store = new VolumeStore(T0);
  // Una compra por minuto durante 90 minutos.
  for (let i = 0; i < 90; i++) {
    const ts = T0 + i * 60_000;
    store.addTrade('SOLUSDT', ts, 100, true, ts);
  }
  const now = T0 + 90 * 60_000;
  store.advance(now);

  const [m10, h1, h4] = store.read('SOLUSDT', [10 * 60_000, 60 * 60_000, 4 * 3600_000]);
  assert.equal(m10.delta, 1000); // 10 minutos * 100
  assert.equal(h1.delta, 6000); // 60 minutos * 100
  assert.equal(h4.delta, 9000); // todo el historial disponible
  assert.equal(h4.total, 9000);
});

test('el orden de los timeframes pedidos no altera el resultado', () => {
  const store = new VolumeStore(T0);
  for (let i = 0; i < 30; i++) {
    const ts = T0 + i * 60_000;
    store.addTrade('XRPUSDT', ts, 50, i % 2 === 0, ts);
  }
  const now = T0 + 30 * 60_000;
  store.advance(now);

  const ordered = store.read('XRPUSDT', [60_000, 10 * 60_000, 3600_000]);
  const shuffled = store.read('XRPUSDT', [3600_000, 60_000, 10 * 60_000]);
  assert.deepEqual(shuffled[0], ordered[2]);
  assert.deepEqual(shuffled[1], ordered[0]);
  assert.deepEqual(shuffled[2], ordered[1]);
});

test('los trades más viejos que el ring buffer se descartan', () => {
  const store = new VolumeStore(T0);
  const ok = store.addTrade('OLDUSDT', T0 - COARSE_SPAN_MS - 60_000, 999, true, T0);
  assert.equal(ok, false);
  assert.equal(store.read('OLDUSDT', [24 * 3600_000])[0].total, 0);
  assert.equal(store.droppedTrades, 1);
});

test('un trade atrasado cae en su cubo, no en el actual', () => {
  const store = new VolumeStore(T0);
  const now = T0 + 5 * FINE_BUCKET_MS;
  store.advance(now);
  // Trade con timestamp de hace 3 cubos finos (30 s).
  store.addTrade('LATEUSDT', now - 3 * FINE_BUCKET_MS, 700, true, now);

  assert.equal(store.read('LATEUSDT', [FINE_BUCKET_MS])[0].delta, 0);
  assert.equal(store.read('LATEUSDT', [4 * FINE_BUCKET_MS])[0].delta, 700);
});

test('un timestamp futuro se recorta al momento actual', () => {
  const store = new VolumeStore(T0);
  store.addTrade('SKEWUSDT', T0 + 10 * 60_000, 300, true, T0);
  assert.equal(store.fineId, Math.floor(T0 / FINE_BUCKET_MS));
  assert.equal(store.read('SKEWUSDT', [FINE_BUCKET_MS])[0].delta, 300);
});

test('una pausa larga limpia todo el historial', () => {
  const store = new VolumeStore(T0);
  store.addTrade('GAPUSDT', T0, 1234, true, T0);
  store.advance(T0 + 3 * COARSE_SPAN_MS);
  assert.equal(store.read('GAPUSDT', [24 * 3600_000])[0].total, 0);
});

test('la cobertura crece con el tiempo y se limita a 24 h', () => {
  const store = new VolumeStore(T0);
  store.ensure('NEWUSDT', T0);
  assert.equal(store.coverageMs('NEWUSDT', T0 + 60_000), 60_000);
  assert.equal(store.coverageMs('NEWUSDT', T0 + 48 * 3600_000), MAX_WINDOW_MS);
});

test('el nivel grueso agrega por minuto sin perder volumen', () => {
  const store = new VolumeStore(T0);
  let expected = 0;
  for (let i = 0; i < 6; i++) {
    const ts = T0 + i * COARSE_BUCKET_MS + 1;
    store.addTrade('AGGUSDT', ts, 10, true, ts);
    expected += 10;
  }
  const now = T0 + 6 * COARSE_BUCKET_MS;
  store.advance(now);
  assert.equal(store.read('AGGUSDT', [4 * 3600_000])[0].total, expected);
});

test('el nivel fino cubre al menos una hora completa', () => {
  assert.ok(FINE_SLOTS * FINE_BUCKET_MS >= 3600_000 + FINE_BUCKET_MS);
});
