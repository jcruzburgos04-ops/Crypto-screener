// EMA con la semántica exacta de ta.ema de Pine:
//   - las primeras N-1 posiciones son NaN (no se rellenan);
//   - la posición N-1 es la SMA de los primeros N valores (la semilla);
//   - desde ahí, p = a*x + (1-a)*p con a = 2/(N+1).
// NO es ewm() de pandas (ni adjust=True ni adjust=False): esas siembran con el
// primer valor y producen números desde la primera vela.
//
// No hay otra EMA en el proyecto; si algún día un indicador necesita otra
// variante, que sea una función aparte y no un cambio a esta.

/** Serie completa. Devuelve un Float64Array del mismo largo que `values`. */
export function pineEma(values, length) {
  if (!Number.isInteger(length) || length < 1) throw new RangeError(`longitud inválida: ${length}`);
  const out = new Float64Array(values.length).fill(NaN);
  if (values.length < length) return out;
  const alpha = 2 / (length + 1);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[i];
  let prev = sum / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Estado de la EMA sobre las velas CERRADAS, para poder calcular la vela en
 * curso en O(1) cada vez que cambia el precio, con el mismo resultado que
 * pineEma(cerradas + [vivo]).at(-1).
 */
export function pineEmaState(closed, length) {
  const series = pineEma(closed, length);
  let sum = 0;
  for (let i = 0; i < closed.length; i++) sum += closed[i];
  return {
    length,
    count: closed.length,
    sum, // solo se usa cuando la vela en curso completa la semilla
    last: closed.length > 0 ? series[closed.length - 1] : NaN,
  };
}

/** Valor de la EMA en la vela en curso. null si con esa vela aún no imprime. */
export function pineEmaLive(state, livePrice) {
  const { length, count, sum, last } = state;
  if (!Number.isFinite(livePrice)) return null; // sin vela en curso no hay valor de hoy
  const total = count + 1;
  if (total < length) return null;
  if (total === length) return (sum + livePrice) / length; // la semilla incluye la vela en curso
  const alpha = 2 / (length + 1);
  return alpha * livePrice + (1 - alpha) * last;
}
