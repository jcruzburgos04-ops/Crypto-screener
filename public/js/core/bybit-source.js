// Fuente de datos real: REST para instrumentos y tickers, WebSocket para trades.

import { fetchInstruments, fetchTickers } from './bybit-rest.js';
import { TradeStream } from './trade-stream.js';

export function createBybitSource(config) {
  return {
    name: 'bybit',

    loadInstruments() {
      return fetchInstruments(config);
    },

    loadTickers() {
      return fetchTickers(config);
    },

    createStream({ category, onTrade, onLog }) {
      return new TradeStream({
        url: `${config.wsUrl.replace(/\/$/, '')}/${category}`,
        category,
        onTrade,
        onLog,
        symbolsPerConnection: config.symbolsPerConnection,
        topicsPerSubscribe: config.topicsPerSubscribe,
      });
    },
  };
}
