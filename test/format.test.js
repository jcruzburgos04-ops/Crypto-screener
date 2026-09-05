import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtPrice, fmtPct, fmtDuration, parseAmount } from '../public/js/format.js';

test('fmtUsd usa sufijos compactos como en un screener', () => {
  assert.equal(fmtUsd(16_800_000_000), '$16.8b');
  assert.equal(fmtUsd(3_650_000_000), '$3.65b');
  assert.equal(fmtUsd(797_380_000), '$797.38m');
  assert.equal(fmtUsd(3_100_000), '$3.1m');
  assert.equal(fmtUsd(2_050_000), '$2.05m');
  assert.equal(fmtUsd(937_390), '$937.39k');
  assert.equal(fmtUsd(43_810), '$43.81k');
  assert.equal(fmtUsd(812), '$812');
});

test('fmtUsd marca los negativos con el signo delante del símbolo', () => {
  assert.equal(fmtUsd(-283_400), '-$283.4k');
  assert.equal(fmtUsd(-2_740_000), '-$2.74m');
  assert.equal(fmtUsd(0), '$0');
  assert.equal(fmtUsd(NaN), '—');
});

test('fmtPrice respeta los decimales del exchange', () => {
  assert.equal(fmtPrice('2452.83'), '$2,452.83');
  assert.equal(fmtPrice('0.04867'), '$0.04867');
  assert.equal(fmtPrice('0.000007183'), '$0.000007183');
  assert.equal(fmtPrice('84.934'), '$84.934');
  assert.equal(fmtPrice(''), '—');
});

test('fmtPct convierte la fracción de Bybit a porcentaje', () => {
  assert.equal(fmtPct(-0.0283), '-2.83%');
  assert.equal(fmtPct(0.2827), '28.27%');
  assert.equal(fmtPct(0.0008), '0.08%');
});

test('fmtDuration resume la cobertura acumulada', () => {
  assert.equal(fmtDuration(5_400_000), '1h 30m');
  assert.equal(fmtDuration(3_600_000), '1h');
  assert.equal(fmtDuration(120_000), '2m');
  assert.equal(fmtDuration(15_000), '15s');
});

test('parseAmount entiende los atajos k/m/b', () => {
  assert.equal(parseAmount('500k'), 500_000);
  assert.equal(parseAmount('1.5m'), 1_500_000);
  assert.equal(parseAmount('2B'), 2e9);
  assert.equal(parseAmount('$1,000'), 1000);
  assert.equal(parseAmount(''), 0);
  assert.ok(Number.isNaN(parseAmount('abc')));
});
