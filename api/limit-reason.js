const { json, setCors, cached, okBase } = require('./_stock-utils');

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

function sourceRows(limitUpPool, key) {
  const rows = limitUpPool?.[key]?.data;
  return Array.isArray(rows) ? rows : [];
}

function selectPoolItems(limitUpPool) {
  const sources = [
    ['xuangubao', sourceRows(limitUpPool, 'xuangubao')],
    ['push2ex', sourceRows(limitUpPool, 'push2ex')],
    ['eastmoney', sourceRows(limitUpPool, 'eastmoney')],
    ['limitUpPool', limitUpPool?.limitUpPool?.top],
    ['data', limitUpPool?.data],
  ];
  const sourceCounts = Object.fromEntries(sources.map(([source, rows]) => [source, Array.isArray(rows) ? rows.length : 0]));
  const selected = sources.find(([, rows]) => Array.isArray(rows) && rows.length > 0);
  return { source: selected?.[0] || 'none', items: selected?.[1] || [], sourceCounts };
}

function normalizePoolItem(x = {}) {
  return {
    code: cleanCode(x.code || x.symbol),
    name: x.name || x.stockName || '',
    continuousBoards: x.continuousBoards,
    firstLimitUpTime: x.firstLimitUpTime,
    industry: x.industry || '',
    reason: x.reason || '',
    source: x.source || '',
    sourceRaw: x,
  };
}

function inferTheme(item, conceptMap = {}) {
  const tags = conceptMap[item.code]?.conceptTags || [];
  const directReason = String(item.reason || '').trim();
  const industry = item.industry || '';
  const evidence = [];
  if (directReason) evidence.push({ source: 'limit_pool', kind: 'direct_reason', text: directReason });
  if (industry) evidence.push({ source: 'industry', kind: 'context_only', text: industry });
  if (tags.length) evidence.push({ source: 'concepts', kind: 'context_only', text: tags.slice(0, 8).join(' / ') });
  const reasonStatus = directReason ? 'confirmed' : 'pending_confirmation';
  return {
    theme: directReason || '原因待确认',
    reason: directReason || '原因待确认',
    directReason,
    reasonStatus,
    evidence,
  };
}

function buildReasonRows(items, conceptMap = {}, newsMap = {}) {
  return items.map(item => {
    const { theme, reason, directReason, reasonStatus, evidence } = inferTheme(item, conceptMap);
    const catalysts = take(newsMap[item.code]?.topCatalysts, 3).map(c => ({ title: c.title, time: c.time, source: c.source, catalystScore: c.catalystScore }));
    return {
      code: item.code,
      name: item.name,
      continuousBoards: item.continuousBoards,
      firstLimitUpTime: item.firstLimitUpTime,
      theme,
      reason,
      directReason,
      reasonStatus,
      industry: item.industry || '',
      conceptTags: take(conceptMap[item.code]?.conceptTags, 10),
      evidence: catalysts.length ? [...evidence, { source: 'news_announcements', kind: 'context_only', text: catalysts.map(x => x.title).join(' / ') }] : evidence,
      catalysts,
    };
  });
}

function detectDataAnomaly(poolCount, resultCount) {
  if (poolCount > 0 && resultCount === 0) {
    return {
      code: 'LIMIT_REASON_EMPTY_WITH_NONEMPTY_POOL',
      level: 'DATA_ANOMALY',
      message: `涨停池有${poolCount}只，但涨停原因结果为0只，请检查股票代码标准化和原因聚合器。`,
    };
  }
  return null;
}

async function handler(req, res) {
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
      const poolLimit = explicit.length ? 100 : max;
      const limitUp = await fetchLocal('/api/limit-up', { date, top: poolLimit }, 15000);
      const pool = selectPoolItems(limitUp);
      const rawItems = pool.items.map(normalizePoolItem).filter(x => x.code);
      const items = explicit.length ? rawItems.filter(x => explicit.includes(x.code)) : take(rawItems, max);
      const symbols = items.map(x => x.code).slice(0, Math.min(max, 30)).join(',');
      const [concepts, news] = await Promise.all([
        symbols ? fetchLocal('/api/stock-concepts', { symbols }, 12000) : Promise.resolve({ success: true, data: [] }),
        includeNews && symbols ? fetchLocal('/api/stock-news', { symbols: items.slice(0, 8).map(x => x.code).join(','), include: 'all', pageSize: 3 }, 12000) : Promise.resolve({ success: true, data: [] }),
      ]);
      const conceptMap = Object.fromEntries((concepts.data || []).map(x => [x.code, x]));
      const newsMap = Object.fromEntries((news.data || []).map(x => [x.code, x.summary || {}]));
      const data = buildReasonRows(items, conceptMap, newsMap);
      const dataAnomaly = detectDataAnomaly(pool.items.length, data.length);
      return {
        date,
        poolSource: pool.source,
        poolCount: pool.items.length,
        sourceCounts: pool.sourceCounts,
        dataAnomaly,
        sourceStatus: {
          limitUp: limitUp.success !== false,
          concepts: concepts.success !== false,
          news: news.success !== false || !includeNews,
          dataAnomaly: dataAnomaly || null,
        },
        data,
      };
    });

    return json(res, 200, okBase({
      success: !value.dataAnomaly,
      status: value.dataAnomaly ? 'DATA_ANOMALY' : 'OK',
      mode: 'limit_reason_v2',
      date,
      cached: fromCache,
      count: value.data.length,
      poolSource: value.poolSource,
      poolCount: value.poolCount,
      sourceCounts: value.sourceCounts,
      pendingReasonCount: value.data.filter(item => item.reasonStatus === 'pending_confirmation').length,
      includeNews,
      data: value.data,
      sourceStatus: value.sourceStatus,
      limits: { maxStocks: 50, defaultTop: 30, redisWrites: 0 },
      note: '涨停原因只使用涨停池直接原因作为当日原因；行业、概念和新闻公告仅作上下文证据。无直接原因时保留股票并标记 reasonStatus=pending_confirmation。',
    }));
  } catch (err) {
    return json(res, 500, { success: false, mode: 'limit_reason_v2', date, error: String(err && err.message ? err.message : err), updateTime: new Date().toISOString() });
  }
}

module.exports = handler;
module.exports.selectPoolItems = selectPoolItems;
module.exports.normalizePoolItem = normalizePoolItem;
module.exports.inferTheme = inferTheme;
module.exports.buildReasonRows = buildReasonRows;
module.exports.detectDataAnomaly = detectDataAnomaly;
