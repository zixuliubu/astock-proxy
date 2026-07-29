const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CAPTURE_SECRET = process.env.CAPTURE_SECRET;
const NODE_TTL_SECONDS = Number(process.env.NODE_TTL_SECONDS || 60 * 60 * 24 * 30);
const { TRADING_NODES, normalizeNode, failure } = require('./_data-contracts');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function chinaParts() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date()).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    isoLike: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function nearestNode(hhmmss) {
  const hhmm = String(hhmmss || '').slice(0, 5);
  let current = null;
  for (const node of TRADING_NODES) {
    if (hhmm >= node) current = node;
  }
  return current;
}

function checkAuth(req) {
  if (!CAPTURE_SECRET) return { ok: false, status: 500, error: 'CAPTURE_SECRET is not configured' };
  const token = req.headers['x-capture-token'] || req.query?.token;
  if (token !== CAPTURE_SECRET) return { ok: false, status: 401, error: 'Unauthorized capture request' };
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
  if (!response.ok || data.error) throw new Error(data.error || `Redis HTTP ${response.status}`);
  return data.result;
}

async function fetchJson(path, query = {}) {
  const url = new URL(path, ASTOCK_BASE_URL);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
    if (!response.ok) return { success: false, status: response.status, error: `HTTP ${response.status}`, data };
    return data;
  } catch (error) {
    return {
      success: false,
      error: error.name === 'AbortError' ? 'timeout' : String(error.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function brief(snapshot) {
  const overview = snapshot.data?.marketOverview?.overview || {};
  const sentiment = snapshot.data?.marketSentiment?.sentiment || snapshot.data?.marketOverview?.sentiment || {};
  const ladder = snapshot.data?.lianbanLadder?.ladder || {};
  const sectors = snapshot.data?.hotSectors?.data || [];
  const watch = snapshot.data?.watchlist?.summary || {};
  return {
    node: snapshot.node,
    chinaTime: snapshot.chinaTime,
    marketLabel: overview.label || sentiment.label || '待确认',
    turnoverYi: overview.turnoverYi ?? null,
    limitUp: sentiment.limitUp ?? null,
    limitDown: sentiment.limitDown ?? null,
    brokenCount: sentiment.brokenCount ?? null,
    brokenRatio: sentiment.brokenRatio ?? null,
    maxBoard: ladder.maxBoard ?? null,
    boardDistribution: ladder.distribution || null,
    topSectors: Array.isArray(sectors) ? sectors.slice(0, 5) : [],
    topAmountWatch: watch.topAmount || [],
    strongestSupport: watch.strongestSupport || [],
  };
}

async function collectSnapshot(node, date) {
  const names = [
    'marketOverview', 'marketSentiment', 'lianbanLadder', 'limitUpPool',
    'brokenLimitPool', 'limitDownPool', 'hotSectors', 'watchlist', 'newsCatalysts',
  ];
  const results = await Promise.all([
    fetchJson('/api/market-overview'),
    fetchJson('/api/sentiment'),
    fetchJson('/api/lianban-ladder', { date }),
    fetchJson('/api/limit-up', { date }),
    fetchJson('/api/broken-limit', { date }),
    fetchJson('/api/limit-down', { date }),
    fetchJson('/api/sector'),
    fetchJson('/api/watchlist', { group: 'default' }),
    fetchJson('/api/news-catalysts'),
  ]);
  const data = Object.fromEntries(names.map((name, index) => [name, results[index]]));
  const cp = chinaParts();
  const snapshot = {
    node,
    scheduledChinaTime: node,
    date,
    chinaTime: cp.isoLike,
    capturedAt: new Date().toISOString(),
    source: 'capture-node',
    componentStatus: Object.fromEntries(names.map(name => [
      name,
      data[name]?.success === false ? data[name]?.status || 'failed' : 'ok',
    ])),
    data,
  };
  snapshot.brief = brief(snapshot);
  return snapshot;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, failure('METHOD_NOT_ALLOWED', 'Method not allowed'));

  const auth = checkAuth(req);
  if (!auth.ok) return json(res, auth.status, failure('UNAUTHORIZED', auth.error));
  if (!REDIS_URL || !REDIS_TOKEN) {
    return json(res, 500, failure('CONFIG_ERROR', 'Upstash Redis is not configured'));
  }

  const cp = chinaParts();
  const date = String(req.query.date || cp.date).replace(/-/g, '');
  const requestedNode = req.query.node ? normalizeNode(req.query.node) : nearestNode(cp.time);
  if (!requestedNode) {
    return json(res, 400, failure('INVALID_ARGUMENT', 'node must be a scheduled Asia/Shanghai trading node', {
      requestedNode: req.query.node || null,
      scheduledNodes: TRADING_NODES,
      chinaTime: cp.isoLike,
    }));
  }
  const key = `astock:intraday:${date}`;

  try {
    const snapshot = await collectSnapshot(requestedNode, date);
    const existingRaw = await redisCommand(['GET', key]);
    let timeline = [];
    if (existingRaw) {
      try {
        timeline = JSON.parse(existingRaw);
      } catch (error) {
        timeline = [];
      }
    }
    const replacedNode = timeline.some(item => item.node === requestedNode);
    const nextTimeline = [
      ...timeline.filter(item => item.node !== requestedNode),
      snapshot,
    ].sort((left, right) => TRADING_NODES.indexOf(left.node) - TRADING_NODES.indexOf(right.node));
    await redisCommand(['SET', key, JSON.stringify(nextTimeline)]);
    await redisCommand(['EXPIRE', key, String(NODE_TTL_SECONDS)]);

    const criticalFailures = ['marketOverview', 'marketSentiment', 'lianbanLadder', 'hotSectors']
      .filter(name => snapshot.componentStatus[name] !== 'ok');
    const success = criticalFailures.length === 0;
    return json(res, success ? 200 : 503, {
      success,
      status: success ? 'OK' : 'DATA_INSUFFICIENT',
      mode: 'saved_intraday_node_snapshot',
      key,
      date,
      node: requestedNode,
      timeZone: 'Asia/Shanghai',
      actualChinaTime: snapshot.chinaTime,
      replacedNode,
      duplicatePolicy: 'replace the snapshot for the same scheduled node',
      savedCount: nextTimeline.length,
      criticalFailures,
      componentStatus: snapshot.componentStatus,
      brief: snapshot.brief,
      updateTime: new Date().toISOString(),
    });
  } catch (error) {
    return json(res, 500, failure('UPSTREAM_FAILED', error.message, { key, date, node: requestedNode }));
  }
};

module.exports.nearestNode = nearestNode;
