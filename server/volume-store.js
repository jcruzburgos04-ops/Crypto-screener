// Acumulador de volume delta por símbolo.
//
// Bybit no expone el desglose comprador/vendedor en las velas, así que el delta
// se construye a partir del stream de trades (`publicTrade.*`), donde el campo
// `S` es el lado del TAKER. delta = volumen agresor comprador - volumen agresor
// vendedor, medido en moneda de cotización (USD).
//
// Estructura: dos niveles de ring buffers por símbolo.
//   - fino:   cubos de 10 s durante 1 h  -> ventanas <= 1h con resolución de 10 s
//   - grueso: cubos de 60 s durante 24 h -> ventanas > 1h con resolución de 1 min
// Memoria: ~29 KB por símbolo (~17 MB con 600 perpetuos).

export const FINE_BUCKET_MS = 10_000;
export const COARSE_BUCKET_MS = 60_000;

// Ventana máxima servida por cada nivel.
export const FINE_WINDOW_MS = 60 * 60_000; // 1 h
export const MAX_WINDOW_MS = 24 * 60 * 60_000; // 24 h

// Los buffers llevan unos cubos de más: una ventana de N ms se lee como
// ceil(N / cubo) cubos cerrados + el cubo en curso, así siempre cubre al menos
// los N ms pedidos en lugar de quedarse corta al abrirse un cubo nuevo.
const SLACK_BUCKETS = 6;
export const FINE_SLOTS = FINE_WINDOW_MS / FINE_BUCKET_MS + SLACK_BUCKETS; // 366
export const COARSE_SLOTS = MAX_WINDOW_MS / COARSE_BUCKET_MS + SLACK_BUCKETS; // 1446

export const FINE_SPAN_MS = FINE_BUCKET_MS * FINE_SLOTS;
export const COARSE_SPAN_MS = COARSE_BUCKET_MS * COARSE_SLOTS;

/**
 * Recorre hacia atrás un ring buffer sumando compras/ventas y anota el
 * acumulado en cada corte pedido. Una sola pasada sirve para todos los
 * timeframes de ese nivel.
 *
 * @param {number[]} needs cantidades de cubos, en orden ascendente
 * @param {number[]} slots destino de cada `needs[i]` dentro de `out`
 */
function scanBackwards(buy, sell, headId, slotCount, needs, targets, out) {
  const maxNeed = needs[needs.length - 1];
  let b = 0;
  let s = 0;
  let k = 0;
  for (let i = 0; i < maxNeed; i++) {
    const idx = (((headId - i) % slotCount) + slotCount) % slotCount;
    b += buy[idx];
    s += sell[idx];
    const consumed = i + 1;
    while (k < needs.length && needs[k] === consumed) {
      out[targets[k]] = { buy: b, sell: s, delta: b - s, total: b + s };
      k++;
    }
  }
  while (k < needs.length) {
    out[targets[k]] = { buy: b, sell: s, delta: b - s, total: b + s };
    k++;
  }
}

export class VolumeStore {
  constructor(now = Date.now()) {
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.fineId = Math.floor(now / FINE_BUCKET_MS);
    this.coarseId = Math.floor(now / COARSE_BUCKET_MS);
    // Momento desde el que hay datos: se conserva al restaurar un snapshot.
    this.startedAt = now;
    this.trades = 0;
    this.droppedTrades = 0;
  }

  get size() {
    return this.entries.size;
  }

  ensure(symbol, now = Date.now()) {
    let entry = this.entries.get(symbol);
    if (entry === undefined) {
      entry = {
        symbol,
        fineBuy: new Float64Array(FINE_SLOTS),
        fineSell: new Float64Array(FINE_SLOTS),
        coarseBuy: new Float64Array(COARSE_SLOTS),
        coarseSell: new Float64Array(COARSE_SLOTS),
        since: now,
        lastTradeMs: 0,
        trades: 0,
      };
      this.entries.set(symbol, entry);
    }
    return entry;
  }

  /** Avanza el reloj de cubos y limpia los que entran en la ventana. */
  advance(now = Date.now()) {
    const fineId = Math.floor(now / FINE_BUCKET_MS);
    if (fineId > this.fineId) {
      const steps = Math.min(fineId - this.fineId, FINE_SLOTS);
      const from = fineId - steps;
      for (const entry of this.entries.values()) {
        for (let k = 1; k <= steps; k++) {
          const idx = (from + k) % FINE_SLOTS;
          entry.fineBuy[idx] = 0;
          entry.fineSell[idx] = 0;
        }
      }
      this.fineId = fineId;
    }
    const coarseId = Math.floor(now / COARSE_BUCKET_MS);
    if (coarseId > this.coarseId) {
      const steps = Math.min(coarseId - this.coarseId, COARSE_SLOTS);
      const from = coarseId - steps;
      for (const entry of this.entries.values()) {
        for (let k = 1; k <= steps; k++) {
          const idx = (from + k) % COARSE_SLOTS;
          entry.coarseBuy[idx] = 0;
          entry.coarseSell[idx] = 0;
        }
      }
      this.coarseId = coarseId;
    }
  }

  /**
   * @param {string} symbol
   * @param {number} tsMs marca de tiempo del trade (ms)
   * @param {number} quoteVolume tamaño del trade en USD (precio * cantidad)
   * @param {boolean} isBuy true si el taker compró
   */
  addTrade(symbol, tsMs, quoteVolume, isBuy, now = Date.now()) {
    if (!Number.isFinite(quoteVolume) || quoteVolume <= 0) {
      this.droppedTrades++;
      return false;
    }
    // Un reloj adelantado del exchange no debe abrir cubos futuros.
    const ts = Number.isFinite(tsMs) && tsMs > 0 ? Math.min(tsMs, now) : now;
    this.advance(now);

    const entry = this.ensure(symbol, now);
    entry.trades++;
    this.trades++;
    if (ts > entry.lastTradeMs) entry.lastTradeMs = ts;

    let stored = false;
    const fineId = Math.floor(ts / FINE_BUCKET_MS);
    if (fineId > this.fineId - FINE_SLOTS) {
      const idx = (((fineId % FINE_SLOTS) + FINE_SLOTS) % FINE_SLOTS);
      if (isBuy) entry.fineBuy[idx] += quoteVolume;
      else entry.fineSell[idx] += quoteVolume;
      stored = true;
    }
    const coarseId = Math.floor(ts / COARSE_BUCKET_MS);
    if (coarseId > this.coarseId - COARSE_SLOTS) {
      const idx = (((coarseId % COARSE_SLOTS) + COARSE_SLOTS) % COARSE_SLOTS);
      if (isBuy) entry.coarseBuy[idx] += quoteVolume;
      else entry.coarseSell[idx] += quoteVolume;
      stored = true;
    }
    if (!stored) this.droppedTrades++;
    return stored;
  }

  /**
   * Lee varias ventanas de un símbolo en una sola pasada por nivel.
   * @param {object|string} symbolOrEntry
   * @param {number[]} windowsMs duraciones en ms
   * @returns {Array<{buy:number,sell:number,delta:number,total:number}>}
   */
  read(symbolOrEntry, windowsMs) {
    const entry =
      typeof symbolOrEntry === 'string' ? this.entries.get(symbolOrEntry) : symbolOrEntry;
    const out = new Array(windowsMs.length);
    if (!entry) {
      for (let i = 0; i < windowsMs.length; i++) out[i] = { buy: 0, sell: 0, delta: 0, total: 0 };
      return out;
    }

    const fineNeeds = [];
    const fineTargets = [];
    const coarseNeeds = [];
    const coarseTargets = [];
    for (let i = 0; i < windowsMs.length; i++) {
      const ms = Math.max(1, Math.min(windowsMs[i], MAX_WINDOW_MS));
      if (ms <= FINE_WINDOW_MS) {
        fineNeeds.push(Math.min(Math.ceil(ms / FINE_BUCKET_MS) + 1, FINE_SLOTS));
        fineTargets.push(i);
      } else {
        coarseNeeds.push(Math.min(Math.ceil(ms / COARSE_BUCKET_MS) + 1, COARSE_SLOTS));
        coarseTargets.push(i);
      }
    }
    sortNeeds(fineNeeds, fineTargets);
    sortNeeds(coarseNeeds, coarseTargets);

    if (fineNeeds.length > 0) {
      scanBackwards(entry.fineBuy, entry.fineSell, this.fineId, FINE_SLOTS, fineNeeds, fineTargets, out);
    }
    if (coarseNeeds.length > 0) {
      scanBackwards(
        entry.coarseBuy,
        entry.coarseSell,
        this.coarseId,
        COARSE_SLOTS,
        coarseNeeds,
        coarseTargets,
        out,
      );
    }
    return out;
  }

  /** Milisegundos de historial realmente acumulados para un símbolo. */
  coverageMs(symbol, now = Date.now()) {
    const entry = this.entries.get(symbol);
    const since = entry ? Math.max(entry.since, this.startedAt) : now;
    return Math.max(0, Math.min(now - since, MAX_WINDOW_MS));
  }
}

/** Ordena `needs` ascendente arrastrando `targets` (arrays pequeños). */
function sortNeeds(needs, targets) {
  for (let i = 1; i < needs.length; i++) {
    const need = needs[i];
    const target = targets[i];
    let j = i - 1;
    while (j >= 0 && needs[j] > need) {
      needs[j + 1] = needs[j];
      targets[j + 1] = targets[j];
      j--;
    }
    needs[j + 1] = need;
    targets[j + 1] = target;
  }
}
