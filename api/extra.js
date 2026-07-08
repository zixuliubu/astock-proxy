const https = require('https');

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data.replace(/^jQuery\d*_?\(/, '').replace(/\);?$/, ''))); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () {
      this.destroy(); reject(new Error('timeout'));
    });
  });
}

function normalizeNewsItem(item, source) {
  return {
    source,
    title: item.title || item.brief || item.content || item.summary || '',
    content: item.content || item.summary || item.digest || item.brief || '',
    time: item.time || item.ctime || item.showTime || item.show_time || item.pub_time || '',
    url: item.url || item.shareurl || item.share_url || '',
    tags: item.tags || item.subjects || [],
  };
}

async function fetchEastmoneyFastNews() {
  const url = `https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&pageSize=30&_=${Date.now()}`;
  const data = await fetchJson(url, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://kuaixun.eastmoney.com/' });
  const rows = data?.data?.fastNewsList || data?.data || [];
  return rows.map(x => normalizeNewsItem(x, 'eastmoney')).filter(x => x.title || x.content);
}

async function fetchClsTelegraph() {
  const url = `https://www.cls.cn/nodeapi/telegraphList?app=CailianpressWeb&category=&lastTime=&last_time=&os=web&rn=30&sv=8.4.6&_=${Date.now()}`;
  const data = await fetchJson(url, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cls.cn/telegraph' });
  const rows = data?.data?.roll_data || data?.data || [];
  return rows.map(x => normalizeNewsItem(x, 'cls')).filter(x => x.title || x.content);
}

function scoreCatalyst(text) {
  const t = String(text || '');
  const keys = ['AI', '算力', '机器人', '半导体', '芯片', '创新药', '医药', '固态电池', '低空经济', '光伏', '锂电', '涨价', '订单', '并购', '重组', '政策', '关税', '出口', '业绩', '预增'];
  return keys.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
}

async function newsCatalysts() {
  const [em, cls] = await Promise.all([
    fetchEastmoneyFastNews().catch(e => ({ error: e.message })),
    fetchClsTelegraph().catch(e => ({ error: e.message })),
  ]);
  const items = [];
  if (Array.isArray(em)) items.push(...em);
  if (Array.isArray(cls)) items.push(...cls);
  const scored = items.map(x => ({ ...x, catalystScore: scoreCatalyst(`${x.title} ${x.content}`) })).sort((a, b) => (b.catalystScore || 0) - (a.catalystScore || 0));
  return {
    success: true,
    count: scored.length,
    data: scored.slice(0, 50),
    sourceStatus: { eastmoney: Array.isArray(em) ? 'ok' : em, cls: Array.isArray(cls) ? 'ok' : cls },
    note: '消息接口用于复盘催化线索，不作为硬盘口主源；若源站变更导致为空，需要更换新闻源。',
    updateTime: new Date().toISOString(),
  };
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function dragonTigerList(date) {
  const tradeDate = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : todayISO();
  const params = new URLSearchParams({
    sortColumns: 'TRADE_DATE,SECURITY_CODE',
    sortTypes: '-1,1',
    pageSize: '100',
    pageNumber: '1',
    reportName: 'RPT_DAILYBILLBOARD_DETAILS',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(TRADE_DATE='${tradeDate}')`,
    _: String(Date.now()),
  });
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`;
  const data = await fetchJson(url, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' });
  const rows = data?.result?.data || [];
  const mapped = rows.map(r => ({
    tradeDate: r.TRADE_DATE,
    code: r.SECURITY_CODE,
    name: r.SECURITY_NAME_ABBR,
    close: Number(r.CLOSE_PRICE || 0),
    changePct: Number(r.CHANGE_RATE || 0),
    reason: r.EXPLAIN || r.BILLBOARD_TYPE || '',
    buyAmount: Number(r.BUY_AMT || 0),
    sellAmount: Number(r.SELL_AMT || 0),
    netAmount: Number(r.BILLBOARD_NET_AMT || 0),
    turnover: Number(r.TURNOVERRATE || 0),
    amount: Number(r.AMOUNT || 0),
  }));
  const sorted = [...mapped].sort((a, b) => Math.abs(b.netAmount || 0) - Math.abs(a.netAmount || 0));
  return {
    success: true,
    count: mapped.length,
    data: sorted,
    summary: {
      topNetBuy: [...mapped].sort((a, b) => (b.netAmount || 0) - (a.netAmount || 0)).slice(0, 10),
      topNetSell: [...mapped].sort((a, b) => (a.netAmount || 0) - (b.netAmount || 0)).slice(0, 10),
    },
    note: '龙虎榜明细通常在盘后更新；席位级机构/游资拆解需要后续增加个股明细接口。',
    updateTime: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const type = String(req.query.type || 'news');
    const data = type === 'dragon' ? await dragonTigerList(String(req.query.date || '')) : await newsCatalysts();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message, type: req.query.type || 'news' });
  }
};
