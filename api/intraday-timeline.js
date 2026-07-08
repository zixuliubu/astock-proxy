const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CAPTURE_SECRET = process.env.CAPTURE_SECRET;
const DEFAULT_NODES = ['09:35', '10:35', '11:35', '13:35', '14:35', '15:00'];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function chinaDate() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}${parts.month}${parts.day}`;
}

function checkReadAuth(req) {
  if (!CAPTURE_SECRET) return { ok: false, status: 500, error: 'CAPTURE_SECRET is not configured' };
  const token = req.headers['x-capture-token'] || req.query?.token;
  if (token !== CAPTURE_SECRET) return { ok: false, status: 401, error: 'Unauthorized timeline request' };
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

function getBrief(snapshot) {
  return snapshot?.brief || {};
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function diffValue(current, previous) {
  const a = num(current);
  const b = num(previous);
  if (a === null || b === null) return null;
  return Number((a - b).toFixed(2));
}

function topSectorNames(brief) {
  const arr = Array.isArray(brief.topSectors) ? brief.topSectors : [];
  return arr.slice(0, 5).map(x => x.name || x.sector || x.板块 || x.title || '').filter(Boolean);
}

function buildChanges(timeline) {
  const rows = [];
  for (let i = 0; i < timeline.length; i += 1) {
    const cur = getBrief(timeline[i]);
    const prev = i > 0 ? getBrief(timeline[i - 1]) : null;
    rows.push({
      node: timeline[i].node,
      chinaTime: timeline[i].chinaTime,
      marketLabel: cur.marketLabel || '待确认',
      turnoverYi: cur.turnoverYi ?? null,
      limitUp: cur.limitUp ?? null,
      limitDown: cur.limitDown ?? null,
      brokenCount: cur.brokenCount ?? null,
      maxBoard: cur.maxBoard ?? null,
      boardDistribution: cur.boardDistribution || null,
      topSectors: topSectorNames(cur),
      delta: prev ? {
        turnoverYi: diffValue(cur.turnoverYi, prev.turnoverYi),
        limitUp: diffValue(cur.limitUp, prev.limitUp),
        limitDown: diffValue(cur.limitDown, prev.limitDown),
        brokenCount: diffValue(cur.brokenCount, prev.brokenCount),
        maxBoard: diffValue(cur.maxBoard, prev.maxBoard),
      } : null,
    });
  }
  return rows;
}

function buildConclusion(changes) {
  if (!changes.length) return '暂无节点快照，先手动调用 capture-node 或等待 GitHub Actions 定时采样。';
  const first = changes[0];
  const last = changes[changes.length - 1];
  const limitUpDelta = diffValue(last.limitUp, first.limitUp);
  const brokenDelta = diffValue(last.brokenCount, first.brokenCount);
  const turnoverDelta = diffValue(last.turnoverYi, first.turnoverYi);
  const parts = [];
  parts.push(`已保存 ${changes.length} 个节点，首节点 ${first.node}，末节点 ${last.node}。`);
  if (limitUpDelta !== null) parts.push(`涨停数较首节点变化 ${limitUpDelta}。`);
  if (brokenDelta !== null) parts.push(`炸板数较首节点变化 ${brokenDelta}。`);
  if (turnoverDelta !== null) parts.push(`成交额较首节点变化约 ${turnoverDelta} 亿。`);
  if (last.maxBoard !== null) parts.push(`末节点最高板为 ${last.maxBoard} 板。`);
  return parts.join('');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const auth = checkReadAuth(req);
  if (!auth.ok) return json(res, auth.status, { success: false, error: auth.error });
  const storage = checkStorage();
  if (!storage.ok) return json(res, 500, { success: false, error: storage.error });

  const date = String(req.query.date || chinaDate()).replace(/-/g, '');
  const key = `astock:intraday:${date}`;

  try {
    const raw = await redisCommand(['GET', key]);
    const timeline = raw ? JSON.parse(raw) : [];
    const sorted = Array.isArray(timeline)
      ? timeline.sort((a, b) => DEFAULT_NODES.indexOf(a.node) - DEFAULT_NODES.indexOf(b.node))
      : [];
    const changes = buildChanges(sorted);
    return json(res, 200, {
      success: true,
      date,
      key,
      count: sorted.length,
      nodes: sorted.map(x => x.node),
      changes,
      conclusion: buildConclusion(changes),
      rawTimeline: req.query.raw === 'true' ? sorted : undefined,
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message, key, date });
  }
};
