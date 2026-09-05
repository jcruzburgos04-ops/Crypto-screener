import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VolumeStore } from '../server/volume-store.js';
import { serialize, deserialize, saveSnapshot, loadSnapshot } from '../server/snapshot.js';

const T0 = 1_800_000_000_000;

function seeded(now = T0) {
  const store = new VolumeStore(now);
  store.addTrade('BTCUSDT', now, 5000, true, now);
  store.addTrade('BTCUSDT', now, 2000, false, now);
  store.addTrade('ETHUSDT', now, 750, false, now);
  return store;
}

test('serializar y deserializar conserva los deltas', () => {
  const store = seeded();
  const restored = deserialize(serialize(store, T0), T0 + 1000);

  assert.equal(restored.entries.size, 2);
  assert.deepEqual(restored.read('BTCUSDT', [10 * 60_000])[0], {
    buy: 5000,
    sell: 2000,
    delta: 3000,
    total: 7000,
  });
  assert.equal(restored.read('ETHUSDT', [10 * 60_000])[0].delta, -750);
  assert.equal(restored.startedAt, T0);
});

test('al restaurar se envejecen los cubos caducados', () => {
  const store = seeded();
  // 30 minutos después: fuera de la ventana de 10m, dentro de la de 4h.
  const restored = deserialize(serialize(store, T0), T0 + 30 * 60_000);
  assert.equal(restored.read('BTCUSDT', [10 * 60_000])[0].total, 0);
  assert.equal(restored.read('BTCUSDT', [4 * 3600_000])[0].total, 7000);
});

test('un snapshot de más de 24 h se rechaza', () => {
  const store = seeded();
  assert.throws(() => deserialize(serialize(store, T0), T0 + 25 * 3600_000), /demasiado antiguo/);
});

test('ida y vuelta por disco con reemplazo atómico', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screener-'));
  const file = join(dir, 'vol.bin');
  const store = seeded(Date.now());

  const bytes = await saveSnapshot(store, file);
  assert.ok(bytes > 0);

  const restored = await loadSnapshot(file);
  assert.equal(restored.entries.size, 2);
  assert.equal(restored.read('BTCUSDT', [60 * 60_000])[0].delta, 3000);
});

test('sin archivo previo devuelve null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screener-'));
  assert.equal(await loadSnapshot(join(dir, 'no-existe.bin')), null);
});

test('un archivo corrupto se descarta como error recuperable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screener-'));
  const file = join(dir, 'roto.bin');
  await writeFile(file, Buffer.alloc(200));

  await assert.rejects(loadSnapshot(file), (err) => err.recoverable === true);
  assert.equal(await loadSnapshot(file), null); // se borró el archivo inservible
});
