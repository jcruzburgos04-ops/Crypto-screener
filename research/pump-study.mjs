#!/usr/bin/env node
// Estudio de subidas de +50% en perpetuos de Bybit: qué mostraban antes.
//
//   node research/pump-study.mjs --days 180
//
// Descarga velas de 1h, open interest, funding y ratio long/short de cada par
// (con caché en disco), marca cada hora desde la que se podía ganar +50% en
// 24 h y compara los rasgos previos de esas horas contra todas las demás.
// Escribe research/out/report.md, episodes.csv y summary.json.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHistoryClient } from './lib/history.mjs';
import { buildFrame, computeFeatures, labelForward, findEpisodes, auc, median, FEATURES, HOUR_MS } from './lib/analysis.mjs';
import { createEvaluator, createReservoir } from './lib/signals.mjs';
import { renderReport, episodesCsv } from './lib/report.mjs';

function parseArgs(argv) {
  const opts = {
    days: 180, threshold: 0.5, horizon: 24, concurrency: 6, symbols: null, maxSymbols: 0,
    out: 'research/out', cache: 'research/cache', restUrl: 'https://api.bybit.com',
  };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].replace(/^--/, '').split('=');
    const value = inline ?? argv[i + 1];
    const take = () => { if (inline === undefined) i++; return value; };
    switch (key) {
      case 'days': opts.days = Number(take()); break;
      case 'threshold': opts.threshold = Number(take()); break;
      case 'horizon': opts.horizon = Number(take()); break;
      case 'concurrency': opts.concurrency = Number(take()); break;
      case 'symbols': opts.symbols = take().split(',').map((s) => s.trim()).filter(Boolean); break;
      case 'max-symbols': opts.maxSymbols = Number(take()); break;
      case 'out': opts.out = take(); break;
      case 'cache': opts.cache = take(); break;
      case 'no-cache': opts.cache = null; break;
      case 'rest': opts.restUrl = take(); break;
      default: throw new Error(`opción desconocida: --${key}`);
    }
  }
  return opts;
}

/** Corre el estudio completo. `fetchImpl` permite probarlo sin red. */
export async function runStudy(opts, { fetchImpl, now = Date.now(), log = console.log } = {}) {
  const endMs = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS; // última hora completa
  const studyStart = endMs - opts.days * 24 * HOUR_MS;
  const fetchStart = studyStart - 32 * 24 * HOUR_MS; // 32 días extra para los rasgos de 30 días
  const splitMs = studyStart + (endMs - studyStart) / 2;
  const client = createHistoryClient({ restUrl: opts.restUrl, fetchImpl, cacheDir: opts.cache ? resolve(opts.cache) : null });

  let symbols = opts.symbols ?? (await client.instruments()).map((x) => x.symbol).sort();
  if (opts.maxSymbols > 0) symbols = symbols.slice(0, opts.maxSymbols);
  log(`${symbols.length} pares, ${opts.days} días, subida = +${opts.threshold * 100}% en ${opts.horizon} h`);

  const evaluator = createEvaluator({ horizon: opts.horizon, splitMs });
  const positives = Object.fromEntries(FEATURES.map(([n]) => [n, []]));
  const negatives = Object.fromEntries(FEATURES.map(([n], k) => [n, createReservoir(200_000, 1000 + k)]));
  const episodes = [];
  const coverage = { symbols: 0, failed: 0, hours: 0, oi: 0, funding: 0, ls: 0 };

  let next = 0;
  let done = 0;
  async function worker() {
    while (next < symbols.length) {
      const symbol = symbols[next++];
      try {
        const [klines, oi, funding, ls] = await Promise.all([
          client.klines(symbol, fetchStart, endMs),
          client.openInterest(symbol, fetchStart, endMs),
          client.funding(symbol, fetchStart, endMs),
          client.longShort(symbol, fetchStart, endMs),
        ]);
        const frame = buildFrame({ klines, oi, funding, ls });
        if (!frame) continue;
        const features = computeFeatures(frame);
        const fwd = labelForward(frame, opts.horizon, opts.threshold);
        // Solo cuentan las horas dentro del período; lo anterior es calentamiento.
        for (let i = 0; i < frame.n; i++) if (frame.t0 + (i + 1) * HOUR_MS <= studyStart) fwd.label[i] = NaN;

        evaluator.add({ frame, features, fwd });
        coverage.symbols++;
        for (let i = 0; i < frame.n; i++) {
          if (fwd.label[i] !== 0 && fwd.label[i] !== 1) continue;
          coverage.hours++;
          if (Number.isFinite(frame.oi[i])) coverage.oi++;
          if (Number.isFinite(frame.fund[i])) coverage.funding++;
          if (Number.isFinite(frame.ls[i])) coverage.ls++;
          if (fwd.label[i] === 0) for (const [n] of FEATURES) if (Number.isFinite(features[n][i])) negatives[n].push(features[n][i]);
        }
        const at = (i) => Object.fromEntries(FEATURES.map(([n]) => [n, i >= 0 ? features[n][i] : NaN]));
        for (const ep of findEpisodes(fwd.label)) {
          for (const [n] of FEATURES) positives[n].push(features[n][ep.start]);
          episodes.push({
            symbol,
            startMs: frame.t0 + (ep.start + 1) * HOUR_MS, // cierre de la hora de entrada
            maxGain: fwd.maxGain[ep.start],
            maxDrawdown: fwd.maxDrawdown[ep.start],
            retH: fwd.retH[ep.start],
            at24: at(ep.start - 24), at6: at(ep.start - 6), at0: at(ep.start),
          });
        }
      } catch (err) {
        coverage.failed++;
        log(`  ${symbol}: ${err.message}`);
      }
      done++;
      if (done % 25 === 0 || done === symbols.length) log(`  ${done}/${symbols.length} pares procesados`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

  const evaluation = evaluator.result();
  const featureStats = Object.fromEntries(FEATURES.map(([n]) => [n, {
    auc: auc(positives[n], negatives[n].values),
    medianPos: median(positives[n]),
    medianNeg: median(negatives[n].values),
  }]));
  const hoursTotal = coverage.hours || NaN;
  const cov = { ...coverage, oi: coverage.oi / hoursTotal, funding: coverage.funding / hoursTotal, ls: coverage.ls / hoursTotal };
  const params = { ...opts, endMs, studyStart, splitMs };
  return { params, coverage: cov, evaluation, featureStats, episodes };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runStudy(opts);
  await mkdir(opts.out, { recursive: true });
  await writeFile(join(opts.out, 'report.md'), renderReport(result));
  await writeFile(join(opts.out, 'episodes.csv'), episodesCsv(result.episodes));
  await writeFile(join(opts.out, 'summary.json'), JSON.stringify({ ...result, episodes: undefined }, null, 2));
  console.log(`listo: ${join(opts.out, 'report.md')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
