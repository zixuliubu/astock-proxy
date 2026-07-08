const { json, setCors, parseSymbols, secid, buildUrl, requestJson, cached, okBase, wan, yi, num } = require('./_stock-utils');

function parseFlowLine(line, mode) {
  const p = String(line || '').split(',');
  if (p.length < 6) return null;
  return {
    time: p[0],
    mainNetYuan: num(p[1]) || 0,
    smallNetYuan: num(p[2]) || 0,
    midNetYuan: num(p[3]) || 0,
    largeNetYuan: num(p[4]) || 0,
    superNetYuan: num(p[5]) || 0,
    mainNetWan: wan(p[1]),
    largeNetWan: wan(p[4]),
    superNetWan: wan(p[5]),
    mode,
  };
}

function summarize(rows) {
  const safe = Array.isArray(rows) ? rows : [];
  const latest = safe.length ? safe[safe.length - 1] : null;
  const totalMain = safe.reduce((s, x) => s + (x.mainNetYuan || 0), 0);
  const totalLarge = safe.reduce((s, x) => s + (x.largeNetYuan || 0), 0);
  const totalSuper = safe.reduce((s, x) => s + (x.superNetYuan || 0), 0);
  return {
    points: safe.length,
    latest,
    totalMainWan: wan(totalMain),
    totalMainYi: yi(totalMain),
    totalLargeWan: wan(totalLarge),
    totalSuperWan: wan(totalSuper),
    bias: totalMain > 0 ? 'inflow' : totalMain < 0 ? 'outflow' : 'neutral',
  };
}

async function fetchMinuteFlow(code) {
  const url = buildUrl('https://push2.eastmoney.com/api/qt/stock/fflow/kline/get', {
    secid: secid(code),
    klt: 1,
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57',
  });
  const data = await requestJson(url, { headers: { Referer: 'https://quote.eastmoney.com/', Origin: 'https://quote.eastmoney.com' }, timeoutMs: 10000 });
  const rows = data?.data?.klines || [];
  return rows.map(x => parseFlowLine(x, 'minute')).filter(Boolean);
}

async function fetchDailyFlow(code, limit = 20) {
  const url = buildUrl('https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get', {
    secid: secid(code),
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
    lmt: Math.min(Math.max(Number(limit || 20), 1), 120),
  });
  const data = await requestJson(url, { headers: { Referer: 'https://quote.eastmoney.com/', Origin: 'https://quote.eastmoney.com' }, timeoutMs: 12000 });
  const rows = data?.data?.klines || [];
  return rows.map(x => parseFlowLine(x, 'daily')).filter(Boolean);
}

async function fetchForCode(code, range, dailyLimit) {
  const out = { code };
  if (range === 'minute' || range === 'both') {
    const minuteRows = await fetchMinuteFlow(code);
    out.minute = { summary: summarize(minuteRows), rows: minuteRows.slice(-30) };
  }
  if (range === 'daily' || range === 'both') {
    const dailyRows = await fetchDailyFlow(code, dailyLimit);
    out.daily = { summary: summarize(dailyRows), rows: dailyRows.slice(-Number(dailyLimit || 20)) };
  }
  return out;
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const symbols = parseSymbols(req.query.symbols || req.query.code || req.query.symbol, 5);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbols, e.g. ?symbols=600519,300750' });
  const range = ['minute', 'daily', 'both'].includes(req.query.range) ? req.query.range : 'both';
  const dailyLimit = Math.min(Math.max(Number(req.query.dailyLimit || 20), 1), 120);
  const ttlMs = Number(req.query.ttlMs || (range === 'daily' ? 5 * 60 * 1000 : 60 * 1000));
  const diagnostics = {};
  const data = [];

  for (const code of symbols) {
    try {
      const { value, cached: fromCache } = await cached(`stock-flow:${code}:${range}:${dailyLimit}`, ttlMs, () => fetchForCode(code, range, dailyLimit));
      data.push({ ...value, cached: fromCache });
    } catch (err) {
      diagnostics[code] = String(err && err.message ? err.message : err);
      data.push({ code, error: diagnostics[code], minute: null, daily: null });
    }
  }

  return json(res, 200, okBase({
    mode: 'stock_capital_flow_v1',
    source: 'eastmoney_push2_fflow',
    range,
    count: data.length,
    data,
    diagnostics,
    note: '资金流金额单位来自东财原始元，接口同时给出万元/亿元摘要；只用于资金验证，不单独构成买点。',
  }));
};
