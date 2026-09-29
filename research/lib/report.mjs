// Informe en Markdown y CSV del estudio de subidas.

import { FEATURES } from './analysis.mjs';

const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function fmtFeature(name, v) {
  if (!Number.isFinite(v)) return '—';
  if (name === 'funding') return `${(v * 100).toFixed(3)}%`;
  if (name === 'ls_buy') return `${(v * 100).toFixed(0)}%`;
  if (name === 'ls_24h') return `${(v * 100).toFixed(1)} pp`;
  if (name.endsWith('_x')) return `${v.toFixed(1)}×`;
  return pct(v);
}

export function renderReport({ params, coverage, evaluation, featureStats, episodes }) {
  const L = [];
  L.push('# Estudio: ¿qué muestran los perpetuos de Bybit antes de subir +' + pct(params.threshold, 0) + '?');
  L.push('');
  L.push(`Generado ${iso(Date.now())} UTC con datos de ${params.restUrl}.`);
  L.push('');
  L.push('## Parámetros y cobertura');
  L.push('');
  L.push(`- Período estudiado: ${iso(params.studyStart)} → ${iso(params.endMs)} UTC (${params.days} días), dividido en dos mitades en ${iso(params.splitMs)}.`);
  L.push(`- "Subida": desde el cierre de una hora, el máximo de las ${params.horizon} h siguientes llega a +${pct(params.threshold, 0)}.`);
  L.push(`- Pares: ${coverage.symbols} con datos (${coverage.failed} fallaron). Horas evaluadas: ${evaluation.hours.toLocaleString('es')}.`);
  L.push(`- Episodios de subida: **${evaluation.episodes}**. Tasa base: **${pct(evaluation.baseRate.all, 3)}** de las horas (1ª mitad ${pct(evaluation.baseRate.first, 3)}, 2ª mitad ${pct(evaluation.baseRate.second, 3)}).`);
  L.push(`- Cobertura de datos por hora evaluada: OI ${pct(coverage.oi)}, funding ${pct(coverage.funding)}, ratio long/short ${pct(coverage.ls)}.`);
  L.push('');

  L.push('## ¿Qué rasgo separa las subidas del resto? (AUC)');
  L.push('');
  L.push('AUC = probabilidad de que la hora en que *empieza* una subida tenga un valor más alto que una hora cualquiera sin subida. 0,50 = no distingue nada; >0,50, valores altos anticipan subida; <0,50, valores bajos.');
  L.push('');
  L.push('| Rasgo | AUC | Mediana al empezar la subida | Mediana en horas normales | Qué mide |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const [name, desc] of FEATURES) {
    const s = featureStats[name];
    L.push(`| ${name} | ${num(s.auc)} | ${fmtFeature(name, s.medianPos)} | ${fmtFeature(name, s.medianNeg)} | ${desc} |`);
  }
  L.push('');

  L.push('## Señales: ¿cuántas veces acierta cada una?');
  L.push('');
  L.push('- **Precisión**: de las horas en que la señal estaba encendida, cuántas terminaron en subida de +' + pct(params.threshold, 0) + ' en ' + params.horizon + ' h. **Lift** = precisión ÷ tasa base.');
  L.push('- **Entradas**: una por par cada ' + params.horizon + ' h como máximo (lo que haría un operador). Retorno y caída máxima al cierre de esas ' + params.horizon + ' h, sin comisiones ni deslizamiento.');
  L.push('- **Atrapa**: % de subidas en las que la señal se encendió mientras todavía se podía entrar. **Avisa antes**: se encendió en las 24 h previas.');
  L.push('- Si la precisión de la 1ª y la 2ª mitad difieren mucho, la señal no es estable: desconfiar.');
  L.push('');
  L.push('| Señal | Horas | Precisión | Lift | Prec. 1ª / 2ª mitad | Entradas | Entradas que tocaron +' + pct(params.threshold, 0) + ' | Retorno mediano ' + params.horizon + 'h | Caída máx. mediana | Atrapa | Avisa antes |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const rules = [...evaluation.rules].sort((a, b) => (b.all.lift || 0) - (a.all.lift || 0));
  for (const r of rules) {
    L.push(`| ${r.desc} | ${r.all.hours.toLocaleString('es')} | ${pct(r.all.precision, 2)} | ${Number.isFinite(r.all.lift) ? `${num(r.all.lift, 1)}×` : '—'} | ${pct(r.first.precision, 2)} / ${pct(r.second.precision, 2)} | ${r.all.trades.toLocaleString('es')} | ${pct(r.all.tradePrecision, 1)} | ${pct(r.all.medianRet)} | ${pct(r.all.medianMaxDrawdown)} | ${pct(r.catchRate, 0)} | ${pct(r.earlyRate, 0)} |`);
  }
  L.push('');

  L.push('## Las subidas, una por una');
  L.push('');
  L.push('Rasgos 24 h antes, 6 h antes y en la primera hora desde la que se podía entrar y ganar +' + pct(params.threshold, 0) + '.');
  L.push('');
  const cols = ['ret_24h', 'vol_1h_x', 'oi_24h', 'funding', 'ls_buy'];
  L.push('| Par | Inicio (UTC) | Máx. en ' + params.horizon + 'h | ' + cols.map((c) => `${c} (−24h / −6h / 0)`).join(' | ') + ' |');
  L.push('| --- | --- | --- | ' + cols.map(() => '---').join(' | ') + ' |');
  const sorted = [...episodes].sort((a, b) => b.maxGain - a.maxGain);
  for (const ep of sorted.slice(0, 200)) {
    const cells = cols.map((c) => [ep.at24[c], ep.at6[c], ep.at0[c]].map((v) => fmtFeature(c, v)).join(' / '));
    L.push(`| ${ep.symbol} | ${iso(ep.startMs)} | ${pct(ep.maxGain, 0)} | ${cells.join(' | ')} |`);
  }
  if (sorted.length > 200) L.push(`\n…y ${sorted.length - 200} más en episodes.csv.`);
  L.push('');

  L.push('## Límites de este estudio');
  L.push('');
  L.push('- Solo pares que hoy siguen listados en Bybit: los que se deslistaron después de subir y derrumbarse no están (sesgo de supervivencia).');
  L.push('- No hay historia pública de liquidaciones en Bybit (solo en tiempo real), ni volumen comprador/vendedor por hora: el delta de volumen y las liquidaciones no entran aquí.');
  L.push('- OI y ratio long/short se usan con 1 h de retraso para no mirar el futuro.');
  L.push('- Se prueban varias señales a la vez: alguna puede verse bien por azar. Por eso la comparación entre mitades.');
  L.push('- Retornos sin comisiones, funding pagado, deslizamiento ni liquidación de la propia posición.');
  L.push('');
  return L.join('\n');
}

export function episodesCsv(episodes) {
  const names = FEATURES.map(([n]) => n);
  const head = ['symbol', 'start_utc', 'max_gain', 'max_drawdown', 'ret_horizon',
    ...['24h', '6h', '0h'].flatMap((w) => names.map((n) => `${n}_${w}`))];
  const rows = episodes.map((ep) => [
    ep.symbol, new Date(ep.startMs).toISOString(), ep.maxGain, ep.maxDrawdown, ep.retH,
    ...[ep.at24, ep.at6, ep.at0].flatMap((at) => names.map((n) => at[n])),
  ].map((v) => (typeof v === 'number' && !Number.isFinite(v) ? '' : v)).join(','));
  return [head.join(','), ...rows].join('\n') + '\n';
}
