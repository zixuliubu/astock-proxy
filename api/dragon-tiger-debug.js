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

const SEAT_KEYS = [
  'OPERATEDEPT_NAME', 'OPERATEDEPT', 'DEPARTMENT_NAME', 'SALES_DEPT_NAME', 'TRADE_DEPT_NAME',
  'EXCHANGE_TRADE_BRANCH', 'MEMBER_NAME', 'SEAT_NAME', 'BUY_OPERATEDEPT_NAME', 'SELL_OPERATEDEPT_NAME'
];

const SUMMARY_KEYS = [
  'TOTAL_BUY', 'TOTAL_SELL', 'TOTAL_NET', 'BILLBOARD_BUY_AMT', 'BILLBOARD_SELL_AMT',
  'BILLBOARD_NET_AMT', 'BUY_SEAT', 'SELL_SEAT', 'TOTAL_BUYRIOTOP', 'TOTAL_SELLRIOTOP'
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

function rowTradeId(row) {
  const v = pick(row, ['TRADE_ID', 'TRADEID', 'BILLBOARD_TRADE_ID'], '');
  return v === undefined || v === null ? '' : String(v).trim();
}

function compactRow(row) {
  const keys = Object.keys(row || {});
  const out = {};
  for (const k of keys.slice(0, 60)) {
    const v = row[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function classifyKeys(keys = []) {
  const keySet = new Set(keys || []);
  const seatKeys = SEAT_KEYS.filter(k => keySet.has(k));
  const summaryKeys = SUMMARY_KEYS.filter(k => keySet.has(k));
  let kind = 'unknown';
  if (seatKeys.length) kind = 'seat_detail';
  else if (summaryKeys.length) kind = 'summary_detail';
  return { kind, seatKeys, summaryKeys };
}

function buildFilters(tradeDate, code, tradeIds = []) {
  const filters = [
    `(TRADE_DATE='${tradeDate}')(SECURITY_CODE='${code}')`,
    `(TRADE_DATE='${tradeDate}')`,
    `(SECURITY_CODE='${code}')`,
  ];
  for (const id of tradeIds || []) {
    filters.push(`(TRADE_ID='${id}')`);
    filters.push(`(TRADE_ID=${id})`);
    filters.push(`(TRADE_DATE='${tradeDate}')(TRADE_ID='${id}')`);
    filters.push(`(TRADE_DATE='${tradeDate}')(TRADE_ID=${id})`);
    filters.push(`(SECURITY_CODE='${code}')(TRADE_ID='${id}')`);
    filters.push(`(SECURITY_CODE='${code}')(TRADE_ID=${id})`);
  }
  return [...new Set(filters)];
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
  const sampleKeys = rows[0] ? Object.keys(rows[0]).slice(0, 80) : [];
  return {
    reportName,
    filter,
    rawCount: rows.length,
    sampleKeys,
    fieldClass: classifyKeys(sampleKeys),
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
  let listRows = [];
  let tradeIds = [];
  try {
    const list = await fetchReport({ reportName: LIST_REPORT, filter: `(TRADE_DATE='${tradeDate}')`, pageSize: 200 });
    const matches = list.rows.filter(r => rowCode(r) === code);
    listRows = matches.slice(0, 10).map(compactRow);
    listRow = listRows[0] || null;
    tradeIds = [...new Set(matches.map(rowTradeId).filter(Boolean))];
    listStatus = matches.length ? 'listed' : 'not_on_list';
    diagnostics.push({
      type: 'list',
      reportName: LIST_REPORT,
      filter: `(TRADE_DATE='${tradeDate}')`,
      rawCount: list.rawCount,
      matchCount: matches.length,
      tradeIds,
      sampleKeys: list.sampleKeys,
      fieldClass: list.fieldClass,
      matchRows: listRows,
    });
  } catch (err) {
    listStatus = 'list_fetch_error';
    diagnostics.push({ type: 'list', reportName: LIST_REPORT, error: String(err && err.message ? err.message : err) });
  }

  const detailAttempts = [];
  const filters = buildFilters(tradeDate, code, tradeIds);

  for (const reportName of DETAIL_REPORTS) {
    for (const filter of filters) {
      try {
        const result = await fetchReport({ reportName, filter, pageSize: 200 });
        const matches = result.rows.filter(r => rowCode(r) === code || JSON.stringify(r).includes(code) || tradeIds.some(id => JSON.stringify(r).includes(String(id))));
        const matchKeys = matches[0] ? Object.keys(matches[0]).slice(0, 80) : result.sampleKeys;
        const fieldClass = classifyKeys(matchKeys);
        detailAttempts.push({
          reportName,
          filter,
          rawCount: result.rawCount,
          matchCount: matches.length,
          sampleKeys: result.sampleKeys,
          matchFieldClass: fieldClass,
          reportFieldClass: result.fieldClass,
          matchRows: matches.slice(0, 3).map(compactRow),
          sampleRows: result.sampleRows,
        });
      } catch (err) {
        detailAttempts.push({ reportName, filter, error: String(err && err.message ? err.message : err) });
      }
    }
  }

  const seatHit = detailAttempts.find(x => (x.matchCount || 0) > 0 && x.matchFieldClass && x.matchFieldClass.kind === 'seat_detail') || null;
  const summaryHit = detailAttempts.find(x => (x.matchCount || 0) > 0 && x.matchFieldClass && x.matchFieldClass.kind === 'summary_detail') || null;
  const anyHit = detailAttempts.find(x => (x.matchCount || 0) > 0) || null;

  let status = 'listed_detail_missing';
  if (listStatus === 'not_on_list') status = 'not_on_list';
  else if (listStatus === 'list_fetch_error') status = 'fetch_error';
  else if (seatHit) status = 'seat_candidate_found';
  else if (summaryHit) status = 'summary_candidate_only';
  else if (anyHit) status = 'non_seat_candidate_found';

  return {
    code,
    tradeDate,
    status,
    listStatus,
    listRow,
    listRows,
    tradeIds,
    seatCandidate: seatHit ? { reportName: seatHit.reportName, filter: seatHit.filter, matchCount: seatHit.matchCount, sampleKeys: seatHit.sampleKeys, fieldClass: seatHit.matchFieldClass, matchRows: seatHit.matchRows } : null,
    summaryCandidate: summaryHit ? { reportName: summaryHit.reportName, filter: summaryHit.filter, matchCount: summaryHit.matchCount, sampleKeys: summaryHit.sampleKeys, fieldClass: summaryHit.matchFieldClass, matchRows: summaryHit.matchRows } : null,
    diagnostics,
    detailAttempts,
    explanation: status === 'not_on_list'
      ? '该股票在当日龙虎榜列表中未出现，因此不应期待席位明细。'
      : status === 'seat_candidate_found'
        ? '已找到包含席位/营业部字段的候选表，可据此修正正式明细接口。'
        : status === 'summary_candidate_only'
          ? '仅找到个股龙虎榜汇总/分原因明细表，没有营业部席位字段，不能当作席位明细。v3 已尝试 TRADE_ID 下钻。'
          : '股票已上榜或列表状态不明，但当前候选表未返回可用席位字段。v3 已尝试 TRADE_ID 下钻。',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const symbols = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 8);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbols, e.g. ?date=20260709&symbols=002185,600584' });
  const date = req.query.date;
  const ttlMs = Math.max(30000, Math.min(Number(req.query.ttlMs || 300000) || 300000, 900000));
  const key = `dragon-tiger-debug:v3:${formatDate(date)}:${symbols.join(',')}`;

  try {
    const { value, cached: cacheHit } = await cached(key, ttlMs, async () => {
      const results = [];
      for (const symbol of symbols) results.push(await debugOne({ date, symbol }));
      return okBase({
        mode: 'dragon_tiger_debug_v3',
        date: formatDate(date),
        symbols,
        count: results.length,
        statusSummary: results.reduce((acc, x) => { acc[x.status || 'unknown'] = (acc[x.status || 'unknown'] || 0) + 1; return acc; }, {}),
        results,
        note: '诊断接口用于区分未上榜、汇总表命中、真正席位表命中；v3 已加入 TRADE_ID 下钻过滤，只有包含席位/营业部字段的候选才会标为 seat_candidate_found。',
      });
    });
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({
      success: false,
      mode: 'dragon_tiger_debug_v3',
      error: String(err && err.message ? err.message : err),
      symbols,
      results: [],
    }));
  }
};
