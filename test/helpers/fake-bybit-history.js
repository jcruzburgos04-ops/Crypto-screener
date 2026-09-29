// Doble de la API histórica de Bybit para probar el estudio sin red. Sirve
// series que arma el test y respeta la paginación real: del más nuevo al más
// viejo, anclado por el final, con los límites por pedido de cada endpoint.

export function createFakeHistoryFetch(bySymbol) {
  const newestFirst = (rows, time, { end, start, limit }) =>
    rows.filter((r) => time(r) <= end && (start === undefined || time(r) >= start))
      .sort((a, b) => time(b) - time(a))
      .slice(0, limit);

  const requests = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    requests.push(`${u.pathname}?${u.searchParams}`);
    const data = bySymbol[p.symbol];
    let result;
    switch (u.pathname) {
      case '/v5/market/instruments-info':
        result = { list: Object.keys(bySymbol).map((symbol) => ({ symbol, contractType: 'LinearPerpetual', status: 'Trading', quoteCoin: 'USDT', launchTime: '0' })) };
        break;
      case '/v5/market/kline':
        result = { list: newestFirst(data.klines, (k) => k.t, { end: +p.end, limit: Math.min(+p.limit, 1000) })
          .map((k) => [String(k.t), String(k.o), String(k.h), String(k.l), String(k.c), '0', String(k.q)]) };
        break;
      case '/v5/market/open-interest':
        // Como la real: un startTime sin endTime se ignora.
        result = { list: newestFirst(data.oi, (x) => x.t, { end: +p.endTime, start: p.endTime ? +p.startTime : undefined, limit: Math.min(+p.limit, 200) })
          .map((x) => ({ openInterest: String(x.oi), timestamp: String(x.t) })) };
        break;
      case '/v5/market/funding/history':
        result = { list: newestFirst(data.funding, (x) => x.t, { end: +p.endTime, limit: Math.min(+p.limit, 200) })
          .map((x) => ({ symbol: p.symbol, fundingRate: String(x.rate), fundingRateTimestamp: String(x.t) })) };
        break;
      case '/v5/market/account-ratio':
        result = { list: newestFirst(data.ls, (x) => x.t, { end: +p.endTime, start: +p.startTime, limit: Math.min(+p.limit, 500) })
          .map((x) => ({ symbol: p.symbol, buyRatio: String(x.buy), sellRatio: String(1 - x.buy), timestamp: String(x.t) })) };
        break;
      default:
        return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ retCode: 0, retMsg: 'OK', result }) };
  };
  return { fetchImpl, requests };
}
