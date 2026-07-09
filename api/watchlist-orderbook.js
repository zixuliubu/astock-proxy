const { json, setCors, parseSymbols, cleanCode, okBase, cached } = require('./_stock-utils');

const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';

const DEFAULT_GROUPS = {
  default: ['600584', '002185', '002407', '600793'],
  semiconductor: ['600584', '002185', '688981', '002371', '603986', '600460', '300782'],
  robot: ['300124', '002031', '002527', '688017', '300024', '002698'],
  ai_compute: ['601138', '000977', '603019', '300308', '300502', '688041'],
  innovation_drug: ['600276', '688235', '688180', '688266', '300558'],
  fluorochemical: ['002407', '002326', '600160', '002709'],
  paper: ['600793', '600103', '002511', '600308'],
  market_core: ['600519', '601318', '600036', '601398', '600030', '300750'],
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function resolveSymbols(req) {
  const fromQuery = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 8);
  if (fromQuery.length) return { symbols: fromQuery, source: 'query' };
  const group = String(req.query.group || 'default');
  const groupSymbols = DEFAULT_GROUPS[group] || DEFAULT_GROUPS.default;
  return { symbols: groupSymbols.map(cleanCode).filter(Boolean).slice(0, 8), source: `group:${group}` };
}

function labelRole(item) {
  const score = item && item.strength ? Number(item.strength.score) : null;
  const changePct = Number(item && item.changePct);
  const amountYi = Number(item && item.amountYi);
  if (Number.isFinite(score) && score >= 80) return '强承接';
  if (Number.isFinite(score) && score >= 65) return '可参与观察';
  if (Number.isFinite(score) && score < 35) return '风险锚';
  if (Number.isFinite(changePct) && changePct >= 6 && Number.isFinite(amountYi) && amountYi >= 5) return '确认用';
  return '观察';
}

function buildSummary(data) {
  const valid = data.filter(x => x && x.name && x.strength);
  const byScore = [...valid].sort((a, b) => (b.strength.score || 0) - (a.strength.score || 0));
  const byAmount = [...valid].sort((a, b) => (b.amountYi || 0) - (a.amountYi || 0));
  const strong = byScore.filter(x => (x.strength.score || 0) >= 65).slice(0, 5);
  const weak = [...valid].filter(x => (x.strength.score || 0) < 45).sort((a, b) => (a.strength.score || 0) - (b.strength.score || 0)).slice(0, 5);
  const roles = valid.map(x => ({
    code: x.code,
    name: x.name,
    price: x.price,
    changePct: x.changePct,
    amountYi: x.amountYi,
    pressureRatio: x.pressureRatio,
    strength: x.strength,
    role: labelRole(x),
  }));
  return {
    strongest: strong,
    weakest: weak,
    topAmount: byAmount.slice(0, 5),
    roles,
    conclusion: strong.length
      ? `观察池中 ${strong.map(x => x.name).join('、')} 盘口相对更强。`
      : '观察池暂未出现明显强承接票。',
  };
}

async function fetchOrderbook(symbols, ttlMs, compare) {
  const url = new URL('/api/orderbook-lite', ASTOCK_BASE_URL);
  url.searchParams.set('symbols', symbols.join(','));
  url.searchParams.set('ttlMs', String(ttlMs));
  if (compare) url.searchParams.set('compare', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
    if (!response.ok) return { success: false, error: `orderbook-lite HTTP ${response.status}`, data };
    return data;
  } catch (err) {
    return { success: false, error: err && err.name === 'AbortError' ? 'orderbook-lite timeout' : String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const group = String(req.query.group || 'default');
  const { symbols, source } = resolveSymbols(req);
  const ttlMs = clamp(Number(req.query.ttlMs || 5000) || 5000, 1000, 10000);
  const compare = String(req.query.compare || 'true').toLowerCase() !== 'false';
  const cacheKey = `watchlist-orderbook:v1:${group}:${symbols.join(',')}:ttl=${ttlMs}:compare=${compare}`;

  try {
    const { value, cached: cacheHit } = await cached(cacheKey, ttlMs, async () => {
      const ob = await fetchOrderbook(symbols, ttlMs, compare);
      const data = Array.isArray(ob.data) ? ob.data : [];
      return okBase({
        mode: 'watchlist_orderbook_v1',
        group,
        source,
        symbols,
        count: data.length,
        ttlMs,
        compare,
        orderbookSuccess: ob.success !== false,
        data,
        summary: buildSummary(data),
        upstream: {
          mode: ob.mode,
          cacheHit: ob.cacheHit,
          error: ob.error,
        },
        note: '观察池盘口聚合：只查指定观察池/自定义 symbols，最多8只；用于盘前固定池、盘中新增、打板票、趋势票的盘口确认。',
        limits: {
          maxSymbols: 8,
          defaultTtlMs: 5000,
          minTtlMs: 1000,
          maxTtlMs: 10000,
        },
      });
    });
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({
      success: false,
      mode: 'watchlist_orderbook_v1',
      group,
      symbols,
      error: String(err && err.message ? err.message : err),
      data: [],
      summary: buildSummary([]),
    }));
  }
};
