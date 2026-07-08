const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
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

async function fetchJson(path, query = {}, timeoutMs = 12000) {
  const url = new URL(path, ASTOCK_BASE_URL);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
    if (!response.ok) return { success: false, status: response.status, error: `HTTP ${response.status}`, url: safeUrlString(url), data };
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

function cleanCode(input) {
  const match = String(input || '').match(/(\d{6})/);
  return match ? match[1] : '';
}

function uniqueCodes(values, max = 8) {
  const out = [];
  for (const v of values || []) {
    const code = cleanCode(typeof v === 'string' ? v : (v && (v.code || v.symbol || v.stockCode || v.secuCode)));
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= max) break;
  }
  return out;
}

function selectCoreSymbols(bundle, explicitSymbols) {
  const explicit = uniqueCodes(String(explicitSymbols || '').split(/[，,\s]+/), 8);
  if (explicit.length) return explicit;

  const watch = bundle.coreWatchlist || {};
  const fromWatch = uniqueCodes([
    ...(watch.topAmount || []),
    ...(watch.strongestSupport || []),
    ...(watch.data || []),
  ], 8);
  if (fromWatch.length) return fromWatch;

  const ladder = bundle.lianbanLadder || {};
  const fromLadder = uniqueCodes([...(ladder.highest || []), ...(ladder.board2 || [])], 8);
  if (fromLadder.length) return fromLadder;

  return uniqueCodes(bundle.limitUpPool?.top || [], 8);
}

function compactConcepts(resp) {
  return {
    success: resp?.success === true,
    source: resp?.source,
    count: resp?.count || 0,
    data: take(resp?.data, 8).map(x => ({
      code: x.code,
      total: x.total,
      conceptTags: take(x.conceptTags, 12),
      boards: take(x.boards, 12).map(b => ({ code: b.code, name: b.name, changePct: b.changePct, leadStock: b.leadStock })),
      cached: x.cached,
      error: x.error,
    })),
    diagnostics: resp?.diagnostics || {},
  };
}

function compactFlow(resp) {
  return {
    success: resp?.success === true,
    source: resp?.source,
    range: resp?.range,
    count: resp?.count || 0,
    data: take(resp?.data, 6).map(x => ({
      code: x.code,
      minute: x.minute ? { summary: x.minute.summary } : null,
      daily: x.daily ? { summary: x.daily.summary } : null,
      cached: x.cached,
      error: x.error,
    })),
    diagnostics: resp?.diagnostics || {},
    note: resp?.note,
  };
}

function compactNews(resp) {
  return {
    success: resp?.success === true,
    source: resp?.source,
    include: resp?.include,
    count: resp?.count || 0,
    data: take(resp?.data, 5).map(x => ({
      code: x.code,
      summary: {
        newsCount: x.summary?.newsCount || 0,
        announcementCount: x.summary?.announcementCount || 0,
        topCatalysts: take(x.summary?.topCatalysts, 5).map(c => ({
          source: c.source,
          title: c.title,
          type: c.type,
          time: c.time,
          catalystScore: c.catalystScore,
          content: String(c.content || '').slice(0, 140),
        })),
      },
      cached: x.cached,
      error: x.error,
    })),
    diagnostics: resp?.diagnostics || {},
    note: resp?.note,
  };
}

function compactPopularity(resp) {
  const data = resp?.data || {};
  return {
    success: resp?.success === true,
    source: resp?.source,
    period: resp?.period,
    top: resp?.top,
    count: resp?.count || {},
    data: {
      ths: take(data.ths, 20).map(x => ({ rank: x.rank, code: x.code, name: x.name, pct: x.pct, heat: x.heat, concepts: take(x.concepts, 5), tag: x.tag })),
      eastmoney: take(data.eastmoney, 20).map(x => ({ rank: x.rank, code: x.code, name: x.name, price: x.price, pct: x.pct, rankChg: x.rankChg })),
      hotConcepts: data.hotConcepts || {},
    },
    diagnostics: resp?.diagnostics || {},
    note: resp?.note,
  };
}

function buildDiagnostics(parts) {
  return Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, value?.success === false ? { ok: false, error: value.error, status: value.status } : { ok: true }]));
}

function appendReviewHints(bundle) {
  const hints = Array.isArray(bundle.reviewHints) ? [...bundle.reviewHints] : [];
  const selected = bundle.extraSignals?.selectedSymbols || [];
  if (selected.length) hints.push(`增强信号：已对核心票 ${selected.join(',')} 补充概念、资金流、新闻公告和人气验证。`);
  if (bundle.extraSignals?.stockPopularity?.data?.ths?.length) hints.push('人气榜：用于验证散户关注度、踏空资金和热度扩散，不作为买入依据。');
  return hints;
}

async function buildPlus(req) {
  const date = req.query.date;
  const group = req.query.group || 'default';
  const symbols = req.query.symbols;
  const raw = req.query.raw === 'true' ? 'true' : undefined;
  const extra = req.query.extra !== 'false';

  const base = await fetchJson('/api/daily-review-bundle', { date, group, symbols, raw }, 20000);
  if (!extra || base?.success === false) return base;

  const selected = selectCoreSymbols(base, symbols);
  const conceptSymbols = selected.slice(0, 8).join(',');
  const flowSymbols = selected.slice(0, 6).join(',');
  const newsSymbols = selected.slice(0, 5).join(',');

  const [stockConcepts, stockCapitalFlow, stockNews, stockPopularity] = await Promise.all([
    conceptSymbols ? fetchJson('/api/stock-concepts', { symbols: conceptSymbols }, 10000) : Promise.resolve({ success: true, data: [] }),
    flowSymbols ? fetchJson('/api/stock-capital-flow', { symbols: flowSymbols, range: 'minute' }, 11000) : Promise.resolve({ success: true, data: [] }),
    newsSymbols ? fetchJson('/api/stock-news', { symbols: newsSymbols, include: 'all', pageSize: 5 }, 12000) : Promise.resolve({ success: true, data: [] }),
    fetchJson('/api/stock-popularity', { top: 30, source: 'both', symbols: selected.slice(0, 5).join(',') }, 10000),
  ]);

  const plus = {
    ...base,
    mode: 'daily_review_bundle_plus_v1',
    extraSignals: {
      enabled: true,
      limits: {
        conceptsMaxSymbols: 8,
        capitalFlowMaxSymbols: 6,
        newsMaxSymbols: 5,
        newsPageSize: 5,
        popularityTop: 30,
        redisWrites: 0,
      },
      selectedSymbols: selected,
      stockConcepts: compactConcepts(stockConcepts),
      stockCapitalFlow: compactFlow(stockCapitalFlow),
      stockNews: compactNews(stockNews),
      stockPopularity: compactPopularity(stockPopularity),
      diagnostics: buildDiagnostics({ stockConcepts, stockCapitalFlow, stockNews, stockPopularity }),
    },
  };
  plus.reviewHints = appendReviewHints(plus);
  plus.diagnostics = { ...(base.diagnostics || {}), extraSignals: plus.extraSignals.diagnostics };
  plus.updateTime = new Date().toISOString();
  return plus;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  try {
    const value = await buildPlus(req);
    return json(res, 200, value);
  } catch (e) {
    return json(res, 500, { success: false, mode: 'daily_review_bundle_plus_v1', error: e.message, updateTime: new Date().toISOString() });
  }
};
