const { json, setCors, buildUrl, requestJson, cached, okBase } = require('./_stock-utils');

const BASE = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';

function chinaDate() {
  const p = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  return `${p.year}${p.month}${p.day}`;
}

function normalizeDate(date) { return String(date || chinaDate()).replace(/-/g, ''); }
function take(arr, n) { return Array.isArray(arr) ? arr.slice(0, n) : []; }
function cleanCode(x) { const m = String(x || '').match(/(\d{6})/); return m ? m[1] : ''; }
function splitSymbols(v, max = 30) { return [...new Set(String(v || '').split(/[，,\s]+/).map(cleanCode).filter(Boolean))].slice(0, max); }

async function fetchLocal(path, query = {}, timeoutMs = 12000) {
  const url = new URL(path, BASE);
  Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url.toString(), { headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { return { success: false, raw: text }; }
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally { clearTimeout(timeout); }
}

function poolItems(limitUpPool) {
  const p = limitUpPool || {};
  return p?.xuangubao?.data || p?.push2ex?.data || p?.eastmoney?.data || p?.limitUpPool?.top || p?.data || [];
}

function inferTheme(item, conceptMap) {
  const tags = conceptMap[item.code]?.conceptTags || [];
  const reason = String(item.reason || '');
  const industry = item.industry || '';
  const evidence = [];
  if (reason) evidence.push({ source: 'limit_pool', text: reason });
  if (industry) evidence.push({ source: 'industry', text: industry });
  if (tags.length) evidence.push({ source: 'concepts', text: tags.slice(0, 8).join(' / ') });
  const theme = reason || tags.slice(0, 3).join(' / ') || industry || '待确认';
  return { theme, evidence };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const date = normalizeDate(req.query.date);
  const max = Math.min(Math.max(Number(req.query.top || req.query.max || 30), 1), 50);
  const includeNews = req.query.includeNews === 'true';
  const ttlMs = Number(req.query.ttlMs || 3 * 60 * 1000);
  const explicit = splitSymbols(req.query.symbols || '', max);
  const key = `limit-reason:${date}:${max}:${includeNews}:${explicit.join('-')}`;

  try {
    const { value, cached: fromCache } = await cached(key, ttlMs, async () => {
      const limitUp = await fetchLocal('/api/limit-up', { date }, 15000);
      let items = take(poolItems(limitUp), max).map(x => ({
        code: cleanCode(x.code || x.symbol),
        name: x.name || x.stockName || '',
        continuousBoards: x.continuousBoards,
        firstLimitUpTime: x.firstLimitUpTime,
        industry: x.industry,
        reason: x.reason,
        sourceRaw: x,
      })).filter(x => x.code);
      if (explicit.length) items = items.filter(x => explicit.includes(x.code));
      const symbols = items.map(x => x.code).slice(0, Math.min(max, 30)).join(',');
      const [concepts, news] = await Promise.all([
        symbols ? fetchLocal('/api/stock-concepts', { symbols }, 12000) : Promise.resolve({ success: true, data: [] }),
        includeNews && symbols ? fetchLocal('/api/stock-news', { symbols: items.slice(0, 8).map(x => x.code).join(','), include: 'all', pageSize: 3 }, 12000) : Promise.resolve({ success: true, data: [] }),
      ]);
      const conceptMap = Object.fromEntries((concepts.data || []).map(x => [x.code, x]));
      const newsMap = Object.fromEntries((news.data || []).map(x => [x.code, x.summary || {}]));
      const data = items.map(item => {
        const { theme, evidence } = inferTheme(item, conceptMap);
        const catalysts = take(newsMap[item.code]?.topCatalysts, 3).map(c => ({ title: c.title, time: c.time, source: c.source, catalystScore: c.catalystScore }));
        return {
          code: item.code,
          name: item.name,
          continuousBoards: item.continuousBoards,
          firstLimitUpTime: item.firstLimitUpTime,
          theme,
          reason: item.reason || '',
          industry: item.industry || '',
          conceptTags: take(conceptMap[item.code]?.conceptTags, 10),
          evidence: catalysts.length ? [...evidence, { source: 'news_announcements', text: catalysts.map(x => x.title).join(' / ') }] : evidence,
          catalysts,
        };
      });
      return { date, sourceStatus: { limitUp: limitUp.success !== false, concepts: concepts.success !== false, news: news.success !== false || !includeNews }, data };
    });

    return json(res, 200, okBase({ mode: 'limit_reason_v1', date, cached: fromCache, count: value.data.length, includeNews, data: value.data, sourceStatus: value.sourceStatus, limits: { maxStocks: 50, defaultTop: 30, redisWrites: 0 }, note: '涨停原因归因增强会合并涨停池原因、行业、概念标签和可选新闻公告；若来源冲突，以盘口涨停池为主，概念/新闻只作证据补充。' }));
  } catch (err) {
    return json(res, 500, { success: false, mode: 'limit_reason_v1', date, error: String(err && err.message ? err.message : err), updateTime: new Date().toISOString() });
  }
};
