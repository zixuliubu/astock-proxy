const { json, setCors, parseSymbols, secid, buildUrl, requestJson, cached, okBase, wan, yi, num } = require('./_stock-utils');
const { failure, summarizeCumulativeFlow } = require('./_data-contracts');

function parseFlowLine(line, mode) {
  const p = String(line || '').split(',');
  if (p.length < 6) return null;
  return {
    time: p[0],
    mainNetYuan: num(p[1]),
    smallNetYuan: num(p[2]),
    midNetYuan: num(p[3]),
    largeNetYuan: num(p[4]),
    superNetYuan: num(p[5]),
    mainNetWan: wan(p[1]),
    largeNetWan: wan(p[4]),
    superNetWan: wan(p[5]),
    mode,
  };
}

function summarize(rows) {
  return summarizeCumulativeFlow(rows, wan, yi);
}

async function fetchMinuteFlow(code) {
  const url = buildUrl('https://push2.eastmoney.com/api/qt/stock/fflow/kline/get', {
    secid: secid(code),
    klt: 1,
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57',
    ut: 'b2884a393a59ad64002292a3e90d46a5',
  });
  const data = await requestJson(url, { headers: { Referer: 'https://data.eastmoney.com/zjlx/' }, timeoutMs: 10000 });
  return (data?.data?.klines || []).map(x => parseFlowLine(x, 'minute')).filter(Boolean);
}

async function fetchDailyFlow(code, limit = 20) {
  const url = buildUrl('https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get', {
    secid: secid(code),
    klt: 101,
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
    lmt: Math.min(Math.max(Number(limit || 20), 1), 120),
    ut: 'b2884a393a59ad64002292a3e90d46a5',
  });
  const data = await requestJson(url, { headers: { Referer: 'https://data.eastmoney.com/zjlx/' }, timeoutMs: 12000 });
  return (data?.data?.klines || []).map(x => parseFlowLine(x, 'daily')).filter(Boolean);
}

async function fetchTurnover(code) {
  const url = buildUrl('https://push2.eastmoney.com/api/qt/stock/get', {
    secid: secid(code),
    fields: 'f12,f14,f48',
  });
  const data = await requestJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 8000 });
  return num(data?.data?.f48);
}

async function fetchForCode(code, range, dailyLimit) {
  const out = { code, turnoverYuan: await fetchTurnover(code).catch(() => null) };
  if (range === 'minute' || range === 'both') {
    const rows = await fetchMinuteFlow(code);
    out.minute = { summary: summarize(rows), rows: rows.slice(-30) };
  }
  if (range === 'daily' || range === 'both') {
    const rows = await fetchDailyFlow(code, dailyLimit);
    out.daily = { summary: summarize(rows), rows: rows.slice(-dailyLimit) };
  }
  const main = out.minute?.summary?.latest?.mainNetYuan ?? out.daily?.summary?.latest?.mainNetYuan;
  if (num(main) !== null && out.turnoverYuan && Math.abs(main) > out.turnoverYuan * 1.05) {
    out.validation = failure('CONFLICT', 'Main net flow exceeds the stock turnover', {
      mainNetYuan: main,
      turnoverYuan: out.turnoverYuan,
    });
  }
  return out;
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, failure('METHOD_NOT_ALLOWED', 'Method not allowed'));

  const symbols = parseSymbols(req.query.symbols || req.query.code || req.query.symbol, 5);
  if (!symbols.length) return json(res, 400, failure('INVALID_ARGUMENT', 'Missing symbols'));
  const range = ['minute', 'daily', 'both'].includes(req.query.range) ? req.query.range : 'both';
  const dailyLimit = Math.min(Math.max(Number(req.query.dailyLimit || 20), 1), 120);
  const ttlMs = Number(req.query.ttlMs || (range === 'daily' ? 5 * 60 * 1000 : 60 * 1000));
  const diagnostics = {};
  const data = [];

  for (const code of symbols) {
    try {
      const key = `stock-flow:v2:${code}:${range}:${dailyLimit}`;
      const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchForCode(code, range, dailyLimit));
      data.push({ ...value, cached: fromCache });
    } catch (err) {
      diagnostics[code] = String(err?.message || err);
      data.push({ code, status: 'UPSTREAM_FAILED', error: diagnostics[code], minute: null, daily: null });
    }
  }

  const failures = data.filter(item => item.error || item.validation);
  const usable = data.filter(item => item.minute?.summary?.latest || item.daily?.summary?.latest);
  const success = usable.length === data.length && failures.length === 0;
  return json(res, success ? 200 : 503, {
    ...okBase({
      success,
      status: failures.some(item => item.validation?.status === 'CONFLICT') ? 'CONFLICT' : success ? 'OK' : 'DATA_INSUFFICIENT',
      mode: 'stock_capital_flow_v2',
      source: 'eastmoney_push2_fflow_akshare_contract',
      range,
      count: data.length,
      data,
      diagnostics,
      note: 'Minute and daily flow points are cumulative snapshots; summaries use the final point and convert units once.',
    }),
  });
};

module.exports.parseFlowLine = parseFlowLine;
module.exports.summarize = summarize;
