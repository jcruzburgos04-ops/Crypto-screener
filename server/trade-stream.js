// Pool de conexiones WebSocket al stream público de trades de Bybit v5.
//
// `publicTrade.{símbolo}` entrega cada operación con `S` = lado del TAKER, que
// es exactamente lo que hace falta para el volume delta. Como hay cientos de
// perpetuos, los símbolos se reparten entre varias conexiones (una sola con
// 600 topics es frágil) y cada una se resuscribe sola al reconectar.

const OPEN = 1;

export class TradeStream {
  /**
   * @param {object} options
   * @param {string} options.url             endpoint público de la categoría
   * @param {'linear'|'inverse'} options.category
   * @param {(trade:object)=>void} options.onTrade
   */
  constructor({
    url,
    category = 'linear',
    onTrade,
    onLog = () => {},
    symbolsPerConnection = 100,
    topicsPerSubscribe = 10,
    pingIntervalMs = 20_000,
    staleTimeoutMs = 60_000,
    maxBackoffMs = 30_000,
    WebSocketImpl = globalThis.WebSocket,
  }) {
    this.url = url;
    this.category = category;
    this.onTrade = onTrade;
    this.onLog = onLog;
    this.symbolsPerConnection = symbolsPerConnection;
    this.topicsPerSubscribe = topicsPerSubscribe;
    this.pingIntervalMs = pingIntervalMs;
    this.staleTimeoutMs = staleTimeoutMs;
    this.maxBackoffMs = maxBackoffMs;
    this.WebSocketImpl = WebSocketImpl;

    /** @type {Array<object>} */
    this.connections = [];
    /** @type {Set<string>} */
    this.symbols = new Set();
    this.stopped = false;
    this.tradesReceived = 0;
    this.watchdog = setInterval(() => this.#checkStale(), 5000);
    this.watchdog.unref?.();
  }

  /** Ajusta el conjunto de símbolos suscritos (altas y bajas incrementales). */
  setSymbols(symbols) {
    if (this.stopped) return;
    const next = new Set(symbols);
    const added = [...next].filter((s) => !this.symbols.has(s));
    const removed = [...this.symbols].filter((s) => !next.has(s));
    this.symbols = next;

    for (const symbol of removed) {
      const conn = this.connections.find((c) => c.symbols.has(symbol));
      if (!conn) continue;
      conn.symbols.delete(symbol);
      this.#send(conn, { op: 'unsubscribe', args: [`publicTrade.${symbol}`] });
    }

    const pending = [];
    for (const symbol of added) {
      let conn = this.connections.find((c) => c.symbols.size < this.symbolsPerConnection);
      if (!conn) conn = this.#openConnection();
      conn.symbols.add(symbol);
      pending.push([conn, symbol]);
    }

    // Solo hay que suscribir explícitamente en conexiones ya abiertas: las que
    // están conectándose mandan su lista completa en el evento `open`.
    const byConn = new Map();
    for (const [conn, symbol] of pending) {
      if (conn.ws?.readyState !== OPEN) continue;
      if (!byConn.has(conn)) byConn.set(conn, []);
      byConn.get(conn).push(symbol);
    }
    for (const [conn, list] of byConn) this.#subscribe(conn, list);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    for (const conn of this.connections) this.#teardown(conn, true);
    this.connections = [];
  }

  status() {
    return {
      category: this.category,
      url: this.url,
      symbols: this.symbols.size,
      tradesReceived: this.tradesReceived,
      connections: this.connections.map((c) => ({
        id: c.id,
        state: c.state,
        symbols: c.symbols.size,
        reconnects: c.reconnects,
        lastMessageAgoMs: c.lastMessageAt ? Date.now() - c.lastMessageAt : null,
      })),
    };
  }

  get connected() {
    return this.connections.some((c) => c.state === 'open');
  }

  #openConnection() {
    const conn = {
      id: `${this.category}-${this.connections.length + 1}`,
      ws: null,
      symbols: new Set(),
      state: 'connecting',
      reconnects: 0,
      lastMessageAt: 0,
      backoffMs: 1000,
      pingTimer: null,
      reconnectTimer: null,
    };
    this.connections.push(conn);
    this.#connect(conn);
    return conn;
  }

  #connect(conn) {
    if (this.stopped) return;
    conn.state = 'connecting';
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.onLog('error', `[${conn.id}] no se pudo abrir el socket: ${err.message}`);
      this.#scheduleReconnect(conn);
      return;
    }
    conn.ws = ws;

    ws.addEventListener('open', () => {
      conn.state = 'open';
      conn.backoffMs = 1000;
      conn.lastMessageAt = Date.now();
      this.onLog('info', `[${conn.id}] conectado (${conn.symbols.size} símbolos)`);
      this.#subscribe(conn, [...conn.symbols]);
      clearInterval(conn.pingTimer);
      conn.pingTimer = setInterval(() => this.#send(conn, { op: 'ping' }), this.pingIntervalMs);
      conn.pingTimer.unref?.();
    });

    ws.addEventListener('message', (event) => {
      conn.lastMessageAt = Date.now();
      this.#handleMessage(conn, event.data);
    });

    ws.addEventListener('error', (event) => {
      this.onLog('warn', `[${conn.id}] error de socket: ${event?.message ?? 'desconocido'}`);
    });

    ws.addEventListener('close', (event) => {
      if (conn.state === 'stopped') return;
      this.onLog('warn', `[${conn.id}] cerrado (code=${event?.code ?? '?'}), reconectando`);
      this.#scheduleReconnect(conn);
    });
  }

  #handleMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (msg.success === false) {
      this.onLog('warn', `[${conn.id}] Bybit rechazó ${msg.op}: ${msg.ret_msg}`);
      return;
    }
    if (typeof msg.topic !== 'string' || !msg.topic.startsWith('publicTrade.')) return;
    const data = Array.isArray(msg.data) ? msg.data : [msg.data];
    for (const item of data) {
      if (!item) continue;
      const price = Number(item.p);
      const qty = Number(item.v);
      if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
      // Lineal: `v` viene en moneda base. Inverso: `v` ya viene en USD.
      const quoteVolume = this.category === 'inverse' ? qty : price * qty;
      this.tradesReceived++;
      this.onTrade({
        symbol: item.s,
        ts: Number(item.T),
        price,
        qty,
        quoteVolume,
        isBuy: item.S === 'Buy',
      });
    }
  }

  #subscribe(conn, symbols) {
    if (symbols.length === 0) return;
    // Bybit limita los args por mensaje: se envía en tandas escalonadas.
    for (let i = 0; i < symbols.length; i += this.topicsPerSubscribe) {
      const chunk = symbols.slice(i, i + this.topicsPerSubscribe);
      const delay = (i / this.topicsPerSubscribe) * 50;
      const timer = setTimeout(() => {
        this.#send(conn, { op: 'subscribe', args: chunk.map((s) => `publicTrade.${s}`) });
      }, delay);
      timer.unref?.();
    }
  }

  #send(conn, payload) {
    if (conn.ws?.readyState !== OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      this.onLog('warn', `[${conn.id}] fallo al enviar ${payload.op}: ${err.message}`);
      return false;
    }
  }

  #scheduleReconnect(conn) {
    if (this.stopped || conn.state === 'stopped') return;
    this.#teardown(conn, false);
    conn.state = 'reconnecting';
    conn.reconnects++;
    const jitter = Math.random() * 500;
    const wait = Math.min(conn.backoffMs, this.maxBackoffMs) + jitter;
    conn.backoffMs = Math.min(conn.backoffMs * 2, this.maxBackoffMs);
    conn.reconnectTimer = setTimeout(() => this.#connect(conn), wait);
    conn.reconnectTimer.unref?.();
  }

  #teardown(conn, permanent) {
    clearInterval(conn.pingTimer);
    clearTimeout(conn.reconnectTimer);
    conn.pingTimer = null;
    conn.reconnectTimer = null;
    if (permanent) conn.state = 'stopped';
    const ws = conn.ws;
    conn.ws = null;
    if (ws && ws.readyState <= OPEN) {
      try {
        ws.close();
      } catch {
        /* el socket ya estaba roto */
      }
    }
  }

  /** Una conexión muda más de `staleTimeoutMs` se considera colgada. */
  #checkStale() {
    if (this.stopped) return;
    const now = Date.now();
    for (const conn of this.connections) {
      if (conn.state !== 'open' || conn.symbols.size === 0) continue;
      if (now - conn.lastMessageAt > this.staleTimeoutMs) {
        this.onLog('warn', `[${conn.id}] sin mensajes en ${Math.round((now - conn.lastMessageAt) / 1000)} s`);
        this.#scheduleReconnect(conn);
      }
    }
  }
}
