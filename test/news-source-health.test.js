const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');

async function query(fixtures, endpoint = '../api/news-catalysts', verifyRequests) {
  const original = https.get;
  const calls = [];
  const urls = [];
  https.get = (url, options, callback) => {
    urls.push(new URL(url));
    calls.push(url.includes('eastmoney') ? 'eastmoney' : 'cls');
    const fixture = fixtures[calls.at(-1)];
    const request = new EventEmitter();
    request.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = fixture.status || 200;
      response.headers = { 'content-type': fixture.type || 'application/json' };
      callback(response);
      response.emit('data', fixture.body ?? JSON.stringify(fixture.payload));
      response.emit('end');
    });
    return request;
  };
  let result;
  const response = { setHeader() {}, status() { return this; }, json(value) { result = value; } };
  try {
    await require(endpoint)({ method: 'GET', query: {} }, response);
  } finally {
    https.get = original;
  }
  assert.equal(calls.length, 2, 'exactly the existing two source calls; no retry');
  if (verifyRequests) verifyRequests(urls);
  return result;
}

const emEmpty = { payload: { data: { fastNewsList: [] } } };
const clsEmpty = { payload: { data: { roll_data: [] } } };
const html = { type: 'text/html', body: '<html>private-upstream-body</html>' };

test('saved incident: HTML failure plus legitimate empty source is PARTIAL, not no-news', async () => {
  const result = await query({ eastmoney: emEmpty, cls: html });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.confirmedEmpty, false);
  assert.equal(result.sourceDiagnostics.cls.error.code, 'UPSTREAM_NON_JSON');
  assert.equal(result.sourceDiagnostics.eastmoney.status, 'EMPTY');
  assert.doesNotMatch(JSON.stringify(result), /private-upstream-body|<html>/);
});

test('both failures are FAILED with unknown count', async () => {
  const result = await query({ eastmoney: html, cls: html });
  assert.equal(result.success, false);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.count, null);
  assert.equal(result.confirmedEmpty, false);
});

test('recognized empty arrays from both sources are confirmed empty', async () => {
  const result = await query({ eastmoney: emEmpty, cls: clsEmpty });
  assert.equal(result.status, 'EMPTY');
  assert.equal(result.count, 0);
  assert.equal(result.confirmedEmpty, true);
});

test('unknown shape is not silently converted to a successful empty source', async () => {
  const result = await query({ eastmoney: { payload: {} }, cls: clsEmpty });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.sourceDiagnostics.eastmoney.error.code, 'UPSTREAM_SHAPE_INVALID');
});

test('HTTP failure preserves status and suppresses body', async () => {
  const result = await query({ eastmoney: { status: 503, payload: { secret: 'not-for-output' } }, cls: clsEmpty });
  assert.equal(result.sourceDiagnostics.eastmoney.error.httpStatus, 503);
  assert.equal(result.sourceDiagnostics.eastmoney.error.code, 'UPSTREAM_HTTP_FAILURE');
  assert.doesNotMatch(JSON.stringify(result), /not-for-output/);
});

test('partial usable items survive independently of another source failure', async () => {
  const result = await query({ eastmoney: { payload: { data: { fastNewsList: [{ title: 'fixture news' }] } } }, cls: html });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.count, 1);
  assert.equal(result.data[0].title, 'fixture news');
});

test('legacy extra news endpoint shares source-health semantics', async () => {
  const result = await query({ eastmoney: emEmpty, cls: html }, '../api/extra');
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.confirmedEmpty, false);
});

for (const endpoint of ['../api/news-catalysts', '../api/extra']) {
  for (const data of [[], { fastNewsList: [] }, { fastNewsList: [{ title: 'invalid business result' }] }]) {
    test(`explicit business failure cannot become confirmed empty: ${endpoint} ${JSON.stringify(data)}`, async () => {
      const result = await query({ eastmoney: { payload: { success: false, data } }, cls: clsEmpty }, endpoint);
      assert.equal(result.status, 'PARTIAL');
      assert.equal(result.confirmedEmpty, false);
      assert.equal(result.sourceDiagnostics.eastmoney.status, 'FAILED');
      assert.equal(result.sourceDiagnostics.eastmoney.error.code, 'UPSTREAM_BUSINESS_FAILURE');
      assert.doesNotMatch(JSON.stringify(result.data), /invalid business result/);
    });
  }
}

test('two explicit business failures are failed, even with recognizable empty data', async () => {
  const failure = { payload: { success: false, data: [], message: 'private business error' } };
  const result = await query({ eastmoney: failure, cls: failure });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.success, false);
  assert.equal(result.count, null);
  assert.equal(result.confirmedEmpty, false);
  assert.doesNotMatch(JSON.stringify(result), /private business error/);
});

test('explicit successful recognized empty containers remain confirmed empty', async () => {
  const result = await query({ eastmoney: { payload: { success: true, data: { fastNewsList: [] } } },
    cls: { payload: { success: true, data: { roll_data: [] } } } });
  assert.equal(result.status, 'EMPTY');
  assert.equal(result.confirmedEmpty, true);
});

for (const endpoint of ['../api/news-catalysts', '../api/extra']) {
  test(`current public website requests and response envelopes: ${endpoint}`, async () => {
    const result = await query({
      eastmoney: { payload: { code: '1', message: 'success', data: { fastNewsList: [
        { title: 'fixture eastmoney', summary: 'fixture summary', showTime: '2026-10-18 02:05:15' },
      ] } } },
      cls: { payload: { errno: 0, data: { roll_data: [
        { title: 'fixture cls', content: 'fixture content', ctime: 1792257504 },
      ] } } },
    }, endpoint, urls => {
      const [em, cls] = urls;
      assert.equal(em.origin + em.pathname, 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList');
      assert.equal(em.searchParams.get('sortEnd'), '');
      assert.match(em.searchParams.get('req_trace') || '', /^[0-9a-f-]{36}$/i);
      assert.equal(em.searchParams.get('pageSize'), '30');
      assert.equal(em.searchParams.get('fastColumn'), '102');
      assert.equal(cls.href, 'https://www.cls.cn/api/cache?name=telegraph');
    });
    assert.equal(result.status, 'OK');
    assert.equal(result.count, 2);
    assert.equal(result.sourceDiagnostics.eastmoney.status, 'OK');
    assert.equal(result.sourceDiagnostics.cls.status, 'OK');
    assert.equal(result.data[0].time, '2026-10-18 02:05:15');
    assert.equal(result.data[1].time, 1792257504);
  });

  for (const [source, failure] of [
    ['eastmoney', { code: 0, message: "Required String parameter 'sortEnd' is not present", data: { fastNewsList: [] } }],
    ['eastmoney', { code: '0', data: [{ title: 'must not escape failed envelope' }] }],
    ['cls', { errno: 500, data: { roll_data: [] } }],
    ['cls', { errno: 'unexpected', data: [{ title: 'must not escape failed envelope' }] }],
  ]) {
    test(`provider business failure overrides rows: ${endpoint} ${source} ${JSON.stringify(failure)}`, async () => {
      const result = await query({ eastmoney: emEmpty, cls: clsEmpty, [source]: { payload: failure } }, endpoint);
      assert.equal(result.status, 'PARTIAL');
      assert.equal(result.confirmedEmpty, false);
      assert.equal(result.sourceDiagnostics[source].error.code, 'UPSTREAM_BUSINESS_FAILURE');
      assert.doesNotMatch(JSON.stringify(result), /Required String|must not escape/);
    });
  }
}

test('verified provider success codes preserve confirmed empty semantics', async () => {
  const result = await query({ eastmoney: { payload: { code: '1', data: { fastNewsList: [] } } },
    cls: { payload: { errno: 0, data: { roll_data: [] } } } });
  assert.equal(result.status, 'EMPTY');
  assert.equal(result.confirmedEmpty, true);
});
