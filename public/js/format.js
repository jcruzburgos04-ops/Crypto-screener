// Formateo de números al estilo de un screener: compacto, alineado y legible.
// Módulo ES puro (sin DOM) para poder testearlo desde Node.

const UNITS = [
  [1e12, 't'],
  [1e9, 'b'],
  [1e6, 'm'],
  [1e3, 'k'],
];

/** 16.80 -> "16.8", 2.05 -> "2.05", 937.39 -> "937.39" */
function trimZeros(text) {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** 16_800_000_000 -> "$16.8b", -283_400 -> "-$283.4k" */
export function fmtUsd(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  for (const [size, suffix] of UNITS) {
    if (abs >= size) return `${sign}$${trimZeros((abs / size).toFixed(2))}${suffix}`;
  }
  if (abs < 1) return `${sign}$${trimZeros(abs.toFixed(2))}`;
  if (abs < 100) return `${sign}$${trimZeros(abs.toFixed(2))}`;
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

/** Respeta los decimales que envía el exchange: "0.000007183" no se redondea. */
export function fmtPrice(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '—';
  const value = Number(text);
  if (!Number.isFinite(value)) return '—';
  const dot = text.indexOf('.');
  const decimals = Math.min(dot === -1 ? 0 : text.length - dot - 1, 12);
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** 0.0283 -> "2.83%" (la fracción que devuelve Bybit) */
export function fmtPct(fraction, decimals = 2) {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** Funding en puntos básicos, que es como se lee de un vistazo. */
export function fmtFunding(fraction) {
  if (!Number.isFinite(fraction) || fraction === 0) return '—';
  return `${(fraction * 100).toFixed(4)}%`;
}

/** 5_400_000 -> "1h 30m" */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/** Acepta "500k", "1.5m", "2b" o un número suelto. */
export function parseAmount(input) {
  const text = String(input ?? '').trim().toLowerCase().replace(/[$,\s]/g, '');
  if (text === '') return 0;
  const match = text.match(/^(-?\d*\.?\d+)([kmbt])?$/);
  if (!match) return NaN;
  const value = Number(match[1]);
  const factor = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2]] ?? 1;
  return value * factor;
}

/** Color estable por moneda: evita depender de logos externos. */
export function coinColor(base) {
  let hash = 0;
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 62% 52%)`;
}
