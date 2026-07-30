const test = require('node:test');
const assert = require('node:assert/strict');
const stockFlow = require('../api/stock-capital-flow');
const sectorFlow = require('../api/sector-money-flow');
const dragonTiger = require('../api/dragon-tiger');
const quote = require('../api/quote');
const watchlist = require('../api/watchlist');
const dragonTigerDetail = require('../api/dragon-tiger-detail');
const { reconcileTextRows } = require('../api/_stock-utils');

function mockResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

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

test('dragon-tiger adapter preserves missing amount fields as null', () => {
  const row = dragonTiger.normalize({
    TRADE_DATE: '2026-07-30',
    SECURITY_CODE: '000533',
    SECURITY_NAME_ABBR: '顺钠股份',
    BILLBOARD_BUY_AMT: null,
    BILLBOARD_SELL_AMT: 100,
    BILLBOARD_NET_AMT: null,
    BILLBOARD_DEAL_AMT: null,
  });
  assert.equal(row.buyAmount, null);
  assert.equal(row.amount, null);
  assert.deepEqual(row.missingAmountFields, ['buyAmount', 'netAmount', 'amount']);
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

test('sector flow sorts locally by the requested metric contract', async () => {
  const values = [
    { mainNetYi: -0.5 },
    { mainNetYi: 1.2 },
    { mainNetYi: 0.2 },
  ].sort((left, right) => right.mainNetYi - left.mainNetYi);
  assert.deepEqual(values.map(item => item.mainNetYi), [1.2, 0.2, -0.5]);
});

test('watchlist reuses decoded quote rows instead of parsing Sina as UTF-8', () => {
  const row = watchlist.toWatchRow({
    sources: ['sina', 'tencent'],
    code: '600584',
    name: '长电科技',
    open: 75,
    prevClose: 76,
    price: 77,
    high: 78,
    low: 74,
    volume: 100,
    amount: 100000000,
    time: '20260729111500',
  });
  assert.equal(row.name, '长电科技');
  assert.equal(row.code, 'sh600584');
  assert.equal(row.source, 'sina+tencent');
});

test('text reconciler replaces only corrupted upstream text with valid fallback', () => {
  const rows = reconcileTextRows(
    [{ code: '600693.SS', name: '东百���团', industry: '大消费' }],
    [{ code: '600693', name: '东百集团', industry: '零售' }],
  );
  assert.equal(rows[0].name, '东百集团');
  assert.equal(rows[0].industry, '大消费');
  assert.deepEqual(rows[0].textFallbackFields, ['name']);
});

test('sector flow falls back to AKShare-maintained numbered push2 hosts', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    const parsed = new URL(url);
    if (['push2.eastmoney.com', '79.push2.eastmoney.com'].includes(parsed.host)) {
      return mockResponse(502, {});
    }
    const kind = parsed.searchParams.get('fs').includes('t:2') ? 'industry' : 'concept';
    return mockResponse(200, {
      data: {
        diff: [{
          f12: kind === 'industry' ? 'BK1001' : 'BK2001',
          f14: kind === 'industry' ? '行业样本' : '概念样本',
          f3: 1.2,
          f6: 1000000000,
          f62: 10000000,
          f66: 6000000,
          f72: 4000000,
          f78: -2000000,
          f84: -8000000,
          f184: 1,
        }],
      },
    });
  };
  try {
    const result = await sectorFlow.fetchFlow('both', 10, 'mainNet');
    assert.equal(result.success, true);
    assert.deepEqual(result.availableKinds, ['industry', 'concept']);
    assert.equal(result.sources.industry, 'eastmoney_push2_17');
    assert.equal(result.sources.concept, 'eastmoney_push2_17');
  } finally {
    global.fetch = originalFetch;
  }
});

test('minute stock flow falls back without changing cumulative semantics', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    const parsed = new URL(url);
    if (['push2.eastmoney.com', '79.push2.eastmoney.com'].includes(parsed.host)) {
      return mockResponse(502, {});
    }
    return mockResponse(200, {
      data: {
        klines: [
          '2026-07-30 14:59,10000000,-1,2,4000000,6000000',
          '2026-07-30 15:00,12000000,-1,2,5000000,7000000',
        ],
      },
    });
  };
  try {
    const result = await stockFlow.fetchMinuteFlow('000533');
    assert.equal(result.source, 'eastmoney_push2_17');
    assert.equal(stockFlow.summarize(result.rows).latest.mainNetYuan, 12000000);
    assert.equal(stockFlow.summarize(result.rows).aggregation, 'latest_cumulative_point');
  } finally {
    global.fetch = originalFetch;
  }
});

test('dragon-tiger detail distinguishes verified not-on-list from an empty daily list', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => mockResponse(200, {
      result: {
        data: [{
          SECURITY_CODE: '001258',
          SECURITY_NAME_ABBR: '立新能源',
          TRADE_DATE: '2026-07-30',
          BILLBOARD_BUY_AMT: 100,
          BILLBOARD_SELL_AMT: 50,
          BILLBOARD_NET_AMT: 50,
          BILLBOARD_DEAL_AMT: 150,
        }],
      },
    });
    const verified = await dragonTigerDetail.fetchDragonTigerDetail({
      date: '20260730',
      symbol: '000533',
      deep: true,
    });
    assert.equal(verified.success, true);
    assert.equal(verified.status, 'not_on_list');
    assert.equal(verified.summary, null);

    global.fetch = async () => mockResponse(200, { result: { data: [] } });
    const unavailable = await dragonTigerDetail.fetchDragonTigerDetail({
      date: '20260730',
      symbol: '000533',
      deep: true,
    });
    assert.equal(unavailable.success, false);
    assert.equal(unavailable.status, 'fetch_error');
    assert.equal(unavailable.summary, null);
  } finally {
    global.fetch = originalFetch;
  }
});
