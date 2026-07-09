const { json, setCors, cleanCode, parseSymbols, requestJson, buildUrl, okBase, cached } = require('./_stock-utils');

const EASTMONEY_DATA_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const LIST_REPORT = 'RPT_DAILYBILLBOARD_DETAILS';
const CANDIDATE_REPORTS = [
  'RPT_OPERATEDEPT_LIST',
  'RPT_OPERATEDEPT_INFO',
  'RPT_SEAT_INFO',
  'RPT_BILLBOARD_OPERATEDEPT',
  'RPT_LHB_OPERATEDEPT',
  'RPT_OPERATEDEPT_STATISTICS',
];
const CODE_KEYS = ['OPERATEDEPT_CODE', 'OPERATEDEPT_ID', 'SEAT_CODE', 'SEAT_ID', 'BUY_SEAT', 'SELL_SEAT', 'BUY_SEAT_NEW', 'SELL_SEAT_NEW'];
const NAME_KEYS = ['OPERATEDEPT_NAME', 'OPERATEDEPT', 'SALES_DEPT_NAME', 'SEAT_NAME', 'BRANCH_NAME', 'DEPT_NAME'];

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

function compact(row) {
  const out = {};
  for (const k of Object.keys(row || {}).slice(0, 60)) {
    const v = row[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function rowCode(row) {
  return cleanCode(row.SECURITY_CODE || row.SECUCODE || row.CODE || '');
}

function firstName(row) {
  for (const k of NAME_KEYS) {
    if (row && row[k]) return String(row[k]).trim();
  }
  return '';
}

function hasCode(row, code) {
  const s = String(code || '').trim();
  return CODE_KEYS.some(k => row && row[k] !== undefined && String(row[k]).trim() === s);
}

async function fetchReport(reportName, filter, pageSize = 100) {
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
  const data = await requestJson(url, { timeoutMs: 8000, headers: { Referer: 'https://data.eastmoney.com/' } });
  const rows = data && data.result && Array.isArray(data.result.data) ? data.result.data : [];
  return { reportName, filter, rawCount: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]).slice(0, 80) : [], sampleRows: rows.slice(0, 3).map(compact), rows };
}

async function probe({ date, symbol, maxReports = 6, maxFilters = 8 }) {
  const tradeDate = formatDate(date);
  const code = cleanCode(symbol);
  const list = await fetchReport(LIST_REPORT, `(TRADE_DATE='${tradeDate}')`, 200);
  const listRows = list.rows.filter(r => rowCode(r) === code);
  const seatCodes = [...new Set(listRows.flatMap(r => [r.BUY_SEAT, r.SELL_SEAT, r.BUY_SEAT_NEW, r.SELL_SEAT_NEW]).map(x => String(x || '').trim()).filter(Boolean))];
  const filters = [];
  for (const sc of seatCodes) {
    for (const key of CODE_KEYS) {
      filters.push(`(${key}='${sc}')`);
      filters.push(`(${key}=${sc})`);
    }
  }
  filters.push(`(TRADE_DATE='${tradeDate}')`);
  const attempts = [];
  const mappings = [];
  for (const reportName of CANDIDATE_REPORTS.slice(0, Math.max(1, Math.min(Number(maxReports) || 6, CANDIDATE_REPORTS.length)))) {
    for (const filter of [...new Set(filters)].slice(0, Math.max(1, Math.min(Number(maxFilters) || 8, 40)))) {
      try {
        const result = await fetchReport(reportName, filter, 100);
        const found = [];
        for (const row of result.rows) {
          const name = firstName(row);
          if (!name) continue;
          for (const sc of seatCodes) {
            if (hasCode(row, sc)) found.push({ code: sc, seatName: name, raw: compact(row) });
          }
        }
        mappings.push(...found.map(x => ({ ...x, reportName, filter })));
        attempts.push({ reportName, filter, rawCount: result.rawCount, foundMappings: found.length, sampleKeys: result.sampleKeys, sampleRows: result.sampleRows });
      } catch (err) {
        attempts.push({ reportName, filter, error: String(err && err.message ? err.message : err) });
      }
    }
  }
  const unique = [];
  const seen = new Set();
  for (const m of mappings) {
    const key = `${m.code}|${m.seatName}`;
    if (!seen.has(key)) { seen.add(key); unique.push(m); }
  }
  return okBase({
    mode: 'dragon_tiger_seat_code_probe_v1',
    tradeDate,
    code,
    listMatchCount: listRows.length,
    seatCodes,
    status: unique.length ? 'seat_code_mapping_found' : 'seat_code_mapping_missing',
    mappings: unique,
    attempts,
    listRows: listRows.map(compact),
    explanation: unique.length ? '已通过席位编码反查到营业部名称候选。' : '已提取席位编码，但候选字典表暂未命中。',
  });
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });
  const symbols = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 1);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbol, e.g. ?date=20260709&symbol=002185' });
  const maxReports = Number(req.query.maxReports || 6);
  const maxFilters = Number(req.query.maxFilters || 8);
  const key = `dragon-tiger-seat-code-probe:v1:${formatDate(req.query.date)}:${symbols[0]}:mr=${maxReports}:mf=${maxFilters}`;
  try {
    const { value, cached: cacheHit } = await cached(key, 300000, async () => probe({ date: req.query.date, symbol: symbols[0], maxReports, maxFilters }));
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({ success: false, mode: 'dragon_tiger_seat_code_probe_v1', error: String(err && err.message ? err.message : err) }));
  }
};
