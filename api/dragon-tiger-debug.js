const { json, setCors, cleanCode, parseSymbols, requestJson, buildUrl, okBase, cached } = require('./_stock-utils');

const EASTMONEY_DATA_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const LIST_REPORT = 'RPT_DAILYBILLBOARD_DETAILS';
const DETAIL_REPORTS = [
  'RPT_BILLBOARD_DAILYDETAILS',
  'RPT_DAILYBILLBOARD_DAILYDETAILS',
  'RPT_BILLBOARD_TRADEDETAILS',
  'RPT_DAILYBILLBOARD_TRADEDETAILS',
  'RPT_BILLBOARD_DETAILS',
  'RPT_DAILYBILLBOARD_DETAILS',
];

function todayISO() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function formatDate(date) {
  const s = String(date || '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return todayISO();
}

function pick(row, keys, fallback = '') {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return fallback;
}

function rowCode(row) {
  return cleanCode(pick(row, ['SECURITY_CODE', 'SECUCODE', 'CODE', 'STOCK_CODE'], ''));
}

function compactRow(row) {
  const keys = Object.keys(row || {});
  const out = {};
  for (const k of keys.slice(0, 40)) {
    const v = row[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

async function fetchReport({ reportName, filter, pageSize = 100 }) {
  const url = buildUrl(EASTMONEY_DATA_URL, {
    sortColumns: 'TRADE_DATE,SECURITY_CODE',
    sortTypes: '-1,1',
    pageSize,
    pageNumber: 1,
    reportName,
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter,
    _: Date.now(),
  });
  const data = await requestJson(url, {
    timeoutMs: 10000,
    headers: { Referer: 'https://data.eastmoney.com/' },
  });
  const rows = data && data.result && Array.isArray(data.result.data) ? data.result.data : [];
  return {
    reportName,
    filter,
    rawCount: rows.length,
    sampleKeys: rows[0] ? Object.keys(rows[0]).slice(0, 60) : [],
    sampleRows: rows.slice(0, 3).map(compactRow),
    rows,
  };
}

async function debugOne({ date, symbol }) {
  const tradeDate = formatDate(date);
  const code = cleanCode(symbol);
  const diagnostics = [];

  let listStatus = 'unknown';
  let listRow = null;
  try {
    const list = await fetchReport({ reportName: LIST_REPORT, filter: `(TRADE_DATE='${tradeDate}')`, pageSize: 200 });
    const matches = list.rows.filter(r => rowCode(r) === code);
    listRow = matches[0] ? compactRow(matches[0]) : null;
    listStatus = matches.length ? 'listed' : 'not_on_list';
    diagnostics.push({
      type: 'list',
      reportName: LIST_REPORT,
      filter: `(TRADE_DATE='${tradeDate}')`,
      rawCount: list.rawCount,
      matchCount: matches.length,
      sampleKeys: list.sampleKeys,
      matchRows: matches.slice(0, 3).map(compactRow),
    });
  } catch (err) {
    listStatus = 'list_fetch_error';
    diagnostics.push({ type: 'list', reportName: LIST_REPORT, error: String(err && err.message ? err.message : err) });
  }

  const detailAttempts = [];
  const filters = [
    `(TRADE_DATE='${tradeDate}')(SECURITY_CODE='${code}')`,
    `(TRADE_DATE='${tradeDate}')`,
    `(SECURITY_CODE='${code}')`,
  ];

  for (const reportName of DETAIL_REPORTS) {
    for (const filter of filters) {
      try {
        const result = await fetchReport({ reportName, filter, pageSize: 200 });
        const matches = result.rows.filter(r => rowCode(r) === code || JSON.stringify(r).includes(code));
        detailAttempts.push({
          reportName,
          filter,
          rawCount: result.rawCount,
          matchCount: matches.length,
          sampleKeys: result.sampleKeys,
          matchRows: matches.slice(0, 3).map(compactRow),
          sampleRows: result.sampleRows,
        });
      } catch (err) {
        detailAttempts.push({ reportName, filter, error: String(err && err.message ? err.message : err) });
      }
    }
  }

  const hit = detailAttempts.find(x => (x.matchCount || 0) > 0) || null;
  let status = 'listed_detail_missing';
  if (listStatus === 'not_on_list') status = 'not_on_list';
  else if (listStatus === 'list_fetch_error') status = 'fetch_error';
  else if (hit) status = 'detail_candidate_found';

  return {
    code,
    tradeDate,
    status,
    listStatus,
    listRow,
    detailCandidate: hit ? { reportName: hit.reportName, filter: hit.filter, matchCount: hit.matchCount, sampleKeys: hit.sampleKeys, matchRows: hit.matchRows } : null,
    diagnostics,
    detailAttempts,
    explanation: status === 'not_on_list'
      ? '该股票在当日龙虎榜列表中未出现，因此不应期待席位明细。'
      : status === 'detail_candidate_found'
        ? '已找到疑似席位明细候选表/过滤条件，可据此修正正式明细接口。'
        : '股票已上榜或列表状态不明，但当前候选席位明细表未返回匹配行。',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const symbols = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 8);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbols, e.g. ?date=20260709&symbols=002185,600584' });
  const date = req.query.date;
  const ttlMs = Math.max(30000, Math.min(Number(req.query.ttlMs || 300000) || 300000, 900000));
  const key = `dragon-tiger-debug:v1:${formatDate(date)}:${symbols.join(',')}`;

  try {
    const { value, cached: cacheHit } = await cached(key, ttlMs, async () => {
      const results = [];
      for (const symbol of symbols) results.push(await debugOne({ date, symbol }));
      return okBase({
        mode: 'dragon_tiger_debug_v1',
        date: formatDate(date),
        symbols,
        count: results.length,
        results,
        note: '诊断接口用于判断“未上榜 / 上榜但席位未更新 / reportName或字段未命中”，不用于直接交易决策。',
      });
    });
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({
      success: false,
      mode: 'dragon_tiger_debug_v1',
      error: String(err && err.message ? err.message : err),
      symbols,
      results: [],
    }));
  }
};
