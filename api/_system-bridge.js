const { failure } = require('./_data-contracts');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const READ_SECRET = process.env.SYSTEM_BRIDGE_READ_SECRET || process.env.CAPTURE_SECRET;
const MAX_EXPORT_AGE_SECONDS = Math.max(
  60,
  Number(process.env.SYSTEM_BRIDGE_MAX_EXPORT_AGE_SECONDS || 180),
);
const SCHEMA_VERSION = 'ai_stock_mcp_bridge.v1';
const KEYS = Object.freeze({
  radar_latest: 'ai-stock:bridge:v1:radar:latest',
  active_pool: 'ai-stock:bridge:v1:active-pool:latest',
  data_health: 'ai-stock:bridge:v1:data-health:latest',
});
const VALID_STATUSES = new Set([
  'OK', 'PARTIAL', 'STALE', 'DATA_INSUFFICIENT', 'CONFLICT', 'FAILED',
]);

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function checkReadAuth(req) {
  if (!READ_SECRET) {
    return {
      ok: false,
      httpStatus: 503,
      body: failure('CONFIG_MISSING', 'System bridge read secret is not configured'),
    };
  }
  const token = req.headers['x-capture-token'] || req.query?.token;
  if (token !== READ_SECRET) {
    return {
      ok: false,
      httpStatus: 401,
      body: failure('UNAUTHORIZED', 'Unauthorized system bridge request'),
    };
  }
  return { ok: true };
}

async function redisCommand(command) {
  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error('Redis read failed');
  return data.result;
}

function validateEnvelope(value, expectedKind, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure('UPSTREAM_INVALID', 'System bridge snapshot is not a JSON object');
  }
  const diagnostics = {
    expectedSchemaVersion: SCHEMA_VERSION,
    actualSchemaVersion: value.schemaVersion || null,
    expectedKind,
    actualKind: value.kind || null,
  };
  if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== expectedKind) {
    return failure('UPSTREAM_INVALID', 'System bridge snapshot contract does not match', diagnostics);
  }
  if (!VALID_STATUSES.has(value.status)) {
    return failure('UPSTREAM_INVALID', 'System bridge snapshot has an invalid status', {
      ...diagnostics,
      actualStatus: value.status || null,
    });
  }
  const exportedAtMs = Date.parse(value.exportedAt);
  if (!Number.isFinite(exportedAtMs)) {
    return failure('UPSTREAM_INVALID', 'System bridge snapshot has an invalid exportedAt', diagnostics);
  }
  const ageSeconds = (now.getTime() - exportedAtMs) / 1000;
  if (ageSeconds < -300) {
    return failure('UPSTREAM_INVALID', 'System bridge snapshot timestamp is in the future', {
      ...diagnostics,
      exportedAt: value.exportedAt,
      ageSeconds,
    });
  }
  const status = ageSeconds > MAX_EXPORT_AGE_SECONDS ? 'STALE' : value.status;
  const reasons = [
    ...(Array.isArray(value.diagnostics?.reasons) ? value.diagnostics.reasons : []),
    ...(ageSeconds > MAX_EXPORT_AGE_SECONDS ? ['EXPORTER_HEARTBEAT_STALE'] : []),
  ];
  return {
    success: status === 'OK',
    status,
    mode: 'ai_stock_system_bridge_v1',
    kind: expectedKind,
    producer: value.producer || 'AI-Stock-System',
    schemaVersion: value.schemaVersion,
    exportedAt: value.exportedAt,
    sourceUpdatedAt: value.sourceUpdatedAt || null,
    sourceFiles: Array.isArray(value.sourceFiles) ? value.sourceFiles : [],
    diagnostics: {
      reasons: [...new Set(reasons)],
      exportAgeSeconds: Number(Math.max(0, ageSeconds).toFixed(1)),
      maxExportAgeSeconds: MAX_EXPORT_AGE_SECONDS,
    },
    data: value.data ?? null,
    updateTime: new Date().toISOString(),
  };
}

function httpStatusFor(status) {
  if (status === 'OK') return 200;
  if (status === 'CONFLICT') return 409;
  if (status === 'FAILED' || status === 'UPSTREAM_INVALID') return 502;
  return 503;
}

async function readBridgeSnapshot(kind, now = new Date()) {
  const key = KEYS[kind];
  if (!key) return failure('INVALID_ARGUMENT', 'Unknown system bridge snapshot kind', { kind });
  if (!REDIS_URL || !REDIS_TOKEN) {
    return failure('CONFIG_MISSING', 'Upstash Redis is not configured');
  }
  let raw;
  try {
    raw = await redisCommand(['GET', key]);
  } catch (error) {
    return failure('UPSTREAM_FAILED', 'System bridge storage is unavailable', { kind });
  }
  if (!raw) {
    return failure('DATA_INSUFFICIENT', 'System bridge snapshot has not been exported', { kind });
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return failure('UPSTREAM_INVALID', 'System bridge snapshot is not valid JSON', { kind });
  }
  return validateEnvelope(value, kind, now);
}

function handlerFor(kind) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') {
      return json(res, 405, failure('METHOD_NOT_ALLOWED', 'Method not allowed'));
    }
    const auth = checkReadAuth(req);
    if (!auth.ok) return json(res, auth.httpStatus, auth.body);
    const result = await readBridgeSnapshot(kind);
    return json(res, httpStatusFor(result.status), result);
  };
}

module.exports = {
  KEYS,
  MAX_EXPORT_AGE_SECONDS,
  SCHEMA_VERSION,
  checkReadAuth,
  handlerFor,
  httpStatusFor,
  readBridgeSnapshot,
  validateEnvelope,
};
