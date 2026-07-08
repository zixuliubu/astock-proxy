const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CAPTURE_SECRET = process.env.CAPTURE_SECRET;
const NODE_TTL_SECONDS = Number(process.env.NODE_TTL_SECONDS || 60 * 60 * 24 * 30);

const DEFAULT_NODES = ['09:35', '10:35', '11:35', '13:35', '14:35', '15:00'];

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
  }).formatToParts(new Date()).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    dateText: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    isoLike: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function nearestNode(hhmmss) {
  const hhmm = String(hhmmss || '').slice(0, 5);
  let current = DEFAULT_NODES[0];
  for (const n of DEFAULT_NODES) {
    if (hhmm >= n) current = n;
  }
  return current;
}

function checkAuth(req) {
  if (!CAPTURE_SECRET) return { ok: false, status: 500, error: 'CAPTURE_SECRET is not configured' };
  const token = req.headers['x-capture-token'] || req.query?.token;
  if (token !== CAPTURE_SECRET) return { ok: false, status: 401, error: 'Unauthorized capture request' };
  return { ok: true };
}

function checkStorage() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return { ok: false, error: 'UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not configured' };
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
  if (!response.ok || data.error) {
    throw new Error(data.error || `Redis HTTP ${response.status}`);
  }
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
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
    if (!response.ok) return { success: false, status: response.status, error: `HTTP ${response.status}`, data };
    return data;
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
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
  const [marketOverview, marketSentiment, lianbanLadder, limitUpPool, brokenLimitPool, limitDownPool, hotSectors, watchlist, newsCatalysts] = await Promise.all([
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

  const cp = chinaParts();
  const snapshot = {
    node,
    date,
    chinaTime: cp.isoLike,
    capturedAt: new Date().toISOString(),
    source: 'capture-node',
    data: {
      marketOverview,
      marketSentiment,
      lianbanLadder,
      limitUpPool,
      brokenLimitPool,
      limitDownPool,
      hotSectors,
      watchlist,
      newsCatalysts,
    },
  };
  snapshot.brief = brief(snapshot);
  return snapshot;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const auth = checkAuth(req);
  if (!auth.ok) return json(res, auth.status, { success: false, error: auth.error });
  const storage = checkStorage();
  if (!storage.ok) return json(res, 500, { success: false, error: storage.error });

  const cp = chinaParts();
  const date = String(req.query.date || cp.date).replace(/-/g, '');
  const node = String(req.query.node || nearestNode(cp.time));
  const key = `astock:intraday:${date}`;

  try {
    const snapshot = await collectSnapshot(node, date);
    const existingRaw = await redisCommand(['GET', key]);
    let timeline = [];
    if (existingRaw) {
      try { timeline = JSON.parse(existingRaw); } catch (err) { timeline = []; }
    }
    const withoutSameNode = timeline.filter(item => item.node !== node);
    const nextTimeline = [...withoutSameNode, snapshot].sort((a, b) => DEFAULT_NODES.indexOf(a.node) - DEFAULT_NODES.indexOf(b.node));
    await redisCommand(['SET', key, JSON.stringify(nextTimeline)]);
    await redisCommand(['EXPIRE', key, String(NODE_TTL_SECONDS)]);

    return json(res, 200, {
      success: true,
      mode: 'saved_intraday_node_snapshot',
      key,
      date,
      node,
      savedCount: nextTimeline.length,
      brief: snapshot.brief,
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message, key, date, node });
  }
};
