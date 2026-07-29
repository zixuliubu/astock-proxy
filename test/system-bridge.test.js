const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CAPTURE_SECRET = 'bridge-test-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';

const {
  SCHEMA_VERSION,
  httpStatusFor,
  validateEnvelope,
} = require('../api/_system-bridge');
const { preserveSystemBridgeFailure } = require('../api/mcp');

const NOW = new Date('2026-07-29T03:30:00.000Z');

function envelope(extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'radar_latest',
    producer: 'AI-Stock-System',
    status: 'OK',
    exportedAt: '2026-07-29T03:29:30.000Z',
    sourceUpdatedAt: '2026-07-29T03:29:00.000Z',
    sourceFiles: ['1129-112901.json'],
    diagnostics: { reasons: [] },
    data: {
      trade_date: '2026-07-29',
      node_time: '11:29',
      data_health: { status: 'OK' },
    },
    ...extra,
  };
}

test('valid bridge envelope is exposed as a successful thin read', () => {
  const result = validateEnvelope(envelope(), 'radar_latest', NOW);
  assert.equal(result.success, true);
  assert.equal(result.status, 'OK');
  assert.equal(result.mode, 'ai_stock_system_bridge_v1');
  assert.equal(result.data.node_time, '11:29');
  assert.equal(result.diagnostics.exportAgeSeconds, 30);
});

test('source failure status is propagated with data for diagnostics', () => {
  const result = validateEnvelope(envelope({
    status: 'DATA_INSUFFICIENT',
    diagnostics: { reasons: ['quotes_reconcile.json:FILE_MISSING'] },
  }), 'radar_latest', NOW);
  assert.equal(result.success, false);
  assert.equal(result.status, 'DATA_INSUFFICIENT');
  assert.deepEqual(result.diagnostics.reasons, ['quotes_reconcile.json:FILE_MISSING']);
  assert.equal(httpStatusFor(result.status), 503);
});

test('stale exporter heartbeat cannot masquerade as success', () => {
  const result = validateEnvelope(envelope({
    exportedAt: '2026-07-29T03:20:00.000Z',
  }), 'radar_latest', NOW);
  assert.equal(result.success, false);
  assert.equal(result.status, 'STALE');
  assert.ok(result.diagnostics.reasons.includes('EXPORTER_HEARTBEAT_STALE'));
});

test('schema, kind, status and timestamp mismatches are rejected', () => {
  assert.equal(validateEnvelope(envelope({ schemaVersion: 'v0' }), 'radar_latest', NOW).status, 'UPSTREAM_INVALID');
  assert.equal(validateEnvelope(envelope({ kind: 'active_pool' }), 'radar_latest', NOW).status, 'UPSTREAM_INVALID');
  assert.equal(validateEnvelope(envelope({ status: 'UNKNOWN' }), 'radar_latest', NOW).status, 'UPSTREAM_INVALID');
  assert.equal(validateEnvelope(envelope({ exportedAt: 'not-a-date' }), 'radar_latest', NOW).status, 'UPSTREAM_INVALID');
});

test('conflict is never silently selected', () => {
  const result = validateEnvelope(envelope({ status: 'CONFLICT' }), 'radar_latest', NOW);
  assert.equal(result.success, false);
  assert.equal(result.status, 'CONFLICT');
  assert.equal(httpStatusFor(result.status), 409);
});

test('protected HTTP endpoint reads exactly one exported Redis snapshot', async (t) => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return { result: JSON.stringify(envelope({ exportedAt: new Date().toISOString() })) };
      },
    };
  };
  t.after(() => { global.fetch = previousFetch; });

  const handler = require('../api/system-radar-latest');
  const req = {
    method: 'GET',
    headers: { 'x-capture-token': 'bridge-test-secret' },
    query: {},
  };
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(payload) { this.payload = payload; },
  };
  await handler(req, response);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.payload).kind, 'radar_latest');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), [
    'GET', 'ai-stock:bridge:v1:radar:latest',
  ]);
});

test('MCP preserves the bridge structured error instead of replacing status with HTTP code', () => {
  const result = preserveSystemBridgeFailure('get_system_radar_latest', {
    success: false,
    status: 503,
    error: 'Upstream returned HTTP 503',
    data: {
      success: false,
      status: 'DATA_INSUFFICIENT',
      error: { code: 'DATA_INSUFFICIENT', message: 'Snapshot missing' },
      diagnostics: { kind: 'radar_latest' },
    },
    url: 'https://example.invalid/api/system-radar-latest?token=%5Bredacted%5D',
  });
  assert.equal(result.success, false);
  assert.equal(result.status, 'DATA_INSUFFICIENT');
  assert.equal(result.httpStatus, 503);
  assert.equal(result.error.code, 'DATA_INSUFFICIENT');
});
