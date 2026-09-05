// Servidor HTTP: sirve la interfaz estática y publica el screener por SSE.
// Sin dependencias externas: node:http + EventSource del navegador.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { loadConfig, createLogger } from './config.js';
import { Screener } from './screener.js';
import { createBybitSource } from './bybit-source.js';
import { createMockSource } from './mock-feed.js';
import { parseTimeframes } from '../public/js/timeframes.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function serveStatic(res, publicDir, pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const target = resolve(publicDir, `.${sep}${relative === '/' ? 'index.html' : relative}`);
  if (target !== publicDir && !target.startsWith(publicDir + sep)) {
    sendJson(res, 403, { error: 'ruta fuera del directorio público' });
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error('no es un archivo'), { code: 'ENOENT' });
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'no encontrado' });
  }
}

export async function main(env = process.env) {
  const config = loadConfig(env);
  const log = createLogger(config.logLevel);
  const source = config.mock ? createMockSource(config) : createBybitSource(config);

  const screener = new Screener({ config, source, log });
  await screener.start();

  /** @type {Set<{res:import('node:http').ServerResponse, timeframes:Array, key:string}>} */
  const clients = new Set();

  const pushTimer = setInterval(() => {
    if (clients.size === 0) return;
    const cache = new Map();
    for (const client of clients) {
      if (client.res.writableEnded) {
        clients.delete(client);
        continue;
      }
      // Varios clientes con los mismos timeframes comparten el cálculo.
      let payload = cache.get(client.key);
      if (payload === undefined) {
        payload = `data: ${JSON.stringify(screener.snapshot(client.timeframes))}\n\n`;
        cache.set(client.key, payload);
      }
      // Si el cliente no da abasto se salta el tick en vez de acumular memoria.
      if (client.res.writableLength > 4_000_000) continue;
      client.res.write(payload);
    }
  }, config.pushIntervalMs);
  pushTimer.unref?.();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'método no permitido' });
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, screener.health());
      return;
    }

    if (url.pathname === '/api/snapshot') {
      const timeframes = parseTimeframes(url.searchParams.get('tfs'));
      sendJson(res, 200, screener.snapshot(timeframes));
      return;
    }

    if (url.pathname === '/api/stream') {
      const timeframes = parseTimeframes(url.searchParams.get('tfs'));
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`retry: 3000\n\n`);
      res.write(`data: ${JSON.stringify(screener.snapshot(timeframes))}\n\n`);

      const client = { res, timeframes, key: timeframes.map((tf) => tf.id).join(',') };
      clients.add(client);
      req.on('close', () => clients.delete(client));
      return;
    }

    await serveStatic(res, config.publicDir, url.pathname);
  });

  await new Promise((resolveListen) => server.listen(config.port, config.host, resolveListen));
  const { port } = server.address();
  // Siempre visible, sea cual sea LOG_LEVEL: es la información que hace falta
  // para abrir la interfaz.
  console.log(`Bybit Perp Screener en http://${config.host}:${port}`);
  if (config.mock) console.log('MODO SIMULADO: los datos son inventados, no vienen de Bybit');

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log('info', `${signal}: cerrando`);
    clearInterval(pushTimer);
    for (const client of clients) client.res.end();
    clients.clear();
    server.close();
    await screener.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, screener, config, close: () => shutdown('close') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('fallo al arrancar:', err);
    process.exit(1);
  });
}
