import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDailyKlines } from '../public/js/core/bybit-rest.js';
import { KLINE_INTERVAL, KLINE_LIMIT } from '../public/js/core/combos.js';

test('pide velas diarias con el límite definido en combos.js y las ordena viejas→nuevas', async () => {
  let pedido;
  const fetchImpl = async (url) => {
    pedido = url;
    // Forma real de Bybit v5: de la más nueva a la más vieja, todo en strings.
    const list = [
      ['1757980800000', '3', '3', '3', '103.5', '1', '1'],
      ['1757894400000', '2', '2', '2', '102.25', '1', '1'],
      ['1757808000000', '1', '1', '1', '101', '1', '1'],
    ];
    return { ok: true, json: async () => ({ retCode: 0, retMsg: 'OK', result: { list } }) };
  };
  const velas = await fetchDailyKlines({ restUrl: 'https://api.bybit.com' }, 'linear', 'BTCUSDT', { fetchImpl });

  assert.equal(pedido.pathname, '/v5/market/kline');
  assert.equal(pedido.searchParams.get('interval'), KLINE_INTERVAL);
  assert.equal(pedido.searchParams.get('interval'), 'D');
  assert.equal(Number(pedido.searchParams.get('limit')), KLINE_LIMIT);
  assert.equal(pedido.searchParams.get('symbol'), 'BTCUSDT');
  assert.deepEqual(velas.map((v) => v.close), [101, 102.25, 103.5]);
  assert.deepEqual(velas.map((v) => v.start), [1757808000000, 1757894400000, 1757980800000]);
});
