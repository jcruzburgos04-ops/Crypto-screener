// Configuración por variables de entorno. Todo tiene un valor por defecto
// razonable: `npm start` debería funcionar sin configurar nada.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
};

const list = (value, fallback) => {
  if (value === undefined) return fallback;
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
};

export function loadConfig(env = process.env) {
  const categories = list(env.CATEGORIES, ['linear']).filter((c) =>
    ['linear', 'inverse'].includes(c),
  );

  return {
    root: ROOT,
    publicDir: join(ROOT, 'public'),

    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 8787),

    restUrl: env.BYBIT_REST || 'https://api.bybit.com',
    wsUrl: env.BYBIT_WS || 'wss://stream.bybit.com/v5/public',
    categories: categories.length > 0 ? categories : ['linear'],
    // Vacío = todas las monedas de cotización (USDT, USDC, USD inverso...).
    quoteCoins: list(env.QUOTE_COINS, []),
    maxSymbols: num(env.MAX_SYMBOLS, 0), // 0 = sin límite

    tickerIntervalMs: num(env.TICKER_INTERVAL_MS, 3000),
    instrumentsIntervalMs: num(env.INSTRUMENTS_INTERVAL_MS, 30 * 60_000),
    pushIntervalMs: num(env.PUSH_INTERVAL_MS, 1500),

    symbolsPerConnection: num(env.SYMBOLS_PER_CONNECTION, 100),
    topicsPerSubscribe: num(env.TOPICS_PER_SUBSCRIBE, 10),

    persist: bool(env.PERSIST, true),
    snapshotFile: env.SNAPSHOT_FILE || join(ROOT, 'data', 'volume-snapshot.bin'),
    snapshotIntervalMs: num(env.SNAPSHOT_INTERVAL_MS, 300_000),

    logLevel: env.LOG_LEVEL || 'info',
  };
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  return (kind, message) => {
    if ((LEVELS[kind] ?? LEVELS.info) < threshold) return;
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `${stamp} ${kind.padEnd(5)} ${message}`;
    if (kind === 'error') console.error(line);
    else if (kind === 'warn') console.warn(line);
    else console.log(line);
  };
}
