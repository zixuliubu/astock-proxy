const test = require('node:test');
const assert = require('node:assert/strict');
const orderbook = require('../api/orderbook-lite');
const watchlistOrderbook = require('../api/watchlist-orderbook');

function response(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
    text: async () => text,
  };
}

function sinaLine(code, { askEmpty = false, bidEmpty = false, limitUp = false, limitDown = false } = {}) {
  const fields = Array(32).fill('');
  fields[0] = 'Sina Fixture';
  fields[1] = '10';
  fields[2] = limitUp ? '9.27' : limitDown ? '10.89' : '9.8';
  fields[3] = limitUp ? '10.2' : limitDown ? '9.8' : '10.2';
  fields[4] = limitUp ? '10.2' : '10.3';
  fields[5] = limitDown ? '9.8' : '9.7';
  fields[8] = '100000';
  fields[9] = '1000000';
  for (let index = 0; index < 5; index += 1) {
    fields[10 + index * 2] = bidEmpty ? '0' : String(1000 - index * 10);
    fields[11 + index * 2] = bidEmpty ? '0' : String(10.19 - index * 0.01);
    fields[20 + index * 2] = askEmpty ? '0' : String(500 + index * 10);
    fields[21 + index * 2] = askEmpty ? '0' : String(10.21 + index * 0.01);
  }
  fields[30] = '2026-08-14';
  fields[31] = '14:30:00';
  return `var hq_str_sz${code}="${fields.join(',')}";`;
}

function tencentLine(code) {
  const fields = Array(50).fill('');
  fields[1] = 'Tencent Fixture';
  fields[2] = code;
  fields[3] = '10.2';
  fields[4] = '9.8';
  fields[5] = '10';
  fields[6] = '100000';
  for (let index = 0; index < 5; index += 1) {
    fields[9 + index * 2] = String(10.19 - index * 0.01);
    fields[10 + index * 2] = String(1200 - index * 10);
    fields[19 + index * 2] = String(10.21 + index * 0.01);
    fields[20 + index * 2] = String(600 + index * 10);
  }
  fields[30] = '20260814143000';
  fields[33] = '10.3';
  fields[34] = '9.7';
  fields[37] = '100';
  return `v_sz${code}="${fields.join('~')}";`;
}

async function call(handler, query) {
  let body = '';
  const res = {
    setHeader() {},
    end(value) { body = value; },
  };
  await handler({ method: 'GET', query }, res);
  return JSON.parse(body);
}

function resetCache() {
  global.__ASTOCK_EXTRA_CACHE__.clear();
}

test('primary Sina depth succeeds without a Tencent fallback', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    assert.match(String(url), /hq\.sinajs\.cn/);
    return response(200, sinaLine('300404'));
  };
  try {
    resetCache();
    const result = await call(orderbook, { symbols: '300404' });
    assert.equal(result.success, true);
    assert.equal(result.selectedProvider, 'sina');
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.dataQuality, 'REALTIME_DEPTH');
    assert.equal(result.providerAttempts.length, 1);
    assert.equal(result.data[0].marketState, 'NORMAL');
    assert.notEqual(result.data[0].strength.label, '盘口深度不完整');
    assert.equal(Number.isFinite(result.data[0].strength.score), true);
    assert.notEqual(result.data[0].spread, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sina abort error falls back to verified Tencent five-level depth', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    if (String(url).includes('hq.sinajs.cn')) {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    return response(200, tencentLine('300404'));
  };
  try {
    resetCache();
    const result = await call(orderbook, { symbols: '300404', compare: 'true' });
    assert.equal(result.success, true);
    assert.equal(result.selectedProvider, 'tencent');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.providerAttempts[0].status, 'timeout');
    assert.equal(result.providerAttempts[1].status, 'ok');
    assert.equal(result.data[0].bid.length, 5);
    assert.equal(result.data[0].ask.length, 5);
    assert.equal(result.data[0].quoteTime, '20260814143000');
  } finally {
    global.fetch = originalFetch;
  }
});

test('all depth sources fail closed and the failed result does not poison a later successful cache entry', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  let fail = true;
  global.fetch = async url => {
    calls += 1;
    if (!fail) return response(200, sinaLine('300404'));
    throw new Error('upstream unavailable');
  };
  try {
    resetCache();
    const first = await call(orderbook, { symbols: '300404' });
    fail = false;
    const second = await call(orderbook, { symbols: '300404' });
    assert.equal(first.success, false);
    assert.equal(first.status, 'DATA_INSUFFICIENT');
    assert.deepEqual(first.data, []);
    assert.equal(first.dataQuality, 'DATA_INSUFFICIENT');
    assert.equal(first.providerAttempts.length, 2);
    assert.equal(second.success, true);
    assert.equal(second.cacheHit, false);
    assert.equal(calls, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('limit-up empty asks retains seal facts but suppresses two-sided strength semantics', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => response(200, sinaLine('600000', { askEmpty: true, limitUp: true }));
  try {
    resetCache();
    const result = await call(orderbook, { symbols: '600000' });
    assert.equal(result.success, true);
    assert.equal(result.dataQuality, 'PARTIAL_DEPTH');
    assert.ok(result.data[0].bid.some(level => level.price > 0));
    assert.equal(result.data[0].askTotal, 0);
    assert.equal(result.data[0].spread, null);
    assert.equal(result.data[0].pressureRatio, null);
    assert.equal(result.data[0].strength.score, null);
    assert.equal(result.data[0].strength.label, '盘口深度不完整');
    assert.equal(result.data[0].marketState, 'LIMIT_UP_ONE_SIDED');
  } finally {
    global.fetch = originalFetch;
  }
});

test('limit-down empty bids remains real but suppresses two-sided strength semantics', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => response(200, sinaLine('600000', { bidEmpty: true, limitDown: true }));
  try {
    resetCache();
    const result = await call(orderbook, { symbols: '600000' });
    assert.equal(result.success, true);
    assert.equal(result.dataQuality, 'PARTIAL_DEPTH');
    assert.ok(result.data[0].ask.some(level => level.price > 0));
    assert.equal(result.data[0].spread, null);
    assert.equal(result.data[0].pressureRatio, null);
    assert.equal(result.data[0].strength.score, null);
    assert.equal(result.data[0].strength.label, '盘口深度不完整');
    assert.equal(result.data[0].marketState, 'LIMIT_DOWN_ONE_SIDED');
  } finally {
    global.fetch = originalFetch;
  }
});

test('watchlist transparently reports an upstream depth shortage without trading support', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => response(503, 'unavailable');
  try {
    resetCache();
    const result = await call(watchlistOrderbook, { symbols: '300404' });
    assert.equal(result.orderbookSuccess, false);
    assert.equal(result.dataQuality, 'DATA_INSUFFICIENT');
    assert.equal(result.tradePermissionSupport, false);
    assert.equal(result.summary.tradePermissionSupport, false);
    assert.match(result.summary.conclusion, /盘口数据不足/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('watchlist does not treat a one-sided book as real-depth trading support', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => response(200, sinaLine('300404', { askEmpty: true }));
  try {
    resetCache();
    const result = await call(watchlistOrderbook, { symbols: '300404' });
    assert.equal(result.orderbookSuccess, true);
    assert.equal(result.dataQuality, 'PARTIAL_DEPTH');
    assert.equal(result.tradePermissionSupport, false);
    assert.deepEqual(result.summary.strongest, []);
    assert.deepEqual(result.summary.weakest, []);
    assert.match(result.summary.conclusion, /盘口深度不完整/);
  } finally {
    global.fetch = originalFetch;
  }
});
