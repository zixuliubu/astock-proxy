const test = require('node:test');
const assert = require('node:assert/strict');
const stockFlow = require('../api/stock-capital-flow');
const sectorFlow = require('../api/sector-money-flow');
const dragonTiger = require('../api/dragon-tiger');
const quote = require('../api/quote');

test('stock-capital-flow parser preserves Eastmoney yuan fields', () => {
  const row = stockFlow.parseFlowLine('14:55,120000000,-1,2,50000000,70000000', 'minute');
  assert.equal(row.mainNetYuan, 120000000);
  assert.equal(row.mainNetWan, 12000);
  assert.equal(stockFlow.summarize([row]).totalMainYi, 1.2);
});

test('sector adapter maps AKShare-verified amount fields', () => {
  const row = sectorFlow.normalize({
    f12: 'BK1036',
    f14: '半导体',
    f3: 2.5,
    f6: 83000000000,
    f62: 1230000000,
    f66: 800000000,
    f72: 430000000,
    f78: -100000000,
    f84: -1130000000,
    f184: 1.48,
  }, 'industry', 'fixture');
  assert.equal(row.name, '半导体');
  assert.equal(row.amountYi, 830);
  assert.equal(row.mainNetYi, 12.3);
  assert.deepEqual(row.missingFields, []);
});

test('dragon-tiger adapter uses BILLBOARD amount fields', () => {
  const row = dragonTiger.normalize({
    TRADE_DATE: '2026-07-28',
    SECURITY_CODE: '001258',
    SECURITY_NAME_ABBR: '立新能源',
    CLOSE_PRICE: 12.9,
    CHANGE_RATE: -9.9791,
    EXPLANATION: '日振幅值达到15%',
    BILLBOARD_BUY_AMT: 124961123.13,
    BILLBOARD_SELL_AMT: 286269863.01,
    BILLBOARD_NET_AMT: -161308739.88,
    BILLBOARD_DEAL_AMT: 411230986.14,
    ACCUM_AMOUNT: 2811246220,
    TURNOVERRATE: 20.6467,
  });
  assert.equal(row.buyAmount, 124961123.13);
  assert.equal(row.sellAmount, 286269863.01);
  assert.equal(row.amount, 411230986.14);
});

test('quote reconciliation joins by stock code and keeps Chinese names', () => {
  const rows = quote.mergeQuotes(
    [{ code: 'sz001258', name: '立新能源', price: 8.01, source: 'sina' }],
    [{ code: '001258', name: '立新能源', price: 8.02, source: 'tencent' }],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '001258');
  assert.equal(rows[0].name, '立新能源');
  assert.equal(rows[0].price, 8.02);
});
