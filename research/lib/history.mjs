// Descarga de historia horaria de Bybit v5 (endpoints públicos, sin API key).
//
// Todos los endpoints usados devuelven del más nuevo al más viejo y se anclan
// por el final: se pagina hacia atrás moviendo endTime. Si un endpoint ignora
// endTime (no hay progreso) se corta y se informa la cobertura real.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchBybit } from '../../public/js/core/bybit-rest.js';
import { HOUR_MS } from './analysis.mjs';

/** Pagina hacia atrás hasta cubrir [startMs, endMs]. Devuelve orden ascendente sin duplicados. */
export async function walkBackward({ startMs, endMs, fetchPage, time, maxPages = 400 }) {
  const byTime = new Map();
  let end = endMs;
  for (let page = 0; page < maxPages; page++) {
    const items = await fetchPage(end);
    if (!items || items.length === 0) break;
    let oldest = Infinity;
    for (const item of items) {
      const t = time(item);
      if (!Number.isFinite(t)) continue;
      if (t >= startMs && t <= endMs) byTime.set(t, item);
      if (t < oldest) oldest = t;
    }
    if (oldest <= startMs) break;
    if (!(oldest < end)) break; // el endpoint no retrocedió: no insistir
    end = oldest - 1;
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

export function createHistoryClient({ restUrl = 'https://api.bybit.com', category = 'linear', fetchImpl, cacheDir = null } = {}) {
  const get = (path, params) => fetchBybit(restUrl, path, { category, ...params }, fetchImpl ? { fetchImpl } : {});

  async function cached(key, load) {
    if (!cacheDir) return load();
    const file = join(cacheDir, `${key}.json`);
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      const data = await load();
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify(data));
      return data;
    }
  }

  return {
    async instruments() {
      const out = [];
      let cursor;
      do {
        const r = await get('/v5/market/instruments-info', { limit: 1000, cursor });
        for (const x of r.list ?? []) {
          if (x.contractType === 'LinearPerpetual' && x.status === 'Trading') {
            out.push({ symbol: x.symbol, launchTime: Number(x.launchTime) || 0, quoteCoin: x.quoteCoin });
          }
        }
        cursor = r.nextPageCursor || undefined;
      } while (cursor);
      return out;
    },

    klines(symbol, startMs, endMs) {
      return cached(`${symbol}-kline-${startMs}-${endMs}`, () =>
        walkBackward({
          startMs, endMs, time: (x) => x.t,
          fetchPage: async (end) => {
            const r = await get('/v5/market/kline', { symbol, interval: '60', end, limit: 1000 });
            return (r.list ?? []).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], q: +k[6] }));
          },
        }));
    },

    openInterest(symbol, startMs, endMs) {
      return cached(`${symbol}-oi-${startMs}-${endMs}`, () =>
        walkBackward({
          startMs, endMs, time: (x) => x.t,
          fetchPage: async (end) => {
            // startTime solo se ignora: se manda la ventana completa de 200 horas.
            const r = await get('/v5/market/open-interest', {
              symbol, intervalTime: '1h', startTime: Math.max(startMs, end - 199 * HOUR_MS), endTime: end, limit: 200,
            });
            return (r.list ?? []).map((x) => ({ t: +x.timestamp, oi: +x.openInterest }));
          },
        }));
    },

    funding(symbol, startMs, endMs) {
      return cached(`${symbol}-funding-${startMs}-${endMs}`, () =>
        walkBackward({
          startMs, endMs, time: (x) => x.t,
          fetchPage: async (end) => {
            const r = await get('/v5/market/funding/history', { symbol, endTime: end, limit: 200 });
            return (r.list ?? []).map((x) => ({ t: +x.fundingRateTimestamp, rate: +x.fundingRate }));
          },
        }));
    },

    longShort(symbol, startMs, endMs) {
      return cached(`${symbol}-ls-${startMs}-${endMs}`, () =>
        walkBackward({
          startMs, endMs, time: (x) => x.t,
          fetchPage: async (end) => {
            const r = await get('/v5/market/account-ratio', {
              symbol, period: '1h', startTime: Math.max(startMs, end - 499 * HOUR_MS), endTime: end, limit: 500,
            });
            return (r.list ?? []).map((x) => ({ t: +x.timestamp, buy: +x.buyRatio }));
          },
        }));
    },
  };
}
