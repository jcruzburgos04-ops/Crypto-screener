import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Arranca el servidor real con el feed simulado y comprueba la API HTTP.

let child;
let baseUrl;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screener-http-'));
  child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      MOCK: '1',
      PORT: '0',
      PUSH_INTERVAL_MS: '250',
      SNAPSHOT_FILE: join(dir, 'vol.bin'),
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  baseUrl = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('el servidor no arrancó a tiempo')), 20_000);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const match = buffer.match(/http:\/\/[\d.]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePort(match[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`el servidor terminó con código ${code}`)));
  });

  // Deja correr el feed simulado para que haya trades acumulados.
  await new Promise((r) => setTimeout(r, 1500));
});

after(() => {
  child?.kill('SIGKILL');
});

test('/api/health informa del estado del feed', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(health.source, 'mock');
  assert.ok(health.instruments > 0);
  assert.ok(health.trades > 0, 'deberían haber llegado trades');
});

test('/api/snapshot devuelve una fila por par con los timeframes pedidos', async () => {
  const res = await fetch(`${baseUrl}/api/snapshot?tfs=10m,1h`);
  const snap = await res.json();

  assert.deepEqual(snap.tfs, ['10m', '1h']);
  assert.ok(snap.rows.length > 0);

  const row = snap.rows[0];
  for (const key of ['s', 'b', 'q', 'p', 'c', 'v', 'd', 'cov']) {
    assert.ok(key in row, `falta el campo ${key}`);
  }
  assert.equal(Object.keys(row.d).length, 2);
  assert.ok(Array.isArray(row.d['10m']));

  const withVolume = snap.rows.filter((r) => r.d['10m'][1] > 0);
  assert.ok(withVolume.length > 0, 'algún par debería tener volumen acumulado');
  for (const r of withVolume) {
    assert.ok(Math.abs(r.d['10m'][0]) <= r.d['10m'][1], '|delta| nunca supera el volumen total');
  }
});

test('los timeframes inválidos caen al valor por defecto', async () => {
  const res = await fetch(`${baseUrl}/api/snapshot?tfs=7s,basura`);
  const snap = await res.json();
  assert.deepEqual(snap.tfs, ['5m', '10m', '1h']);
});

test('/api/stream emite snapshots por SSE', async () => {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/stream?tfs=1m`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let events = 0;
  const deadline = Date.now() + 5000;
  while (events < 2 && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    events = (buffer.match(/^data: /gm) ?? []).length;
  }
  controller.abort();

  assert.ok(events >= 2, `se esperaban al menos 2 eventos, llegaron ${events}`);
  const start = buffer.indexOf('data: ') + 6;
  const first = JSON.parse(buffer.slice(start, buffer.indexOf('\n\n', start)));
  assert.deepEqual(first.tfs, ['1m']);
  assert.ok(first.rows.length > 0);
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
    const body = await res.text();
    assert.doesNotMatch(body, /BYBIT_REST|bybit-perp-screener/);
  }
});

test('otros métodos HTTP se rechazan', async () => {
  const res = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
  assert.equal(res.status, 405);
});
