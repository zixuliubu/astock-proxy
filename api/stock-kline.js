const { json, setCors, parseSymbols, prefixedCode, buildUrl, requestJson, cached, okBase, num } = require('./_stock-utils');

const DAY_FREQ = new Set(['1d', '1w', '1M']);
const MIN_FREQ = new Set(['1m', '5m', '15m', '30m', '60m']);

function txUnit(frequency) {
  if (frequency === '1w') return 'week';
  if (frequency === '1M') return 'month';
  return 'day';
}

function sinaScale(frequency) {
  if (frequency === '1d') return 240;
  if (frequency === '1w') return 1200;
  if (frequency === '1M') return 7200;
  return Number(String(frequency).replace('m', '')) || 60;
}

function normalizeRow(row, source, frequency) {
  return {
    time: row.time || row.day || row[0] || '',
    open: num(row.open ?? row[1]),
    close: num(row.close ?? row[2]),
    high: num(row.high ?? row[3]),
    low: num(row.low ?? row[4]),
    volume: num(row.volume ?? row[5]),
    source,
    frequency,
  };
}

async function fetchSina(code, frequency, count) {
  const symbol = prefixedCode(code);
  const url = buildUrl('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData', {
    symbol,
    scale: sinaScale(frequency),
    ma: 5,
    datalen: count,
  });
  const data = await requestJson(url, { timeoutMs: 10000 });
  if (!Array.isArray(data)) throw new Error('sina empty kline');
  return data.map(x => normalizeRow(x, 'sina', frequency)).filter(x => x.time && x.open !== null);
}

async function fetchTencentDay(code, frequency, count) {
  const symbol = prefixedCode(code);
  const unit = txUnit(frequency);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${unit},,,${count},qfq`;
  const data = await requestJson(url, { timeoutMs: 10000 });
  const stk = data?.data?.[symbol] || {};
  const key = `qfq${unit}`;
  const rows = stk[key] || stk[unit] || [];
  if (!Array.isArray(rows)) throw new Error('tencent day empty kline');
  return rows.map(x => normalizeRow(x, 'tencent', frequency)).filter(x => x.time && x.open !== null);
}

async function fetchTencentMinute(code, frequency, count) {
  const symbol = prefixedCode(code);
  const minutes = Number(String(frequency).replace('m', '')) || 1;
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},m${minutes},,${count}`;
  const data = await requestJson(url, { timeoutMs: 10000 });
  const rows = data?.data?.[symbol]?.[`m${minutes}`] || [];
  if (!Array.isArray(rows)) throw new Error('tencent minute empty kline');
  return rows.map(x => normalizeRow(x, 'tencent', frequency)).filter(x => x.time && x.open !== null);
}

async function fetchOne(code, frequency, count, source) {
  const attempts = [];
  async function trySource(name, loader) {
    try {
      const rows = await loader();
      if (rows.length) return { code, frequency, source: name, count: rows.length, rows };
      attempts.push({ source: name, error: 'empty rows' });
    } catch (err) {
      attempts.push({ source: name, error: String(err && err.message ? err.message : err) });
    }
    return null;
  }

  if (source === 'sina') {
    const r = await trySource('sina', () => fetchSina(code, frequency, count));
    return r || { code, frequency, source: 'none', count: 0, rows: [], attempts };
  }
  if (source === 'tencent') {
    const r = await trySource('tencent', () => DAY_FREQ.has(frequency) ? fetchTencentDay(code, frequency, count) : fetchTencentMinute(code, frequency, count));
    return r || { code, frequency, source: 'none', count: 0, rows: [], attempts };
  }

  if (DAY_FREQ.has(frequency)) {
    return await trySource('sina', () => fetchSina(code, frequency, count))
      || await trySource('tencent', () => fetchTencentDay(code, frequency, count))
      || { code, frequency, source: 'none', count: 0, rows: [], attempts };
  }

  if (frequency === '1m') {
    return await trySource('tencent', () => fetchTencentMinute(code, frequency, count))
      || { code, frequency, source: 'none', count: 0, rows: [], attempts };
  }

  return await trySource('sina', () => fetchSina(code, frequency, count))
    || await trySource('tencent', () => fetchTencentMinute(code, frequency, count))
    || { code, frequency, source: 'none', count: 0, rows: [], attempts };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const symbols = parseSymbols(req.query.symbols || req.query.code || req.query.symbol, 5);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbols, e.g. ?symbols=600519,300750' });

  const frequency = String(req.query.frequency || req.query.freq || '1d');
  if (!DAY_FREQ.has(frequency) && !MIN_FREQ.has(frequency)) return json(res, 400, { success: false, error: 'Unsupported frequency. Use 1d,1w,1M,1m,5m,15m,30m,60m' });

  const count = Math.min(Math.max(Number(req.query.count || 60), 1), 240);
  const source = ['auto', 'sina', 'tencent'].includes(req.query.source) ? req.query.source : 'auto';
  const ttlMs = Number(req.query.ttlMs || (DAY_FREQ.has(frequency) ? 5 * 60 * 1000 : 60 * 1000));

  const data = [];
  const diagnostics = {};
  for (const code of symbols) {
    try {
      const key = `stock-kline:${code}:${frequency}:${count}:${source}`;
      const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchOne(code, frequency, count, source));
      data.push({ ...value, cached: fromCache });
      if (value.attempts) diagnostics[code] = value.attempts;
    } catch (err) {
      diagnostics[code] = String(err && err.message ? err.message : err);
      data.push({ code, frequency, source: 'none', count: 0, rows: [], error: diagnostics[code] });
    }
  }

  return json(res, 200, okBase({
    mode: 'stock_kline_v1',
    sourcePriority: source === 'auto' ? ['sina', 'tencent'] : [source],
    frequency,
    requestCount: count,
    count: data.length,
    data,
    diagnostics,
    limits: { maxSymbols: 5, maxBars: 240, redisWrites: 0 },
    note: 'Ashare 轻量移植版：新浪/腾讯双源，仅作行情备源和分时/日K验证，不做全市场落库。',
  }));
};
