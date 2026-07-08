const { json, setCors, buildUrl, requestJson, okBase, num } = require('./_stock-utils');

const BASE = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';

function take(arr, n) { return Array.isArray(arr) ? arr.slice(0, n) : []; }
function cleanCode(x) { const m = String(x || '').match(/(\d{6})/); return m ? m[1] : ''; }
function splitSymbols(v, max = 8) { return [...new Set(String(v || '').split(/[，,\s]+/).map(cleanCode).filter(Boolean))].slice(0, max); }

async function fetchLocal(path, query = {}, timeoutMs = 10000) {
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

function pickWatchRows(watchlist, symbols) {
  const rows = Array.isArray(watchlist?.data) ? watchlist.data : [];
  const explicit = splitSymbols(symbols, 8);
  if (explicit.length) {
    const map = Object.fromEntries(rows.map(x => [cleanCode(x.code || x.symbol), x]));
    return explicit.map(code => ({ code, ...(map[code] || {}) })).slice(0, 8);
  }
  return take(rows, 8).map(x => ({ ...x, code: cleanCode(x.code || x.symbol) })).filter(x => x.code);
}

function flowMap(flow) {
  return Object.fromEntries((flow?.data || []).map(x => [x.code, x]));
}
function conceptMap(concepts) {
  return Object.fromEntries((concepts?.data || []).map(x => [x.code, x]));
}

function numberFrom(row, keys) {
  for (const k of keys) {
    const v = row && row[k];
    const n = num(v);
    if (n !== null) return n;
  }
  return null;
}

function classify(row, concept, flow, context) {
  const code = row.code;
  const name = row.name || row.stockName || row.shortName || '';
  const changePct = numberFrom(row, ['changePct', 'pct', '涨跌幅', 'zdf']);
  const amountYi = numberFrom(row, ['amountYi', 'amount', '成交额']);
  const mainNetYi = flow?.minute?.summary?.totalMainYi ?? flow?.daily?.summary?.totalMainYi ?? null;
  const flowBias = flow?.minute?.summary?.bias || flow?.daily?.summary?.bias || 'unknown';
  const tags = concept?.conceptTags || [];

  const labels = [];
  const reasons = [];
  const triggers = [];
  const invalids = [];

  if (context === 'intraday' || context === 'new') {
    labels.push('盘中新增');
    reasons.push('由盘中数据触发，需要说明新增原因和用途，不能包装成盘前核心。');
  } else {
    labels.push('盘前固定/观察池');
  }

  if (amountYi !== null && amountYi >= 20) {
    labels.push('风向标A');
    reasons.push('成交额较大，适合作为板块容量核心/中军确认。');
    triggers.push('放量上行且板块涨停家数增加');
    invalids.push('放量滞涨或跌破分时/5日趋势');
  } else {
    labels.push('确认用');
    reasons.push('用于验证题材归属、板块扩散或情绪强弱。');
  }

  if ((changePct !== null && changePct >= 3) && (flowBias === 'inflow' || mainNetYi === null || mainNetYi > 0)) {
    labels.push('可参与观察B');
    reasons.push('涨幅和资金承接较好，但仍需板块共振确认。');
    triggers.push('分歧后重新走强、回封、或中军同步加强');
    invalids.push('冲高回落、资金流转负、板块无新增助攻');
  }

  if ((changePct !== null && changePct <= -4) || flowBias === 'outflow') {
    labels.push('风险锚');
    reasons.push('价格或资金流偏弱，可用于观察负反馈是否扩散。');
    invalids.push('若继续走弱，相关方向降级删除');
  }

  if (labels.includes('风险锚') && !labels.includes('可参与观察B')) {
    labels.push('降级删除候选');
    reasons.push('弱势信号未修复前，不纳入主攻。');
  }

  return {
    code,
    name,
    labels: [...new Set(labels)],
    reasons,
    triggers: [...new Set(triggers)],
    invalids: [...new Set(invalids)],
    metrics: { changePct, amountYi, mainNetYi, flowBias, conceptTags: take(tags, 10) },
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const group = req.query.group || 'default';
  const symbols = req.query.symbols || '';
  const context = ['pre', 'intraday', 'new'].includes(req.query.context) ? req.query.context : 'pre';
  const light = req.query.light === 'true';
  const diagnostics = {};

  try {
    const watchlist = await fetchLocal('/api/watchlist', symbols ? { symbols } : { group }, 10000);
    if (watchlist?.success === false) diagnostics.watchlist = watchlist.error || 'watchlist failed';
    const rows = pickWatchRows(watchlist, symbols);
    const selected = rows.map(x => x.code).filter(Boolean).slice(0, 8);
    let concepts = { success: true, data: [] };
    let flow = { success: true, data: [] };
    if (!light && selected.length) {
      [concepts, flow] = await Promise.all([
        fetchLocal('/api/stock-concepts', { symbols: selected.join(',') }, 10000),
        fetchLocal('/api/stock-capital-flow', { symbols: selected.slice(0, 6).join(','), range: 'minute' }, 11000),
      ]);
      if (concepts?.success === false) diagnostics.concepts = concepts.error || 'concepts failed';
      if (flow?.success === false) diagnostics.flow = flow.error || 'flow failed';
    }
    const cMap = conceptMap(concepts);
    const fMap = flowMap(flow);
    const data = rows.map(row => classify(row, cMap[row.code], fMap[row.code], context));
    return json(res, 200, okBase({
      mode: 'watchlist_auto_label_v1',
      group,
      context,
      light,
      selectedSymbols: selected,
      count: data.length,
      data,
      diagnostics,
      limits: { maxSymbols: 8, flowMaxSymbols: light ? 0 : 6, redisWrites: 0 },
      note: '自动标签只做观察池管理：盘前固定、盘中新增、确认用、可参与观察、风险锚、降级删除。不是买卖建议。',
    }));
  } catch (err) {
    return json(res, 500, { success: false, mode: 'watchlist_auto_label_v1', error: String(err && err.message ? err.message : err), diagnostics, updateTime: new Date().toISOString() });
  }
};
