const https = require('https');

const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';
const NODES = ['09:35', '09:45', '09:55', '10:05', '10:15', '10:25', '10:35', '10:45', '10:55', '11:05', '11:15', '11:25', '13:05', '13:15', '13:25', '13:35', '13:45', '13:55', '14:05', '14:15', '14:25', '14:35', '14:45', '14:55', '15:00'];

function fetchJson(pathOrUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${ASTOCK_BASE_URL}${pathOrUrl}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, timeout: 12000 }, (res) => {
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

function chinaTime() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(now).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function nearestNode(timeStr) {
  const hm = timeStr.slice(11, 16);
  let current = null;
  let next = null;
  for (const n of NODES) {
    if (hm >= n) current = n;
    else if (!next) next = n;
  }
  return { currentNode: current, nextNode: next, allNodes: NODES };
}

function briefFromData(snapshot) {
  const sentiment = snapshot.sentiment?.sentiment || null;
  const ladder = snapshot.ladder?.ladder || null;
  const overview = snapshot.overview?.overview || null;
  return {
    marketLabel: overview?.label || sentiment?.label || '待确认',
    turnoverYi: overview?.turnoverYi ?? null,
    limitUp: sentiment?.limitUp ?? null,
    limitDown: sentiment?.limitDown ?? null,
    brokenCount: sentiment?.brokenCount ?? null,
    maxBoard: ladder?.maxBoard ?? null,
    boardDistribution: ladder?.distribution || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const nowCN = chinaTime();
  const nodeInfo = nearestNode(nowCN);
  try {
    const [overview, sentiment, ladder, sectors] = await Promise.all([
      fetchJson('/api/market-overview').catch(e => ({ success: false, error: e.message })),
      fetchJson('/api/sentiment').catch(e => ({ success: false, error: e.message })),
      fetchJson('/api/lianban-ladder').catch(e => ({ success: false, error: e.message })),
      fetchJson('/api/sector').catch(e => ({ success: false, error: e.message })),
    ]);
    const snapshot = { overview, sentiment, ladder, sectors };
    return res.status(200).json({
      success: true,
      mode: 'stateless_snapshot_v1',
      chinaTime: nowCN,
      ...nodeInfo,
      snapshot,
      brief: briefFromData(snapshot),
      limitation: '当前版本返回请求时刻快照；10分钟级真实时间线由 capture-node + intraday-timeline 保存和读取。',
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
