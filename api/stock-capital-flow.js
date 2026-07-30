const {
  json, setCors, parseSymbols, secid, buildUrl, requestJson, requestJsonFallback,
  cached, okBase, wan, yi, num,
} = require('./_stock-utils');
const { failure, summarizeCumulativeFlow } = require('./_data-contracts');
const { sinaQuote, tencentQuote, mergeQuotes } = require('./quote');
const EASTMONEY_TOKEN = 'b2884a393a59ad64002292a3e90d46a5';
const MINUTE_HOSTS = [
  ['eastmoney_push2', 'https://push2.eastmoney.com'],
  ['eastmoney_push2_79', 'https://79.push2.eastmoney.com'],
  ['eastmoney_push2_17', 'https://17.push2.eastmoney.com'],
];
const DAILY_HOSTS = [
  ['eastmoney_push2his_33', 'https://33.push2his.eastmoney.com'],
  ['eastmoney_push2his_63', 'https://63.push2his.eastmoney.com'],
  ['eastmoney_push2his', 'https://push2his.eastmoney.com'],
];

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
  const params = {
    secid: secid(code),
    lmt: 0,
    klt: 1,
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57',
    ut: EASTMONEY_TOKEN,
    _: Date.now(),
  };
  const result = await requestJsonFallback(MINUTE_HOSTS.map(([source, host]) => ({
    source,
    url: buildUrl(`${host}/api/qt/stock/fflow/kline/get`, params),
  })), {
    headers: {
      Referer: 'https://data.eastmoney.com/zjlx/',
      Origin: 'https://data.eastmoney.com',
    },
    timeoutMs: 4000,
    accept: payload => Array.isArray(payload?.data?.klines) && payload.data.klines.length > 0,
  });
  return {
    rows: result.data.data.klines.map(x => parseFlowLine(x, 'minute')).filter(Boolean),
    source: result.source,
    attempts: result.attempts,
  };
}

async function fetchDailyFlow(code, limit = 20) {
  const params = {
    secid: secid(code),
    klt: 101,
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
    lmt: Math.min(Math.max(Number(limit || 20), 1), 120),
    ut: EASTMONEY_TOKEN,
    _: Date.now(),
  };
  const result = await requestJsonFallback(DAILY_HOSTS.map(([source, host]) => ({
    source,
    url: buildUrl(`${host}/api/qt/stock/fflow/daykline/get`, params),
  })), {
    headers: { Referer: 'https://data.eastmoney.com/zjlx/' },
    timeoutMs: 4500,
    accept: payload => Array.isArray(payload?.data?.klines) && payload.data.klines.length > 0,
  });
  return {
    rows: result.data.data.klines.map(x => parseFlowLine(x, 'daily')).filter(Boolean),
    source: result.source,
    attempts: result.attempts,
  };
}

async function fetchTurnover(code) {
  try {
    const url = buildUrl('https://push2.eastmoney.com/api/qt/stock/get', {
      secid: secid(code),
      fields: 'f12,f14,f48',
    });
    const data = await requestJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 8000 });
    const value = num(data?.data?.f48);
    if (value !== null && value > 0) return { amountYuan: value, source: 'eastmoney_stock_f48' };
  } catch (error) {
    // Continue to the existing Sina/Tencent quote adapters.
  }
  const [sinaResult, tencentResult] = await Promise.allSettled([
    sinaQuote(code),
    tencentQuote(code),
  ]);
  const quote = mergeQuotes(
    sinaResult.status === 'fulfilled' ? sinaResult.value : [],
    tencentResult.status === 'fulfilled' ? tencentResult.value : [],
  )[0];
  const amount = num(quote?.amount);
  return amount !== null && amount > 0
    ? { amountYuan: amount, source: quote.sources?.join('+') || quote.source }
    : { amountYuan: null, source: null };
}

async function fetchForCode(code, range, dailyLimit) {
  const tasks = {
    turnover: fetchTurnover(code),
  };
  if (range === 'minute' || range === 'both') tasks.minute = fetchMinuteFlow(code);
  if (range === 'daily' || range === 'both') tasks.daily = fetchDailyFlow(code, dailyLimit);
  const names = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));
  const results = Object.fromEntries(names.map((name, index) => [name, settled[index]]));
  const turnover = results.turnover.status === 'fulfilled'
    ? results.turnover.value
    : { amountYuan: null, source: null };
  const out = { code, turnoverYuan: turnover.amountYuan, turnoverSource: turnover.source };
  const flowErrors = {};
  if (results.minute?.status === 'fulfilled') {
    const value = results.minute.value;
    out.minute = {
      source: value.source,
      summary: summarize(value.rows),
      rows: value.rows.slice(-30),
      attempts: value.attempts,
    };
  } else if (results.minute) {
    flowErrors.minute = String(results.minute.reason?.message || results.minute.reason);
    out.minute = null;
  }
  if (results.daily?.status === 'fulfilled') {
    const value = results.daily.value;
    out.daily = {
      source: value.source,
      summary: summarize(value.rows),
      rows: value.rows.slice(-dailyLimit),
      attempts: value.attempts,
    };
  } else if (results.daily) {
    flowErrors.daily = String(results.daily.reason?.message || results.daily.reason);
    out.daily = null;
  }
  if (Object.keys(flowErrors).length) out.flowErrors = flowErrors;
  const main = out.minute?.summary?.latest?.mainNetYuan ?? out.daily?.summary?.latest?.mainNetYuan;
  const requestedSlicesAvailable = (
    (range === 'minute' && out.minute?.summary?.latest)
    || (range === 'daily' && out.daily?.summary?.latest)
    || (range === 'both' && out.minute?.summary?.latest && out.daily?.summary?.latest)
  );
  if (!requestedSlicesAvailable) {
    out.validation = failure('DATA_INSUFFICIENT', 'One or more requested flow ranges are unavailable', {
      range,
      flowErrors,
    });
  } else if (out.minute && !(out.turnoverYuan > 0)) {
    out.validation = failure('DATA_INSUFFICIENT', 'Current stock turnover is unavailable for flow reconciliation');
  } else if (num(main) !== null && out.turnoverYuan && Math.abs(main) > out.turnoverYuan * 1.05) {
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

  const results = await Promise.all(symbols.map(async code => {
    try {
      const key = `stock-flow:v3:${code}:${range}:${dailyLimit}`;
      const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchForCode(code, range, dailyLimit));
      return { ...value, cached: fromCache };
    } catch (err) {
      diagnostics[code] = String(err?.message || err);
      return { code, status: 'UPSTREAM_FAILED', error: diagnostics[code], minute: null, daily: null };
    }
  }));
  data.push(...results);
  for (const item of results) {
    if (item.flowErrors) diagnostics[item.code] = item.flowErrors;
  }

  const failures = data.filter(item => item.error || item.validation);
  const usable = data.filter(item => item.minute?.summary?.latest || item.daily?.summary?.latest);
  const success = usable.length === data.length && failures.length === 0;
  return json(res, success ? 200 : 503, {
    ...okBase({
      success,
      status: failures.some(item => item.validation?.status === 'CONFLICT') ? 'CONFLICT' : success ? 'OK' : 'DATA_INSUFFICIENT',
      mode: 'stock_capital_flow_v3',
      source: 'eastmoney_push2_multi_host_fflow_mature_library_contract',
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
module.exports.fetchMinuteFlow = fetchMinuteFlow;
module.exports.fetchForCode = fetchForCode;
