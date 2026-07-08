const { json, setCors, parseSymbols, buildUrl, requestJson, requestText, cached, okBase, stripHtml } = require('./_stock-utils');

let cninfoOrgMap = null;

async function eastmoneyStockNews(code, pageSize = 20) {
  const cb = 'jQuery_news';
  const inner = JSON.stringify({
    uid: '',
    keyword: code,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize, preTag: '', postTag: '' } },
  });
  const url = buildUrl('https://search-api-web.eastmoney.com/search/jsonp', { cb, param: inner });
  const data = await requestJson(url, { headers: { Referer: 'https://so.eastmoney.com/' }, timeoutMs: 12000 });
  const articles = data?.result?.cmsArticleWebOld || [];
  return (Array.isArray(articles) ? articles : []).map(a => ({
    source: a.mediaName || 'eastmoney',
    title: stripHtml(a.title),
    content: stripHtml(a.content).slice(0, 240),
    time: a.date || '',
    url: a.url || '',
  })).filter(x => x.title || x.content);
}

function cninfoDate(ts) {
  if (typeof ts === 'number') {
    try { return new Date(ts).toISOString().slice(0, 10); } catch (e) {}
  }
  return String(ts || '').slice(0, 10);
}

async function loadCninfoOrgMap() {
  if (cninfoOrgMap) return cninfoOrgMap;
  try {
    const data = await requestJson('http://www.cninfo.com.cn/new/data/szse_stock.json', { timeoutMs: 15000 });
    const rows = data?.stockList || [];
    cninfoOrgMap = Object.fromEntries(rows.map(x => [x.code, x.orgId]).filter(x => x[0] && x[1]));
  } catch (err) {
    cninfoOrgMap = {};
  }
  return cninfoOrgMap;
}

async function cninfoOrgId(code) {
  const map = await loadCninfoOrgMap();
  if (map[code]) return map[code];
  if (code.startsWith('6')) return `gssh0${code}`;
  if (code.startsWith('8') || code.startsWith('4')) return `gsbj0${code}`;
  return `gssz0${code}`;
}

async function cninfoAnnouncements(code, pageSize = 20) {
  const orgId = await cninfoOrgId(code);
  const form = new URLSearchParams({
    stock: `${code},${orgId}`,
    tabName: 'fulltext',
    pageSize: String(pageSize),
    pageNum: '1',
    column: '',
    category: '',
    plate: '',
    seDate: '',
    searchkey: '',
    secid: '',
    sortName: '',
    sortType: '',
    isHLtitle: 'true',
  });
  const text = await requestText('https://www.cninfo.com.cn/new/hisAnnouncement/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://www.cninfo.com.cn/new/disclosure',
      Origin: 'https://www.cninfo.com.cn',
    },
    body: form.toString(),
    timeoutMs: 15000,
  });
  const data = JSON.parse(text || '{}');
  const rows = data?.announcements || [];
  return (Array.isArray(rows) ? rows : []).map(a => ({
    source: 'cninfo',
    title: stripHtml(a.announcementTitle),
    type: a.announcementTypeName || '',
    time: cninfoDate(a.announcementTime),
    url: `https://www.cninfo.com.cn/new/disclosure/detail?annoId=${a.announcementId || ''}`,
  })).filter(x => x.title);
}

function catalystScore(item) {
  const text = `${item.title || ''} ${item.content || ''} ${item.type || ''}`;
  const keys = ['重组', '并购', '增持', '回购', '预增', '中标', '订单', '合作', '投资', '减持', '监管', '问询', '风险', '退市', '停牌', '复牌', '分红', '股权激励', 'AI', '算力', '机器人', '半导体', '创新药'];
  return keys.reduce((n, k) => n + (text.includes(k) ? 1 : 0), 0);
}

async function fetchForCode(code, pageSize, include) {
  const out = { code, news: [], announcements: [], summary: {} };
  const tasks = [];
  if (include === 'all' || include === 'news') tasks.push(eastmoneyStockNews(code, pageSize).then(x => { out.news = x; }).catch(e => { out.newsError = String(e.message || e); }));
  if (include === 'all' || include === 'announcements') tasks.push(cninfoAnnouncements(code, pageSize).then(x => { out.announcements = x; }).catch(e => { out.announcementsError = String(e.message || e); }));
  await Promise.all(tasks);
  const all = [...out.news, ...out.announcements].map(x => ({ ...x, catalystScore: catalystScore(x) })).sort((a, b) => (b.catalystScore || 0) - (a.catalystScore || 0));
  out.summary = {
    newsCount: out.news.length,
    announcementCount: out.announcements.length,
    topCatalysts: all.slice(0, 10),
  };
  return out;
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const symbols = parseSymbols(req.query.symbols || req.query.code || req.query.symbol, 5);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbols, e.g. ?symbols=600519,300750' });
  const include = ['all', 'news', 'announcements'].includes(req.query.include) ? req.query.include : 'all';
  const pageSize = Math.min(Math.max(Number(req.query.pageSize || 20), 1), 50);
  const ttlMs = Number(req.query.ttlMs || 5 * 60 * 1000);
  const diagnostics = {};
  const data = [];

  for (const code of symbols) {
    try {
      const { value, cached: fromCache } = await cached(`stock-news:${code}:${include}:${pageSize}`, ttlMs, () => fetchForCode(code, pageSize, include));
      data.push({ ...value, cached: fromCache });
    } catch (err) {
      diagnostics[code] = String(err && err.message ? err.message : err);
      data.push({ code, news: [], announcements: [], summary: { newsCount: 0, announcementCount: 0, topCatalysts: [] }, error: diagnostics[code] });
    }
  }

  return json(res, 200, okBase({
    mode: 'stock_news_v1',
    source: 'eastmoney_news_cninfo_announcements',
    include,
    pageSize,
    count: data.length,
    data,
    diagnostics,
    note: '新闻/公告只做消息催化验证，不作为硬盘口主源。',
  }));
};
