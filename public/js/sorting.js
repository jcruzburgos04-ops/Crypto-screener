// Comparación de valores de orden. Los vacíos (null) van siempre al final,
// en cualquier sentido: un símbolo sin dato no es "el más bajista".
export function compareSortValues(va, vb, dir) {
  const na = va === null || va === undefined;
  const nb = vb === null || vb === undefined;
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * dir;
  if (va === vb) return 0;
  return (va < vb ? -1 : 1) * dir;
}
