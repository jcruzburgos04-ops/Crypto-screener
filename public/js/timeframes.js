// Catálogo de timeframes compartido entre el servidor y el navegador.
// El servidor lo importa desde ../public/js/timeframes.js, el cliente lo carga
// como módulo ES: así nunca se desincronizan los ids.

export const TIMEFRAMES = [
  { id: '1m', ms: 60_000, label: '1m' },
  { id: '5m', ms: 5 * 60_000, label: '5m' },
  { id: '10m', ms: 10 * 60_000, label: '10m' },
  { id: '15m', ms: 15 * 60_000, label: '15m' },
  { id: '30m', ms: 30 * 60_000, label: '30m' },
  { id: '1h', ms: 60 * 60_000, label: '1h' },
  { id: '4h', ms: 4 * 60 * 60_000, label: '4h' },
  { id: '24h', ms: 24 * 60 * 60_000, label: '24h' },
];

export const TIMEFRAME_BY_ID = new Map(TIMEFRAMES.map((tf) => [tf.id, tf]));

export const DEFAULT_TIMEFRAMES = ['5m', '10m', '1h'];

/** Normaliza una lista de ids (query string, localStorage) a timeframes válidos. */
export function parseTimeframes(input, fallback = DEFAULT_TIMEFRAMES) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = String(item).trim();
    const tf = TIMEFRAME_BY_ID.get(id);
    if (tf && !seen.has(id)) {
      seen.add(id);
      out.push(tf);
    }
  }
  if (out.length === 0) return fallback.map((id) => TIMEFRAME_BY_ID.get(id));
  // Orden estable: siempre de menor a mayor ventana.
  out.sort((a, b) => a.ms - b.ms);
  return out;
}
