// Mercado simulado. Reproduce la misma interfaz que la fuente real de Bybit
// para poder desarrollar y probar el screener sin conexión al exchange
// (por ejemplo detrás de un proxy que bloquee api.bybit.com).
//
// Genera precios en camino aleatorio y un flujo de trades con sesgo
// comprador/vendedor que va rotando, para que el volume delta se mueva.

const UNIVERSE = [
  ['BTC', 68000, 900], ['ETH', 2450, 700], ['SOL', 148, 400], ['XRP', 0.62, 260],
  ['DOGE', 0.115, 220], ['BNB', 585, 120], ['HYPE', 84.93, 150], ['SUI', 0.784, 180],
  ['ADA', 0.2127, 140], ['LINK', 12.4, 130], ['AVAX', 21.8, 110], ['TRX', 0.3329, 90],
  ['NEAR', 2.259, 95], ['DOT', 3.85, 70], ['LTC', 82.5, 85], ['ZEC', 1010.49, 160],
  ['DASH', 67.84, 75], ['ZEN', 7.28, 45], ['ASTER', 0.7858, 120], ['UNI', 6.27, 100],
  ['PROM', 5.41, 30], ['ZKP', 0.04867, 25], ['APT', 4.6, 60], ['ARB', 0.33, 55],
  ['OP', 0.68, 50], ['TIA', 1.9, 45], ['INJ', 9.2, 40], ['SEI', 0.24, 42],
  ['TON', 2.85, 65], ['PEPE', 0.0000072, 130], ['WIF', 0.71, 70], ['BONK', 0.0000155, 60],
  ['FIL', 2.35, 35], ['ATOM', 3.9, 38], ['ETC', 15.6, 40], ['XLM', 0.245, 44],
  ['HBAR', 0.145, 46], ['ICP', 4.7, 33], ['RENDER', 3.1, 30], ['FET', 0.62, 34],
  ['AAVE', 168, 55], ['MKR', 1320, 25], ['CRV', 0.42, 28], ['LDO', 0.98, 26],
  ['ENA', 0.31, 48], ['JUP', 0.44, 30], ['PYTH', 0.11, 22], ['STRK', 0.14, 20],
  ['ORDI', 8.9, 24], ['1000SATS', 0.00008, 18], ['NOT', 0.0022, 21], ['W', 0.07, 17],
  ['MANTA', 0.19, 15], ['ALT', 0.026, 14], ['ONDO', 0.72, 36], ['ETHFI', 0.82, 19],
  ['GALA', 0.014, 23], ['SAND', 0.24, 20], ['AXS', 3.4, 18], ['GRT', 0.086, 22],
];

const gauss = () => {
  const u = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
};

export function createMockSource(config) {
  const quote = config.quoteCoins[0] ?? 'USDT';
  const state = new Map();
  const startedAt = Date.now();

  for (const [base, price, liquidity] of UNIVERSE) {
    const symbol = `${base}${quote}`;
    state.set(symbol, {
      symbol,
      base,
      price,
      openPrice: price,
      liquidity, // ~ trades por segundo
      bias: gauss() * 0.15, // sesgo comprador/vendedor persistente
      turnover24h: liquidity * 1_200_000 * (0.5 + Math.random()),
      openInterestValue: liquidity * 250_000 * (0.5 + Math.random()),
      fundingRate: (Math.random() - 0.5) * 0.0004,
    });
  }

  const instruments = [...state.values()].map((s) => ({
    symbol: s.symbol,
    category: 'linear',
    baseCoin: s.base,
    quoteCoin: quote,
    contractType: 'LinearPerpetual',
    launchTime: startedAt,
    tickSize: '',
  }));

  return {
    name: 'mock',

    async loadInstruments() {
      return instruments;
    },

    async loadTickers() {
      const out = new Map();
      for (const s of state.values()) {
        out.set(s.symbol, {
          symbol: s.symbol,
          price: formatPrice(s.price),
          markPrice: formatPrice(s.price),
          change24h: s.price / s.openPrice - 1,
          high24h: s.openPrice * 1.05,
          low24h: s.openPrice * 0.95,
          turnover24h: s.turnover24h,
          volume24h: s.turnover24h / s.price,
          openInterestValue: s.openInterestValue,
          fundingRate: s.fundingRate,
          nextFundingTime: startedAt + 8 * 3600_000,
        });
      }
      return out;
    },

    createStream({ onTrade, onLog = () => {} }) {
      let subscribed = [];
      let tradesReceived = 0;
      const tickMs = 250;

      const timer = setInterval(() => {
        const now = Date.now();
        for (const symbol of subscribed) {
          const s = state.get(symbol);
          if (!s) continue;
          // El sesgo deriva lentamente: crea rachas de delta positivo/negativo.
          s.bias = s.bias * 0.995 + gauss() * 0.03;
          s.price = Math.max(1e-9, s.price * (1 + gauss() * 0.0004 + s.bias * 0.0002));

          const expected = (s.liquidity * tickMs) / 1000;
          const count = Math.max(0, Math.round(expected + gauss() * Math.sqrt(expected + 1)));
          for (let i = 0; i < count; i++) {
            const isBuy = Math.random() < 0.5 + Math.max(-0.35, Math.min(0.35, s.bias));
            const notional = Math.exp(gauss() * 1.4) * (s.liquidity * 12);
            const qty = notional / s.price;
            tradesReceived++;
            s.turnover24h += notional;
            onTrade({
              symbol,
              ts: now,
              price: s.price,
              qty,
              quoteVolume: notional,
              isBuy,
            });
          }
        }
      }, tickMs);
      timer.unref?.();

      onLog('info', `feed simulado activo (${UNIVERSE.length} pares)`);

      return {
        setSymbols(symbols) {
          subscribed = symbols.filter((s) => state.has(s));
        },
        stop() {
          clearInterval(timer);
        },
        get connected() {
          return true;
        },
        status() {
          return {
            category: 'mock',
            url: 'simulado',
            symbols: subscribed.length,
            tradesReceived,
            connections: [
              { id: 'mock-1', state: 'open', symbols: subscribed.length, reconnects: 0, lastMessageAgoMs: 0 },
            ],
          };
        },
      };
    },
  };
}

function formatPrice(price) {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toPrecision(4);
}
