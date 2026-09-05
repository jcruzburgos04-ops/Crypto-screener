// Motor del modo directo: corre dentro de un Web Worker y habla con Bybit sin
// pasar por ningún servidor propio.
//
// Va en un worker a propósito: en horas punta llegan miles de trades por
// segundo y parsearlos en el hilo principal dejaría la tabla a tirones. Aquí se
// acumulan los números y solo se envía un snapshot ya resumido cada tick.

import { Screener } from './core/screener.js';
import { createBybitSource } from './core/bybit-source.js';
import { parseTimeframes } from './timeframes.js';

let screener = null;
let pushTimer = null;
let healthTimer = null;
let timeframes = parseTimeframes([]);

const post = (message) => self.postMessage(message);

self.addEventListener('message', (event) => {
  const message = event.data ?? {};
  handle(message).catch((err) => {
    post({ type: 'error', message: err?.message ?? String(err) });
  });
});

async function handle(message) {
  switch (message.type) {
    case 'start':
      await start(message);
      break;
    case 'timeframes':
      timeframes = parseTimeframes(message.tfs);
      pushSnapshot();
      break;
    case 'maxSymbols':
      await screener?.setMaxSymbols(message.value);
      break;
    case 'stop':
      await stop();
      break;
    default:
      break;
  }
}

async function start({ config, tfs, pushIntervalMs = 1500 }) {
  await stop();
  timeframes = parseTimeframes(tfs);

  const source = createBybitSource(config);
  screener = new Screener({
    config,
    source,
    log: (kind, text) => post({ type: 'log', kind, message: text }),
    persistence: null, // en el navegador el historial vive mientras la pestaña esté abierta
  });

  try {
    await screener.start();
  } catch (err) {
    post({
      type: 'error',
      message: `No se pudo contactar con la API de Bybit: ${err?.message ?? err}`,
      fatal: true,
    });
    return;
  }

  post({ type: 'ready' });
  pushSnapshot();
  pushTimer = setInterval(pushSnapshot, pushIntervalMs);
  healthTimer = setInterval(() => post({ type: 'health', health: screener.health() }), 5000);
  post({ type: 'health', health: screener.health() });
}

function pushSnapshot() {
  if (!screener) return;
  post({ type: 'snapshot', snapshot: screener.snapshot(timeframes) });
}

async function stop() {
  clearInterval(pushTimer);
  clearInterval(healthTimer);
  pushTimer = null;
  healthTimer = null;
  if (screener) {
    await screener.stop();
    screener = null;
  }
}
