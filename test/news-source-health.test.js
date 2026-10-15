const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');

async function query(fixtures, endpoint = '../api/news-catalysts') {
  const original = https.get;
  const calls = [];
  https.get = (url, options, callback) => {
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
