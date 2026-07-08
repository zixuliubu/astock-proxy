const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';
const CAPTURE_SECRET = process.env.CAPTURE_SECRET;
const CACHE_TTL_MS = Number(process.env.REVIEW_BUNDLE_CACHE_TTL_MS || 60 * 1000);

const memoryCache = global.__ASTOCK_REVIEW_BUNDLE_CACHE__ || new Map();
global.__ASTOCK_REVIEW_BUNDLE_CACHE__ = memoryCache;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function chinaDate() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}${parts.month}${parts.day}`;
}

function normalizeDate(date) {
  return String(date || chinaDate()).replace(/-/g, '');
}

function safeUrlString(url) {
  try {
    const safe = new URL(url.toString());
    if (safe.searchParams.has('token')) safe.searchParams.set('token', '[redacted]');
    return safe.toString();
  } catch (err) {
    return '[unavailable]';
  }
}

async function fetchJson(path, query = {}, timeoutMs = 15000) {
  const url = new URL(path, ASTOCK_BASE_URL);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
    if (!response.ok) {
      return { success: false, status: response.status, error: `HTTP ${response.status}`, url: safeUrlString(url), data };
    }
    return data;
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err), url: safeUrlString(url) };
  } finally {
    clearTimeout(timeout);
  }
}

function take(arr, n) {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

function firstAvailable(...values) {
  return values.find(v => v !== undefined && v !== null);
}

function compactLimitPool(pool) {
  const primary = pool?.xuangubao?.data || pool?.push2ex?.data || pool?.eastmoney?.data || [];
  return {
    success: pool?.success === true,
    count: firstAvailable(pool?.xuangubao?.count, pool?.push2ex?.count, pool?.eastmoney?.count, 0),
    top: take(primary, 30).map(x => ({
      code: x.code,
      name: x.name,
      continuousBoards: x.continuousBoards,
      firstLimitUpTime: x.firstLimitUpTime,
      industry: x.industry,
      reason: x.reason,
      changePct: x.changePct,
    })),
  };
}

function compactRiskPool(pool) {
  const primary = pool?.xuangubao?.data || pool?.push2ex?.data || [];
  return {
    success: pool?.success === true,
    count: firstAvailable(pool?.xuangubao?.count, pool?.push2ex?.count, 0),
    top: take(primary, 30).map(x => ({
      code: x.code,
      name: x.name,
      continuousBoards: x.continuousBoards,
      limitDownDays: x.limitDownDays,
      industry: x.industry,
      reason: x.reason,
      changePct: x.changePct,
      breakTime: x.breakTime,
    })),
  };
}

function compactLadder(ladderResponse) {
  const ladder = ladderResponse?.ladder || {};
  const boards = ladder.boards || {};
  const compactBoards = {};
  Object.keys(boards).sort((a, b) => Number(b) - Number(a)).forEach(board => {
    compactBoards[board] = take(boards[board], board === '1' ? 20 : 30).map(x => ({
      code: x.code,
      name: x.name,
      continuousBoards: x.continuousBoards,
      firstLimitUpTime: x.firstLimitUpTime,
      industry: x.industry,
      reason: x.reason,
    }));
  });
  return {
    success: ladderResponse?.success === true,
    total: ladder.total || 0,
    maxBoard: ladder.maxBoard || 0,
    distribution: ladder.distribution || {},
    highest: take(ladder.highest, 10).map(x => ({ code: x.code, name: x.name, continuousBoards: x.continuousBoards, industry: x.industry, reason: x.reason })),
    board3: take(ladder.board3, 20).map(x => ({ code: x.code, name: x.name, industry: x.industry, reason: x.reason })),
    board2: take(ladder.board2, 30).map(x => ({ code: x.code, name: x.name, industry: x.industry, reason: x.reason })),
    boards: compactBoards,
  };
}

function compactSectors(sectors) {
  return {
    success: sectors?.success === true,
    count: sectors?.count || 0,
    top: take(sectors?.data, 15).map(x => ({
      name: x.name || x.sector || x.title,
      changePct: x.changePct || x.zdf || x涨跌幅,
      amount: x.amount || x成交额,
      strength: x.strength || x.score || x强度,
      raw: x,
    })),
  };
}

function compactWatchlist(watchlist) {
  return {
    success: watchlist?.success === true,
    group: watchlist?.group,
    count: watchlist?.count || 0,
    topAmount: take(watchlist?.summary?.topAmount, 8),
    strongestSupport: take(watchlist?.summary?.strongestSupport, 8),
    weakestSupport: take(watchlist?.summary?.weakestSupport, 8),
    data: take(watchlist?.data, 20),
  };
}

function compactNews(news) {
  return {
    success: news?.success === true,
    count: news?.count || 0,
    top: take(news?.data, 12).map(x => ({
      source: x.source,
      title: x.title,
      content: String(x.content || '').slice(0, 160),
      time: x.time,
      catalystScore: x.catalystScore,
    })),
    sourceStatus: news?.sourceStatus,
  };
}

function compactDragonTiger(dt) {
  return {
    success: dt?.success === true,
    count: dt?.count || 0,
    topNetBuy: take(dt?.summary?.topNetBuy, 10),
    topNetSell: take(dt?.summary?.topNetSell, 10),
    note: dt?.note,
  };
}

function compactTimeline(timeline) {
  return {
    success: timeline?.success === true,
    date: timeline?.date,
    count: timeline?.count || 0,
    nodes: timeline?.nodes || [],
    changes: take(timeline?.changes, 8),
    conclusion: timeline?.conclusion,
  };
}

function buildDiagnostics(parts) {
  return Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, value?.success === false ? { ok: false, error: value.error, status: value.status } : { ok: true }]));
}

function buildReviewHints(bundle) {
  const sentiment = bundle.marketSentiment?.sentiment || bundle.marketOverview?.sentiment || {};
  const overview = bundle.marketOverview?.overview || {};
  const ladder = bundle.lianbanLadder || {};
  const risk = bundle.brokenLimitPool || {};
  const hints = [];

  hints.push(`大盘标签：${overview.label || '待确认'}；两市成交额近似 ${overview.turnoverYi ?? '未知'} 亿。`);
  hints.push(`情绪：涨停 ${sentiment.limitUp ?? '未知'}，跌停 ${sentiment.limitDown ?? '未知'}，炸板 ${sentiment.brokenCount ?? '未知'}，炸板率 ${sentiment.brokenRatio ?? '未知'}。`);
  hints.push(`连板：最高 ${ladder.maxBoard || 0} 板，分布 ${JSON.stringify(ladder.distribution || {})}。`);
  if ((risk.count || 0) > 0) hints.push(`风险：炸板池 ${risk.count} 只，重点看炸板方向是否集中。`);
  if ((bundle.intradayTimeline?.count || 0) > 1) hints.push(`盘中节点：已保存 ${bundle.intradayTimeline.count} 个节点，可做真实节点变化复盘。`);
  else hints.push('盘中节点：当前保存节点不足，盘中变化只能结合首封/炸板/连板结构推断。');
  return hints;
}

async function buildBundle(options) {
  const { date, group, symbols, includeRaw } = options;
  const timelineQuery = CAPTURE_SECRET ? { date, token: CAPTURE_SECRET } : { date };
  const watchQuery = symbols ? { symbols } : { group: group || 'default' };

  const [
    marketOverview,
    marketSentiment,
    lianbanLadder,
    limitUpPool,
    brokenLimitPool,
    limitDownPool,
    hotSectors,
    coreWatchlist,
    newsCatalysts,
    dragonTiger,
    intradayTimeline,
  ] = await Promise.all([
    fetchJson('/api/market-overview'),
    fetchJson('/api/sentiment'),
    fetchJson('/api/lianban-ladder', { date }),
    fetchJson('/api/limit-up', { date }),
    fetchJson('/api/broken-limit', { date }),
    fetchJson('/api/limit-down', { date }),
    fetchJson('/api/sector'),
    fetchJson('/api/watchlist', watchQuery),
    fetchJson('/api/news-catalysts'),
    fetchJson('/api/dragon-tiger', { date }),
    fetchJson('/api/intraday-timeline', timelineQuery),
  ]);

  const compact = {
    date,
    mode: 'daily_review_bundle_v1',
    cacheTtlMs: CACHE_TTL_MS,
    marketOverview: {
      success: marketOverview?.success === true,
      overview: marketOverview?.overview,
      indices: take(marketOverview?.indices, 6),
      sentiment: marketOverview?.sentiment,
    },
    marketSentiment: {
      success: marketSentiment?.success === true,
      sentiment: marketSentiment?.sentiment,
      boardDistribution: marketSentiment?.boardDistribution,
    },
    lianbanLadder: compactLadder(lianbanLadder),
    limitUpPool: compactLimitPool(limitUpPool),
    brokenLimitPool: compactRiskPool(brokenLimitPool),
    limitDownPool: compactRiskPool(limitDownPool),
    hotSectors: compactSectors(hotSectors),
    coreWatchlist: compactWatchlist(coreWatchlist),
    newsCatalysts: compactNews(newsCatalysts),
    dragonTiger: compactDragonTiger(dragonTiger),
    intradayTimeline: compactTimeline(intradayTimeline),
  };

  compact.reviewHints = buildReviewHints(compact);
  compact.diagnostics = buildDiagnostics({ marketOverview, marketSentiment, lianbanLadder, limitUpPool, brokenLimitPool, limitDownPool, hotSectors, coreWatchlist, newsCatalysts, dragonTiger, intradayTimeline });
  compact.updateTime = new Date().toISOString();

  if (includeRaw) {
    compact.raw = { marketOverview, marketSentiment, lianbanLadder, limitUpPool, brokenLimitPool, limitDownPool, hotSectors, coreWatchlist, newsCatalysts, dragonTiger, intradayTimeline };
  }

  return compact;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const date = normalizeDate(req.query.date);
  const group = req.query.group || 'default';
  const symbols = req.query.symbols;
  const includeRaw = req.query.raw === 'true';
  const cacheKey = JSON.stringify({ date, group, symbols: symbols || '', includeRaw });
  const now = Date.now();
  const cached = memoryCache.get(cacheKey);
  if (cached && now - cached.time < CACHE_TTL_MS) {
    return json(res, 200, { success: true, cached: true, ...cached.value });
  }

  try {
    const value = await buildBundle({ date, group, symbols, includeRaw });
    memoryCache.set(cacheKey, { time: now, value });
    if (memoryCache.size > 20) {
      const oldest = memoryCache.keys().next().value;
      memoryCache.delete(oldest);
    }
    return json(res, 200, { success: true, cached: false, ...value });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message, date, updateTime: new Date().toISOString() });
  }
};
