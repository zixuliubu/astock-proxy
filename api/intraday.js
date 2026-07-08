const https = require('https');

const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CAPTURE_SECRET = process.env.CAPTURE_SECRET;
const NODE_TTL_SECONDS = Number(process.env.NODE_TTL_SECONDS || 60 * 60 * 24 * 30);
const NODES = ['09:35', '10:35', '11:35', '13:35', '14:35', '15:00'];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function chinaParts() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
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
  let current = NODES[0];
  let next = null;
  for (const n of NODES) {
    if (hhmm >= n) current = n;
    else if (!next) next = n;
  }
  return { currentNode: current, nextNode: next, allNodes: NODES };
}

function checkAuth(req, label = 'request') {
  if (!CAPTURE_SECRET) return { ok: false, status: 500, error: 'CAPTURE_SECRET is not configured' };
  const token = req.headers['x-capture-token'] || req.query?.token;
  if (token !== CAPTURE_SECRET) return { ok: false, status: 401, error: `Unauthorized ${label}` };
  return { ok: true };
}

function checkStorage() {
  if (!REDIS_URL || !REDIS_TOKEN) return { ok: false, error: 'UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not configured' };
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

function fetchHttpsJson(pathOrUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${ASTOCK_BASE_URL}${pathOrUrl}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...headers }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () {
      this.destroy(); reject(new Error('timeout'));
    });
  });
}

async function fetchJson(path, query = {}) {
  const url = new URL(path, ASTOCK_BASE_URL);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return fetchHttpsJson(url.toString()).catch(e => ({ success: false, error: e.message }));
}

function briefFromSnapshot(snapshot) {
  const sentiment = snapshot.sentiment?.sentiment || snapshot.data?.marketSentiment?.sentiment || snapshot.data?.marketOverview?.sentiment || null;
  const ladder = snapshot.ladder?.ladder || snapshot.data?.lianbanLadder?.ladder || null;
  const overview = snapshot.overview?.overview || snapshot.data?.marketOverview?.overview || null;
  const sectors = snapshot.sectors?.data || snapshot.data?.hotSectors?.data || [];
  const watch = snapshot.data?.watchlist?.summary || {};
  return {
    node: snapshot.node,
    chinaTime: snapshot.chinaTime,
    marketLabel: overview?.label || sentiment?.label || '待确认',
    turnoverYi: overview?.turnoverYi ?? null,
    limitUp: sentiment?.limitUp ?? null,
    limitDown: sentiment?.limitDown ?? null,
    brokenCount: sentiment?.brokenCount ?? null,
    brokenRatio: sentiment?.brokenRatio ?? null,
    maxBoard: ladder?.maxBoard ?? null,
    boardDistribution: ladder?.distribution || null,
    topSectors: Array.isArray(sectors) ? sectors.slice(0, 5) : [],
    topAmountWatch: watch.topAmount || [],
    strongestSupport: watch.strongestSupport || [],
  };
}

async function snapshotNow() {
  const nowCN = chinaParts();
  const nodeInfo = nearestNode(nowCN.time);
  const [overview, sentiment, ladder, sectors] = await Promise.all([
    fetchJson('/api/market-overview'),
    fetchJson('/api/sentiment'),
    fetchJson('/api/lianban-ladder'),
    fetchJson('/api/sector'),
  ]);
  const snapshot = { overview, sentiment, ladder, sectors };
  return {
    success: true,
    mode: 'stateless_snapshot_v1',
    chinaTime: nowCN.isoLike,
    ...nodeInfo,
    snapshot,
    brief: briefFromSnapshot({ ...snapshot, chinaTime: nowCN.isoLike, node: nodeInfo.currentNode }),
    limitation: '当前是即时快照；真实节点变化请使用 action=timeline 读取已采样数据。',
    updateTime: new Date().toISOString(),
  };
}

async function collectSnapshot(node, date) {
  const [marketOverview, marketSentiment, lianbanLadder, limitUpPool, brokenLimitPool, limitDownPool, hotSectors, watchlist, newsCatalysts] = await Promise.all([
    fetchJson('/api/market-overview'),
    fetchJson('/api/sentiment'),
    fetchJson('/api/lianban-ladder', { date }),
    fetchJson('/api/limit-up', { date }),
    fetchJson('/api/risk-pools', { type: 'broken', date }),
    fetchJson('/api/risk-pools', { type: 'down', date }),
    fetchJson('/api/sector'),
    fetchJson('/api/watchlist', { group: 'default' }),
    fetchJson('/api/extra', { type: 'news' }),
  ]);
  const cp = chinaParts();
  const snapshot = {
    node,
    date,
    chinaTime: cp.isoLike,
    capturedAt: new Date().toISOString(),
    source: 'intraday-capture',
    data: { marketOverview, marketSentiment, lianbanLadder, limitUpPool, brokenLimitPool, limitDownPool, hotSectors, watchlist, newsCatalysts },
  };
  snapshot.brief = briefFromSnapshot(snapshot);
  return snapshot;
}

async function captureNode(req) {
  const auth = checkAuth(req, 'capture request');
  if (!auth.ok) return { status: auth.status, body: { success: false, error: auth.error } };
  const storage = checkStorage();
  if (!storage.ok) return { status: 500, body: { success: false, error: storage.error } };
  const cp = chinaParts();
  const date = String(req.query.date || cp.date).replace(/-/g, '');
  const node = String(req.query.node || nearestNode(cp.time).currentNode);
  const key = `astock:intraday:${date}`;
  const snapshot = await collectSnapshot(node, date);
  const existingRaw = await redisCommand(['GET', key]);
  let timeline = [];
  if (existingRaw) {
    try { timeline = JSON.parse(existingRaw); } catch (err) { timeline = []; }
  }
  const nextTimeline = [...timeline.filter(item => item.node !== node), snapshot].sort((a, b) => NODES.indexOf(a.node) - NODES.indexOf(b.node));
  await redisCommand(['SET', key, JSON.stringify(nextTimeline)]);
  await redisCommand(['EXPIRE', key, String(NODE_TTL_SECONDS)]);
  return {
    status: 200,
    body: { success: true, mode: 'saved_intraday_node_snapshot', key, date, node, savedCount: nextTimeline.length, brief: snapshot.brief, updateTime: new Date().toISOString() },
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function diffValue(current, previous) {
  const a = num(current); const b = num(previous);
  if (a === null || b === null) return null;
  return Number((a - b).toFixed(2));
}
function topSectorNames(brief) {
  const arr = Array.isArray(brief.topSectors) ? brief.topSectors : [];
  return arr.slice(0, 5).map(x => x.name || x.sector || x.title || '').filter(Boolean);
}
function buildChanges(timeline) {
  return timeline.map((item, i) => {
    const cur = item.brief || {};
    const prev = i > 0 ? (timeline[i - 1].brief || {}) : null;
    return {
      node: item.node,
      chinaTime: item.chinaTime,
      marketLabel: cur.marketLabel || '待确认',
      turnoverYi: cur.turnoverYi ?? null,
      limitUp: cur.limitUp ?? null,
      limitDown: cur.limitDown ?? null,
      brokenCount: cur.brokenCount ?? null,
      maxBoard: cur.maxBoard ?? null,
      boardDistribution: cur.boardDistribution || null,
      topSectors: topSectorNames(cur),
      delta: prev ? { turnoverYi: diffValue(cur.turnoverYi, prev.turnoverYi), limitUp: diffValue(cur.limitUp, prev.limitUp), limitDown: diffValue(cur.limitDown, prev.limitDown), brokenCount: diffValue(cur.brokenCount, prev.brokenCount), maxBoard: diffValue(cur.maxBoard, prev.maxBoard) } : null,
    };
  });
}
function buildConclusion(changes) {
  if (!changes.length) return '暂无节点快照，先手动调用 action=capture 或等待 GitHub Actions 定时采样。';
  const first = changes[0]; const last = changes[changes.length - 1];
  const parts = [`已保存 ${changes.length} 个节点，首节点 ${first.node}，末节点 ${last.node}。`];
  const limitUpDelta = diffValue(last.limitUp, first.limitUp);
  const brokenDelta = diffValue(last.brokenCount, first.brokenCount);
  const turnoverDelta = diffValue(last.turnoverYi, first.turnoverYi);
  if (limitUpDelta !== null) parts.push(`涨停数较首节点变化 ${limitUpDelta}。`);
  if (brokenDelta !== null) parts.push(`炸板数较首节点变化 ${brokenDelta}。`);
  if (turnoverDelta !== null) parts.push(`成交额较首节点变化约 ${turnoverDelta} 亿。`);
  if (last.maxBoard !== null) parts.push(`末节点最高板为 ${last.maxBoard} 板。`);
  return parts.join('');
}
async function timeline(req) {
  const auth = checkAuth(req, 'timeline request');
  if (!auth.ok) return { status: auth.status, body: { success: false, error: auth.error } };
  const storage = checkStorage();
  if (!storage.ok) return { status: 500, body: { success: false, error: storage.error } };
  const date = String(req.query.date || chinaParts().date).replace(/-/g, '');
  const key = `astock:intraday:${date}`;
  const raw = await redisCommand(['GET', key]);
  const list = raw ? JSON.parse(raw) : [];
  const sorted = Array.isArray(list) ? list.sort((a, b) => NODES.indexOf(a.node) - NODES.indexOf(b.node)) : [];
  const changes = buildChanges(sorted);
  return { status: 200, body: { success: true, date, key, count: sorted.length, nodes: sorted.map(x => x.node), changes, conclusion: buildConclusion(changes), rawTimeline: req.query.raw === 'true' ? sorted : undefined, updateTime: new Date().toISOString() } };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  try {
    const action = String(req.query.action || 'snapshot');
    let result;
    if (action === 'capture') result = await captureNode(req);
    else if (action === 'timeline') result = await timeline(req);
    else result = { status: 200, body: await snapshotNow() };
    return json(res, result.status, result.body);
  } catch (e) {
    return json(res, 500, { success: false, error: e.message, action: req.query.action || 'snapshot' });
  }
};
