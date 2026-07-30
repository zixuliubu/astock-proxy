const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CAPTURE_SECRET = process.env.CAPTURE_SECRET;
const { TRADING_NODES, timelineCoverage, failure } = require('./_data-contracts');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function chinaDate() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}${parts.month}${parts.day}`;
}

function checkReadAuth(req) {
  if (!CAPTURE_SECRET) return { ok: false, status: 500, error: 'CAPTURE_SECRET is not configured' };
  const token = req.headers['x-capture-token'] || req.query?.token;
  if (token !== CAPTURE_SECRET) return { ok: false, status: 401, error: 'Unauthorized timeline request' };
  return { ok: true };
}

async function redisCommand(command) {
  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `Redis HTTP ${response.status}`);
  return data.result;
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function diffValue(current, previous) {
  const left = num(current);
  const right = num(previous);
  return left === null || right === null ? null : Number((left - right).toFixed(2));
}

function topSectorNames(brief) {
  const rows = Array.isArray(brief?.topSectors) ? brief.topSectors : [];
  return rows.slice(0, 5).map(item => item.name || item.sector || item.板块 || item.title || '').filter(Boolean);
}

function buildChanges(timeline) {
  return timeline.map((snapshot, index) => {
    const current = snapshot?.brief || {};
    const previous = index > 0 ? timeline[index - 1]?.brief || {} : null;
    return {
      node: snapshot.node,
      chinaTime: snapshot.chinaTime,
      capturedAt: snapshot.capturedAt,
      marketLabel: current.marketLabel || '待确认',
      turnoverYi: current.turnoverYi ?? null,
      limitUp: current.limitUp ?? null,
      limitDown: current.limitDown ?? null,
      brokenCount: current.brokenCount ?? null,
      maxBoard: current.maxBoard ?? null,
      boardDistribution: current.boardDistribution || null,
      topSectors: topSectorNames(current),
      componentStatus: snapshot.componentStatus || null,
      delta: previous ? {
        turnoverYi: diffValue(current.turnoverYi, previous.turnoverYi),
        limitUp: diffValue(current.limitUp, previous.limitUp),
        limitDown: diffValue(current.limitDown, previous.limitDown),
        brokenCount: diffValue(current.brokenCount, previous.brokenCount),
        maxBoard: diffValue(current.maxBoard, previous.maxBoard),
      } : null,
    };
  });
}

function buildConclusion(changes, coverage) {
  if (!changes.length) return '暂无有效节点快照。';
  const first = changes[0];
  const last = changes.at(-1);
  const parts = [`有效节点 ${changes.length} 个，首节点 ${first.node}，末节点 ${last.node}。`];
  if (coverage.missingNodes.length) parts.push(`缺失节点：${coverage.missingNodes.join('、')}。`);
  if (coverage.invalidStoredNodes.length) parts.push(`已隔离非法节点：${coverage.invalidStoredNodes.join('、')}。`);
  return parts.join('');
}

function incompleteComponents(timeline) {
  const critical = ['marketOverview', 'marketSentiment', 'lianbanLadder', 'hotSectors'];
  return timeline.flatMap(snapshot => critical
    .filter(name => snapshot?.data?.[name]?.success === false || snapshot?.componentStatus?.[name] === 'failed')
    .map(name => ({ node: snapshot.node, component: name })));
}

function parseHashTimeline(raw) {
  const values = Array.isArray(raw) ? raw : [];
  const timeline = [];
  const invalidFields = [];
  for (let index = 0; index < values.length; index += 2) {
    const field = values[index];
    try {
      const snapshot = JSON.parse(values[index + 1]);
      timeline.push(snapshot);
    } catch (error) {
      invalidFields.push(field);
    }
  }
  return { timeline, invalidFields };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, failure('METHOD_NOT_ALLOWED', 'Method not allowed'));

  const auth = checkReadAuth(req);
  if (!auth.ok) return json(res, auth.status, failure('UNAUTHORIZED', auth.error));
  if (!REDIS_URL || !REDIS_TOKEN) {
    return json(res, 500, failure('CONFIG_ERROR', 'Upstash Redis is not configured'));
  }

  const date = String(req.query.date || chinaDate()).replace(/-/g, '');
  const legacyKey = `astock:intraday:${date}`;
  const key = `astock:intraday:v2:${date}`;
  try {
    const [legacyRaw, hashRaw] = await Promise.all([
      redisCommand(['GET', legacyKey]),
      redisCommand(['HGETALL', key]),
    ]);
    let legacyTimeline = [];
    if (legacyRaw) {
      try {
        legacyTimeline = JSON.parse(legacyRaw);
      } catch (error) {
        legacyTimeline = [];
      }
    }
    const parsedHash = parseHashTimeline(hashRaw);
    const timeline = [
      ...(Array.isArray(legacyTimeline) ? legacyTimeline : []),
      ...parsedHash.timeline,
    ];
    const coverage = timelineCoverage(timeline, date);
    const changes = buildChanges(coverage.sorted);
    const incomplete = incompleteComponents(coverage.sorted);
    const complete = coverage.complete && incomplete.length === 0;
    const response = {
      success: complete,
      status: complete ? 'OK' : 'DATA_INSUFFICIENT',
      date,
      key,
      storageSchema: 'redis_hash_by_scheduled_node_v3_first_valid_write_with_legacy_read',
      storageKeys: { current: key, legacy: legacyKey },
      timeZone: 'Asia/Shanghai',
      scheduledNodes: TRADING_NODES,
      expectedNodes: coverage.expectedNodes,
      actualCapturedNodes: coverage.actualCapturedNodes,
      actualCaptureTimes: coverage.sorted.map(item => ({
        node: item.node,
        scheduledTargetNode: item.scheduledTargetNode || item.node,
        chinaTime: item.chinaTime,
        capturedAt: item.capturedAt,
        captureLagMinutes: item.captureLagMinutes ?? null,
        nodeResolution: item.nodeResolution || null,
        replacementCount: Number(item.replacementCount || 0),
        replacedPreviousCapturedAt: item.replacedPreviousCapturedAt || null,
      })),
      missingNodes: coverage.missingNodes,
      missingReasons: coverage.missingNodes.map(node => ({
        node,
        reason: 'No valid on-time snapshot was stored; the scheduler did not run or the capture was rejected/failed',
      })),
      invalidStoredNodes: coverage.invalidStoredNodes,
      invalidHashFields: parsedHash.invalidFields,
      incompleteComponents: incomplete,
      duplicatePolicy: 'first valid snapshot wins; new duplicate captures are ignored; historical replacement metadata remains auditable',
      overwrittenNodes: coverage.overwrittenNodes,
      count: coverage.sorted.length,
      nodes: coverage.actualCapturedNodes,
      changes,
      conclusion: buildConclusion(changes, coverage),
      rawTimeline: req.query.raw === 'true' ? coverage.sorted : undefined,
      updateTime: new Date().toISOString(),
    };
    return json(res, complete ? 200 : 503, response);
  } catch (error) {
    return json(res, 500, failure('UPSTREAM_FAILED', error.message, { key, date }));
  }
};

module.exports.buildChanges = buildChanges;
module.exports.parseHashTimeline = parseHashTimeline;
