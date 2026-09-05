// Doble de test de la fuente de datos. NO forma parte de la aplicación: vive en
// test/ y solo lo usan los tests, que inyectan la fuente directamente en main().
// La app publicada tiene una única fuente posible: Bybit en vivo.
//
// A diferencia de un feed "simulado", esto no inventa mercado: el test decide
// exactamente qué trades entran y cuándo, para poder comprobar cifras exactas.

export function createFakeSource({ instruments, tickers } = {}) {
  const defaultInstruments = [
    { symbol: 'BTCUSDT', category: 'linear', baseCoin: 'BTC', quoteCoin: 'USDT', contractType: 'LinearPerpetual', launchTime: 0, tickSize: '0.1' },
    { symbol: 'ETHUSDT', category: 'linear', baseCoin: 'ETH', quoteCoin: 'USDT', contractType: 'LinearPerpetual', launchTime: 0, tickSize: '0.01' },
    { symbol: 'SOLUSDC', category: 'linear', baseCoin: 'SOL', quoteCoin: 'USDC', contractType: 'LinearPerpetual', launchTime: 0, tickSize: '0.001' },
  ];

  const defaultTickers = new Map([
    ['BTCUSDT', ticker('BTCUSDT', '68123.5', -0.0283, 16_800_000_000)],
    ['ETHUSDT', ticker('ETHUSDT', '2452.83', 0.0475, 3_650_000_000)],
    ['SOLUSDC', ticker('SOLUSDC', '148.21', 0.0008, 204_380_000)],
  ]);

  const source = {
    name: 'test-fixture',
    emit: () => {},
    connected: true,
    loadInstruments: async () => instruments ?? defaultInstruments,
    loadTickers: async () => tickers ?? defaultTickers,
    createStream({ onTrade }) {
      let subscribed = [];
      source.emit = (trade) => onTrade(trade);
      return {
        setSymbols(symbols) {
          subscribed = symbols;
        },
        stop() {},
        get connected() {
          return source.connected;
        },
        status: () => ({
          category: 'test',
          url: 'fixture',
          symbols: subscribed.length,
          tradesReceived: 0,
          connections: [{ id: 'fixture-1', state: 'open', symbols: subscribed.length, reconnects: 0, lastMessageAgoMs: 0 }],
        }),
      };
    },
  };
  return source;
}

function ticker(symbol, price, change24h, turnover24h) {
  return {
    symbol,
    price,
    markPrice: price,
    change24h,
    high24h: 0,
    low24h: 0,
    turnover24h,
    volume24h: turnover24h / Number(price),
    openInterestValue: turnover24h / 10,
    fundingRate: 0.0001,
    nextFundingTime: 0,
  };
}
