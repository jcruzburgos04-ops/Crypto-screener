import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeStream } from '../public/js/core/trade-stream.js';

// WebSocket falso que imita el protocolo v5 de Bybit para poder probar
// suscripciones, parseo de trades y reconexión sin tocar el exchange.
class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = 3;
  }

  // --- helpers del test ---
  serverOpen() {
    this.readyState = 1;
    this.emit('open', {});
  }

  serverSend(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  serverClose(code = 1006) {
    this.readyState = 3;
    this.emit('close', { code });
  }

  get subscribed() {
    return this.sent.filter((m) => m.op === 'subscribe').flatMap((m) => m.args);
  }
}

function createStream(overrides = {}) {
  FakeSocket.instances = [];
  const trades = [];
  const stream = new TradeStream({
    url: 'wss://stream.test/v5/public/linear',
    category: 'linear',
    onTrade: (trade) => trades.push(trade),
    onLog: () => {},
    symbolsPerConnection: 3,
    topicsPerSubscribe: 2,
    WebSocketImpl: FakeSocket,
    ...overrides,
  });
  return { stream, trades };
}

test('reparte los símbolos entre varias conexiones', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream } = createStream();

  stream.setSymbols(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT']);
  assert.equal(FakeSocket.instances.length, 2); // 3 + 2 con tope de 3
  assert.equal(stream.status().symbols, 5);

  stream.stop();
});

test('al abrir se suscribe en tandas del tamaño configurado', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream } = createStream();
  stream.setSymbols(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

  const socket = FakeSocket.instances[0];
  socket.serverOpen();
  t.mock.timers.tick(500);

  const subscribes = socket.sent.filter((m) => m.op === 'subscribe');
  assert.equal(subscribes.length, 2); // 3 topics en tandas de 2
  assert.deepEqual(socket.subscribed.sort(), [
    'publicTrade.BTCUSDT',
    'publicTrade.ETHUSDT',
    'publicTrade.SOLUSDT',
  ]);
  stream.stop();
});

test('un trade lineal se convierte a volumen en USD', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream, trades } = createStream();
  stream.setSymbols(['BTCUSDT']);
  const socket = FakeSocket.instances[0];
  socket.serverOpen();
  t.mock.timers.tick(500);

  // Mensaje con la forma real de Bybit v5.
  socket.serverSend({
    topic: 'publicTrade.BTCUSDT',
    type: 'snapshot',
    ts: 1672304486868,
    data: [
      { T: 1672304486865, s: 'BTCUSDT', S: 'Buy', v: '0.001', p: '16578.50', L: 'PlusTick', i: 'x', BT: false },
      { T: 1672304486866, s: 'BTCUSDT', S: 'Sell', v: '2', p: '16578.50', L: 'MinusTick', i: 'y', BT: false },
    ],
  });

  assert.equal(trades.length, 2);
  assert.equal(trades[0].isBuy, true);
  assert.ok(Math.abs(trades[0].quoteVolume - 16.5785) < 1e-9); // 16578.50 * 0.001
  assert.equal(trades[1].isBuy, false);
  assert.equal(trades[1].quoteVolume, 33157);
  assert.equal(trades[1].ts, 1672304486866);
  stream.stop();
});

test('en contratos inversos el tamaño ya viene en USD', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream, trades } = createStream({ category: 'inverse' });
  stream.setSymbols(['BTCUSD']);
  const socket = FakeSocket.instances[0];
  socket.serverOpen();
  t.mock.timers.tick(500);

  socket.serverSend({
    topic: 'publicTrade.BTCUSD',
    data: [{ T: 1672304486865, s: 'BTCUSD', S: 'Buy', v: '500', p: '16578.50' }],
  });

  assert.equal(trades[0].quoteVolume, 500);
  stream.stop();
});

test('los mensajes que no son trades no rompen nada', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream, trades } = createStream();
  stream.setSymbols(['BTCUSDT']);
  const socket = FakeSocket.instances[0];
  socket.serverOpen();
  t.mock.timers.tick(500);

  socket.serverSend({ success: true, ret_msg: 'subscribe', op: 'subscribe' });
  socket.serverSend({ success: true, ret_msg: 'pong', op: 'ping' });
  socket.serverSend({ success: false, ret_msg: 'Invalid symbol', op: 'subscribe' });
  socket.emit('message', { data: 'esto no es json' });

  assert.equal(trades.length, 0);
  stream.stop();
});

test('manda ping periódico para mantener viva la conexión', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream } = createStream({ pingIntervalMs: 20_000 });
  stream.setSymbols(['BTCUSDT']);
  const socket = FakeSocket.instances[0];
  socket.serverOpen();

  t.mock.timers.tick(65_000);
  assert.equal(socket.sent.filter((m) => m.op === 'ping').length, 3);
  stream.stop();
});

test('si la conexión cae se reconecta y se resuscribe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream } = createStream();
  stream.setSymbols(['BTCUSDT', 'ETHUSDT']);

  const first = FakeSocket.instances[0];
  first.serverOpen();
  t.mock.timers.tick(500);
  first.serverClose(1006);

  assert.equal(FakeSocket.instances.length, 1, 'espera al backoff antes de reconectar');
  t.mock.timers.tick(2000);
  assert.equal(FakeSocket.instances.length, 2);

  const second = FakeSocket.instances[1];
  second.serverOpen();
  t.mock.timers.tick(500);
  assert.deepEqual(second.subscribed.sort(), ['publicTrade.BTCUSDT', 'publicTrade.ETHUSDT']);
  assert.equal(stream.status().connections[0].reconnects, 1);
  stream.stop();
});

test('quitar un símbolo envía unsubscribe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream } = createStream();
  stream.setSymbols(['BTCUSDT', 'ETHUSDT']);
  const socket = FakeSocket.instances[0];
  socket.serverOpen();
  t.mock.timers.tick(500);

  stream.setSymbols(['BTCUSDT']);
  const unsubs = socket.sent.filter((m) => m.op === 'unsubscribe');
  assert.deepEqual(unsubs, [{ op: 'unsubscribe', args: ['publicTrade.ETHUSDT'] }]);
  assert.equal(stream.status().symbols, 1);
  stream.stop();
});

test('los símbolos nuevos se suscriben en conexiones ya abiertas', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { stream } = createStream();
  stream.setSymbols(['BTCUSDT']);
  const socket = FakeSocket.instances[0];
  socket.serverOpen();
  t.mock.timers.tick(500);

  stream.setSymbols(['BTCUSDT', 'NEWUSDT']); // listado nuevo detectado en caliente
  t.mock.timers.tick(500);

  assert.ok(socket.subscribed.includes('publicTrade.NEWUSDT'));
  assert.equal(FakeSocket.instances.length, 1, 'reutiliza la conexión con hueco');
  stream.stop();
});

test('una conexión muda demasiado tiempo se reinicia', (t) => {
  // El watchdog compara contra Date.now(): hay que simular también el reloj.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { stream } = createStream({ staleTimeoutMs: 30_000, pingIntervalMs: 1_000_000 });
  stream.setSymbols(['BTCUSDT']);
  const socket = FakeSocket.instances[0];
  socket.serverOpen();
  t.mock.timers.tick(500);

  t.mock.timers.tick(40_000); // sin un solo mensaje
  t.mock.timers.tick(5000); // deja pasar el backoff
  assert.equal(FakeSocket.instances.length, 2);
  stream.stop();
});
