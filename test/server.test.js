import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../server/index.js';
import { createFakeSource } from './helpers/fake-source.js';

// Arranca el servidor real (mismo main() que `npm start`) e inyecta una fuente
// de test para controlar exactamente qué trades entran. La aplicación publicada
// no tiene esta puerta: sin inyección, la única fuente posible es Bybit.

let app;
let source;
let baseUrl;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screener-http-'));
  source = createFakeSource();
  app = await main(
    {
      HOST: '127.0.0.1',
      PORT: '0',
      PUSH_INTERVAL_MS: '150',
      PERSIST: '0',
      LOG_LEVEL: 'error',
      SNAPSHOT_FILE: join(dir, 'vol.bin'),
    },
    { source },
  );
  baseUrl = app.url;

  const now = Date.now();
  // BTC: 1.000.000 comprado y 400.000 vendido -> delta +600.000
  source.emit({ symbol: 'BTCUSDT', ts: now, quoteVolume: 1_000_000, isBuy: true });
  source.emit({ symbol: 'BTCUSDT', ts: now, quoteVolume: 400_000, isBuy: false });
  // ETH: solo ventas -> delta negativo
  source.emit({ symbol: 'ETHUSDT', ts: now, quoteVolume: 250_000, isBuy: false });
  // SOL: un trade de hace 20 minutos, fuera de la ventana de 10m
  source.emit({ symbol: 'SOLUSDC', ts: now - 20 * 60_000, quoteVolume: 900_000, isBuy: true });
});

after(async () => {
  await app?.close();
});

const snapshot = async (tfs) => (await fetch(`${baseUrl}/api/snapshot?tfs=${tfs}`)).json();
const rowOf = (snap, symbol) => snap.rows.find((r) => r.s === symbol);

test('/api/health informa de la fuente y del estado del feed', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(health.source, 'test-fixture');
  assert.equal(health.instruments, 3);
  assert.equal(health.trades, 4);
});

test('el delta es exactamente compras menos ventas', async () => {
  const snap = await snapshot('10m,1h');

  const btc = rowOf(snap, 'BTCUSDT');
  assert.deepEqual(btc.d['10m'], [600_000, 1_400_000]); // [delta, volumen total]
  assert.equal(btc.p, '68123.5'); // precio tal cual lo publica el exchange
  assert.equal(btc.c, -0.0283);

  const eth = rowOf(snap, 'ETHUSDT');
  assert.deepEqual(eth.d['10m'], [-250_000, 250_000]);
});

test('cada ventana solo cuenta los trades que le corresponden', async () => {
  const snap = await snapshot('10m,1h');
  const sol = rowOf(snap, 'SOLUSDC');

  assert.deepEqual(sol.d['10m'], [0, 0], 'un trade de hace 20 min no entra en 10m');
  assert.deepEqual(sol.d['1h'], [900_000, 900_000], 'pero sí en 1h');
});

test('los pares sin trades aparecen con delta cero, no ausentes', async () => {
  const snap = await snapshot('1m');
  assert.equal(snap.rows.length, 3);
  assert.deepEqual(rowOf(snap, 'SOLUSDC').d['1m'], [0, 0]);
});

test('los timeframes inválidos caen al valor por defecto', async () => {
  const snap = await snapshot('7s,basura');
  assert.deepEqual(snap.tfs, ['5m', '10m', '1h']);
});

test('el snapshot declara si los datos están vivos', async () => {
  const snap = await snapshot('10m');
  assert.equal(snap.live, true);
  assert.equal(snap.streamsUp, true);
  assert.equal(snap.tickersFresh, true);
  assert.ok(snap.trades > 0);
  assert.ok(snap.tickerAgeMs < 15_000);
});

test('si el stream se cae, el snapshot deja de declararse en vivo', async () => {
  source.connected = false;
  try {
    const snap = await snapshot('10m');
    assert.equal(snap.streamsUp, false);
    assert.equal(snap.live, false, 'el cliente debe poder avisar de que no es tiempo real');
  } finally {
    source.connected = true;
  }
});

test('/api/stream empuja los trades nuevos sin recargar', async () => {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/stream?tfs=1m`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const nextSnapshot = async () => {
    while (true) {
      const marker = buffer.indexOf('\n\n');
      if (marker !== -1) {
        const chunk = buffer.slice(0, marker);
        buffer = buffer.slice(marker + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('el stream se cerró');
      buffer += decoder.decode(value, { stream: true });
    }
  };

  const first = await nextSnapshot();
  assert.deepEqual(first.tfs, ['1m']);
  const before = rowOf(first, 'ETHUSDT').d['1m'][0];

  // Un trade nuevo debe reflejarse en el siguiente envío, sin pedir nada.
  source.emit({ symbol: 'ETHUSDT', ts: Date.now(), quoteVolume: 750_000, isBuy: true });

  let updated = null;
  for (let i = 0; i < 12 && updated === null; i++) {
    const snap = await nextSnapshot();
    const value = rowOf(snap, 'ETHUSDT').d['1m'][0];
    if (value !== before) updated = value;
  }
  controller.abort();

  assert.equal(updated, before + 750_000, 'el delta debe subir con el trade emitido');
});

test('la interfaz se sirve como estática', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /screener/i);
});

test('no se puede salir del directorio público', async () => {
  for (const path of ['/../server/config.js', '/%2e%2e/package.json', '/..%2fpackage.json']) {
    const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `${path} devolvió ${res.status}`);
    assert.doesNotMatch(await res.text(), /BYBIT_REST|bybit-perp-screener/);
  }
});

test('otros métodos HTTP se rechazan', async () => {
  const res = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
  assert.equal(res.status, 405);
});
