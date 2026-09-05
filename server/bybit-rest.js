// Cliente REST v5 de Bybit (solo endpoints públicos de mercado, sin API key).
//
// Se usa para dos cosas:
//   - la lista de instrumentos (qué perpetuos existen), cada 30 min
//   - los tickers (precio, %24h, volumen 24h, OI, funding) de TODOS los
//     símbolos en una sola llamada, cada pocos segundos
// El delta de volumen NO sale de aquí: las velas de Bybit no traen el desglose
// comprador/vendedor. Eso lo aporta el WebSocket de trades.

const DEFAULT_TIMEOUT_MS = 15_000;

export class BybitApiError extends Error {
  constructor(message, { retCode, status } = {}) {
    super(message);
    this.name = 'BybitApiError';
    this.retCode = retCode;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchBybit(baseUrl, path, params = {}, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 3, fetchImpl = fetch } = options;
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        // 4xx distinto de 429 no se arregla reintentando.
        const err = new BybitApiError(`HTTP ${res.status} en ${path}`, { status: res.status });
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
        lastError = err;
        continue;
      }
      const body = await res.json();
      if (body.retCode !== 0) {
        throw new BybitApiError(`${path}: ${body.retMsg || 'error desconocido'}`, {
          retCode: body.retCode,
        });
      }
      return body.result;
    } catch (err) {
      if (err instanceof BybitApiError && err.retCode !== undefined) throw err;
      if (err instanceof BybitApiError && err.status && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new BybitApiError(`fallo al consultar ${path}`);
}

const PERPETUAL_CONTRACTS = new Set(['LinearPerpetual', 'InversePerpetual']);

/**
 * Lista los perpetuos operables de una categoría (`linear` o `inverse`),
 * paginando con el cursor de Bybit.
 */
export async function fetchInstruments(config, options = {}) {
  const out = [];
  for (const category of config.categories) {
    let cursor;
    let pages = 0;
    do {
      const result = await fetchBybit(
        config.restUrl,
        '/v5/market/instruments-info',
        { category, limit: 1000, cursor },
        options,
      );
      for (const item of result.list ?? []) {
        if (item.status !== 'Trading') continue;
        if (!PERPETUAL_CONTRACTS.has(item.contractType)) continue; // fuera futuros con vencimiento
        if (config.quoteCoins.length > 0 && !config.quoteCoins.includes(item.quoteCoin)) continue;
        out.push({
          symbol: item.symbol,
          category,
          baseCoin: item.baseCoin,
          quoteCoin: item.quoteCoin,
          contractType: item.contractType,
          launchTime: Number(item.launchTime) || 0,
          tickSize: item.priceFilter?.tickSize ?? '',
        });
      }
      cursor = result.nextPageCursor || undefined;
      pages++;
    } while (cursor && pages < 20);
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/** Snapshot de tickers de todos los símbolos de las categorías configuradas. */
export async function fetchTickers(config, options = {}) {
  const tickers = new Map();
  for (const category of config.categories) {
    const result = await fetchBybit(config.restUrl, '/v5/market/tickers', { category }, options);
    for (const item of result.list ?? []) {
      tickers.set(item.symbol, {
        symbol: item.symbol,
        price: item.lastPrice ?? '0',
        markPrice: item.markPrice ?? '',
        change24h: Number(item.price24hPcnt) || 0, // fracción: 0.0123 = +1.23 %
        high24h: Number(item.highPrice24h) || 0,
        low24h: Number(item.lowPrice24h) || 0,
        turnover24h: Number(item.turnover24h) || 0, // volumen 24 h en USD
        volume24h: Number(item.volume24h) || 0, // volumen 24 h en moneda base
        openInterestValue: Number(item.openInterestValue) || 0,
        fundingRate: Number(item.fundingRate) || 0,
        nextFundingTime: Number(item.nextFundingTime) || 0,
      });
    }
  }
  return tickers;
}
