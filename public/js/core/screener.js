// Orquestador: mantiene la lista de perpetuos, los tickers y el acumulador de
// volume delta, y produce los snapshots que consume la interfaz.
//
// No depende de Node: corre igual en el servidor y dentro de un Web Worker del
// navegador. Lo único específico de cada entorno es la persistencia, que se
// inyecta (`persistence`) y puede no existir.

import { VolumeStore } from './volume-store.js';
import { pineEmaLive, pineEmaState } from './ema.js';
import { DAY_MS, EMA_LENGTHS, evaluateCombos } from './combos.js';

const EMPTY_EMAS = EMA_LENGTHS.map(() => null);
const round = (x) => (x === null ? null : Number(x.toPrecision(10)));

export class Screener {
  constructor({ config, source, log = () => {}, persistence = null }) {
    this.config = config;
    this.source = source;
    this.log = log;
    this.persistence = persistence;

    this.store = new VolumeStore();
    /** @type {Map<string, object>} */
    this.instruments = new Map();
    /** @type {Map<string, object>} */
    this.tickers = new Map();
    /** @type {Map<string, object>} */
    this.streams = new Map();

    this.startedAt = Date.now();
    this.lastTickerAt = 0;
    this.tickerErrors = 0;
    this.instrumentErrors = 0;
    this.lastError = null;
    this.timers = [];
    this.stopped = false;
    this.persistedTrades = -1;

    // Velas diarias por símbolo para los combos de EMAs.
    /** @type {Map<string, {day:number, states:object[], count:number, todayClose:number}>} */
    this.klines = new Map();
    this.klineQueue = [];
    this.klineQueued = new Set();
    this.klineInFlight = 0;
    this.klineErrors = 0;
    this.klineWaiters = [];
  }

  async start() {
    if (this.persistence) await this.#restore();

    await this.#refreshTickers();
    await this.#refreshInstruments();

    for (const category of this.config.categories) {
      const stream = this.source.createStream({
        category,
        onTrade: (trade) => this.store.addTrade(trade.symbol, trade.ts, trade.quoteVolume, trade.isBuy),
        onLog: this.log,
      });
      this.streams.set(category, stream);
    }
    this.#syncSubscriptions();

    this.#every(this.config.tickerIntervalMs, () => this.#refreshTickers());
    this.#every(this.config.instrumentsIntervalMs, () => this.#refreshInstruments());
    // Rotar los cubos aunque no llegue ningún trade: si no, un mercado parado
    // seguiría mostrando delta viejo.
    this.#every(1000, () => {
      this.store.advance();
      this.#checkDayRollover();
    });
    if (this.persistence) {
      this.#every(this.config.snapshotIntervalMs, () => this.#persist());
    }

    this.log(
      'info',
      `screener listo: ${this.instruments.size} perpetuos (${this.config.categories.join(', ')}) vía ${this.source.name}`,
    );
  }

  /** Cambia en caliente cuántos pares se siguen (lo usa el modo directo). */
  async setMaxSymbols(maxSymbols) {
    if (this.config.maxSymbols === maxSymbols) return;
    this.config.maxSymbols = maxSymbols;
    await this.#refreshInstruments();
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const stream of this.streams.values()) stream.stop();
    if (this.persistence) await this.#persist();
  }

  /**
   * Construye el snapshot que se envía al navegador.
   * @param {Array<{id:string, ms:number}>} timeframes
   */
  snapshot(timeframes) {
    const now = Date.now();
    this.store.advance(now);
    const windows = timeframes.map((tf) => tf.ms);
    const rows = [];

    for (const inst of this.instruments.values()) {
      const ticker = this.tickers.get(inst.symbol);
      const entry = this.store.entries.get(inst.symbol);
      const reads = this.store.read(entry ?? null, windows);
      const deltas = {};
      for (let i = 0; i < timeframes.length; i++) {
        const r = reads[i];
        deltas[timeframes[i].id] = [Math.round(r.delta), Math.round(r.total)];
      }
      rows.push({
        s: inst.symbol,
        b: inst.baseCoin,
        q: inst.quoteCoin,
        p: ticker?.price ?? '',
        c: ticker?.change24h ?? 0,
        v: Math.round(ticker?.turnover24h ?? 0),
        oi: Math.round(ticker?.openInterestValue ?? 0),
        f: ticker?.fundingRate ?? 0,
        d: deltas,
        cov: entry ? Math.max(0, now - Math.max(entry.since, this.store.startedAt)) : 0,
        lt: entry?.lastTradeMs ? Math.round((now - entry.lastTradeMs) / 1000) : null,
        ...this.#combosFor(inst.symbol, ticker, now),
      });
    }

    // El cliente necesita poder distinguir "delta 0 porque no hubo trades" de
    // "delta 0 porque el feed está caído": nunca se muestran cifras viejas como
    // si fueran de ahora mismo.
    const streamsUp = this.streams.size > 0 && [...this.streams.values()].every((s) => s.connected);
    const tickerAgeMs = this.lastTickerAt ? now - this.lastTickerAt : null;
    const tickersFresh =
      tickerAgeMs !== null && tickerAgeMs < Math.max(15_000, this.config.tickerIntervalMs * 4);

    return {
      t: now,
      tfs: timeframes.map((tf) => tf.id),
      up: now - this.startedAt,
      cov: Math.max(0, now - this.store.startedAt),
      live: streamsUp && tickersFresh,
      streamsUp,
      tickersFresh,
      tickerAgeMs,
      instruments: this.instruments.size,
      klines: { loaded: this.#klinesLoaded(now), total: this.instruments.size },
      trades: this.store.trades,
      lastError: this.lastError,
      rows,
    };
  }

  health() {
    const now = Date.now();
    return {
      source: this.source.name,
      uptimeMs: now - this.startedAt,
      coverageMs: now - this.store.startedAt,
      instruments: this.instruments.size,
      tickers: this.tickers.size,
      tickerAgeMs: this.lastTickerAt ? now - this.lastTickerAt : null,
      tickerErrors: this.tickerErrors,
      instrumentErrors: this.instrumentErrors,
      lastError: this.lastError,
      trades: this.store.trades,
      droppedTrades: this.store.droppedTrades,
      klines: {
        loaded: this.#klinesLoaded(now),
        pending: this.klineQueue.length + this.klineInFlight,
        errors: this.klineErrors,
      },
      symbolsWithTrades: this.store.size,
      streams: [...this.streams.values()].map((s) => s.status()),
      memoryMB:
        typeof process !== 'undefined' && process.memoryUsage
          ? Math.round(process.memoryUsage().rss / 1e6)
          : null,
    };
  }

  /** Resuelve cuando no queda ninguna descarga de velas pendiente. */
  waitForKlines() {
    if (this.klineQueue.length === 0 && this.klineInFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.klineWaiters.push(resolve));
  }

  /**
   * Valores de los combos para un símbolo. La EMA se calcula sobre TODAS las
   * velas descargadas; la vela de hoy (en curso) toma el último precio.
   * Todo lo que no imprime va null, nunca un número rellenado.
   */
  #combosFor(symbol, ticker, now) {
    const data = this.klines.get(symbol);
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    // Sin velas, o con velas de un día que ya cerró y aún no se recargó.
    if (!data || data.day !== today) return { ema: EMPTY_EMAS, rg: null, fd: null, kn: null };

    const tickerPrice = Number(ticker?.price);
    const live = Number.isFinite(tickerPrice) && tickerPrice > 0 ? tickerPrice : data.todayClose;
    const emas = data.states.map((state) => round(pineEmaLive(state, live)));
    return { ...evaluateCombos(emas), kn: data.count + (Number.isFinite(live) ? 1 : 0) };
  }

  #klinesLoaded(now) {
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    let n = 0;
    for (const [symbol, data] of this.klines) if (data.day === today && this.instruments.has(symbol)) n++;
    return n;
  }

  #queueKlines(symbol) {
    if (!this.source.loadDailyKlines || this.klineQueued.has(symbol) || this.stopped) return;
    this.klineQueued.add(symbol);
    this.klineQueue.push(symbol);
    this.#pumpKlines();
  }

  #pumpKlines() {
    const concurrency = this.config.klineConcurrency ?? 4;
    while (this.klineInFlight < concurrency && this.klineQueue.length > 0 && !this.stopped) {
      const symbol = this.klineQueue.shift();
      this.klineInFlight++;
      this.#loadKlines(symbol).finally(() => {
        this.klineQueued.delete(symbol);
        this.klineInFlight--;
        // Espaciado entre pedidos para no rozar el límite de la API pública.
        // Sin unref: solo existe mientras queda cola, y tiene que poder terminarla.
        setTimeout(() => this.#pumpKlines(), this.config.klineSpacingMs ?? 150);
        if (this.klineQueue.length === 0 && this.klineInFlight === 0) {
          for (const resolve of this.klineWaiters.splice(0)) resolve();
        }
      });
    }
  }

  async #loadKlines(symbol) {
    const inst = this.instruments.get(symbol);
    if (!inst) return;
    let candles;
    try {
      candles = await this.source.loadDailyKlines(symbol, inst.category);
    } catch (err) {
      this.klineErrors++;
      this.lastError = `velas ${symbol}: ${err.message}`;
      this.log('warn', this.lastError);
      const retry = setTimeout(() => this.#queueKlines(symbol), 60_000);
      retry.unref?.();
      return;
    }
    const now = Date.now();
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    const closed = [];
    let todayClose = NaN;
    for (const candle of candles) {
      if (candle.start < today) closed.push(candle.close);
      else if (candle.start === today) todayClose = candle.close;
    }
    this.klines.set(symbol, {
      day: today,
      count: closed.length,
      todayClose,
      states: EMA_LENGTHS.map((length) => pineEmaState(closed, length)),
    });
  }

  /** A las 00:00 UTC la vela de ayer cierra: hay que recargar cada símbolo. */
  #checkDayRollover() {
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    for (const [symbol, data] of this.klines) {
      if (data.day !== today) this.#queueKlines(symbol);
    }
  }

  #every(intervalMs, fn) {
    if (!(intervalMs > 0)) return;
    const timer = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => {
          this.lastError = err.message;
          this.log('error', err.message);
        });
    }, intervalMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  async #refreshTickers() {
    try {
      this.tickers = await this.source.loadTickers();
      this.lastTickerAt = Date.now();
    } catch (err) {
      this.tickerErrors++;
      this.lastError = `tickers: ${err.message}`;
      this.log('warn', `no se pudieron actualizar los tickers: ${err.message}`);
    }
  }

  async #refreshInstruments() {
    let list;
    try {
      list = await this.source.loadInstruments();
    } catch (err) {
      this.instrumentErrors++;
      this.lastError = `instrumentos: ${err.message}`;
      this.log('warn', `no se pudo actualizar la lista de instrumentos: ${err.message}`);
      return;
    }

    if (this.config.maxSymbols > 0 && list.length > this.config.maxSymbols) {
      // Recorte por liquidez: quedarse con los pares más negociados.
      list = [...list]
        .sort((a, b) => (this.tickers.get(b.symbol)?.turnover24h ?? 0) - (this.tickers.get(a.symbol)?.turnover24h ?? 0))
        .slice(0, this.config.maxSymbols)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    const previous = new Set(this.instruments.keys());
    const next = new Map(list.map((inst) => [inst.symbol, inst]));
    const added = [...next.keys()].filter((s) => !previous.has(s));
    const removed = [...previous].filter((s) => !next.has(s));
    this.instruments = next;

    for (const symbol of removed) this.klines.delete(symbol);
    for (const inst of next.values()) if (!this.klines.has(inst.symbol)) this.#queueKlines(inst.symbol);

    if (added.length > 0 || removed.length > 0) {
      if (previous.size > 0) {
        this.log('info', `instrumentos: +${added.length} / -${removed.length} (total ${next.size})`);
      }
      this.#syncSubscriptions();
    }
  }

  #syncSubscriptions() {
    for (const [category, stream] of this.streams) {
      const symbols = [];
      for (const inst of this.instruments.values()) {
        if (inst.category === category) symbols.push(inst.symbol);
      }
      stream.setSymbols(symbols);
    }
  }

  async #restore() {
    try {
      const restored = await this.persistence.load();
      if (restored) {
        this.store = restored;
        const hours = ((Date.now() - restored.startedAt) / 3600_000).toFixed(1);
        this.log('info', `historial restaurado: ${restored.size} símbolos, ${hours} h de cobertura`);
      }
    } catch (err) {
      this.log('warn', err.message);
    }
  }

  async #persist() {
    // Sin trades nuevos el archivo sería idéntico: no vale la pena reescribir
    // ~17 MB cada pocos minutos.
    if (this.store.trades === this.persistedTrades) return;
    try {
      const bytes = await this.persistence.save(this.store);
      this.persistedTrades = this.store.trades;
      this.log('debug', `snapshot guardado (${Math.round(bytes / 1024)} KB)`);
    } catch (err) {
      this.log('warn', `no se pudo guardar el snapshot: ${err.message}`);
    }
  }
}
