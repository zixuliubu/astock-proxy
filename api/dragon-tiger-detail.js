const { json, setCors, cleanCode, parseSymbols, requestJson, buildUrl, okBase, cached, yi } = require('./_stock-utils');
const { tagSeat, summarizeSeats } = require('./_seat-tags');

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

function n(v) {
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
}

function rowCode(row) {
  return cleanCode(pick(row, ['SECURITY_CODE', 'SECUCODE', 'CODE', 'STOCK_CODE'], ''));
}

function rowTradeId(row) {
  const v = pick(row, ['TRADE_ID', 'TRADEID', 'BILLBOARD_TRADE_ID'], '');
  return v === undefined || v === null ? '' : String(v).trim();
}

function compactListRow(row) {
  if (!row) return null;
  return {
    tradeDate: pick(row, ['TRADE_DATE'], ''),
    code: rowCode(row),
    name: pick(row, ['SECURITY_NAME_ABBR', 'SECURITY_NAME', 'STOCK_NAME'], ''),
    reason: pick(row, ['EXPLAIN', 'BILLBOARD_TYPE', 'REASON'], ''),
    explanation: pick(row, ['EXPLANATION'], ''),
    tradeId: rowTradeId(row),
    close: n(pick(row, ['CLOSE_PRICE'], 0)),
    changePct: n(pick(row, ['CHANGE_RATE'], 0)),
    buyAmount: n(pick(row, ['BUY_AMT', 'BILLBOARD_BUY_AMT'], 0)),
    sellAmount: n(pick(row, ['SELL_AMT', 'BILLBOARD_SELL_AMT'], 0)),
    netAmount: n(pick(row, ['BILLBOARD_NET_AMT'], 0)),
    turnover: n(pick(row, ['TURNOVERRATE'], 0)),
    amount: n(pick(row, ['AMOUNT', 'ACCUM_AMOUNT'], 0)),
    buySeat: pick(row, ['BUY_SEAT', 'BUY_SEAT_NEW'], ''),
    sellSeat: pick(row, ['SELL_SEAT', 'SELL_SEAT_NEW'], ''),
  };
}

function normalizeAmount(v) {
  return n(v);
}

function rowToSeat(row, idx) {
  const seatName = String(pick(row, [
    'OPERATEDEPT_NAME', 'OPERATEDEPT', 'DEPARTMENT_NAME', 'SALES_DEPT_NAME', 'TRADE_DEPT_NAME',
    'EXCHANGE_TRADE_BRANCH', 'MEMBER_NAME', 'SEAT_NAME', 'BUY_OPERATEDEPT_NAME', 'SELL_OPERATEDEPT_NAME'
  ], '')).trim();

  const buyAmount = normalizeAmount(pick(row, ['BUY_AMT', 'BUY_AMOUNT', 'BILLBOARD_BUY_AMT', 'BUY', 'B_AMT', 'AMT_BUY'], 0));
  const sellAmount = normalizeAmount(pick(row, ['SELL_AMT', 'SELL_AMOUNT', 'BILLBOARD_SELL_AMT', 'SELL', 'S_AMT', 'AMT_SELL'], 0));
  const netRaw = pick(row, ['NET_AMT', 'NET_AMOUNT', 'BILLBOARD_NET_AMT', 'NET', 'N_AMT'], null);
  const netAmount = netRaw === null ? buyAmount - sellAmount : normalizeAmount(netRaw);
  const direction = String(pick(row, ['TRADE_DIRECTION', 'DIRECTION', 'BUY_SELL_TYPE', 'BILLBOARD_DIRECTION', 'OPERATE_TYPE'], '') || '').trim();
  const rank = Number(pick(row, ['RANK', 'SORT', 'NO', 'ROWNUM', 'SERIALNO'], idx + 1));
  const tags = tagSeat(seatName);

  return {
    rank: Number.isFinite(rank) ? rank : idx + 1,
    direction,
    seatName,
    buyAmount,
    sellAmount,
    netAmount,
    buyAmountYi: yi(buyAmount),
    sellAmountYi: yi(sellAmount),
    netAmountYi: yi(netAmount),
    style: tags.style,
    tags: tags.tags,
    confidence: tags.confidence,
    official: tags.official,
    tagNote: tags.note,
    rawKeys: Object.keys(row || {}).slice(0, 30),
  };
}

function normalizeDetailRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(rowToSeat)
    .filter(x => x.seatName && (x.buyAmount || x.sellAmount || x.netAmount))
    .sort((a, b) => {
      const absB = Math.abs(b.netAmount || 0) || (b.buyAmount || 0) || (b.sellAmount || 0);
      const absA = Math.abs(a.netAmount || 0) || (a.buyAmount || 0) || (a.sellAmount || 0);
      return absB - absA;
    });
}

async function fetchReport({ reportName, tradeDate, symbol, filterOverride, sortColumns = 'TRADE_DATE,SECURITY_CODE', sortTypes = '-1,1', pageSize = 100 }) {
  const code = cleanCode(symbol);
  const filter = filterOverride || `(TRADE_DATE='${tradeDate}')(SECURITY_CODE='${code}')`;
  const url = buildUrl(EASTMONEY_DATA_URL, {
    sortColumns,
    sortTypes,
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
    timeoutMs: 8000,
    headers: { Referer: 'https://data.eastmoney.com/' },
  });
  const rows = data && data.result && Array.isArray(data.result.data) ? data.result.data : [];
  return { reportName, filter, rows, rawCount: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]).slice(0, 60) : [] };
}

async function fetchListRow(tradeDate, code) {
  const result = await fetchReport({
    reportName: LIST_REPORT,
    tradeDate,
    symbol: code,
    filterOverride: `(TRADE_DATE='${tradeDate}')`,
    pageSize: 200,
  });
  const matches = result.rows.filter(r => rowCode(r) === code);
  const listRows = matches.map(compactListRow).filter(Boolean);
  return {
    rawCount: result.rawCount,
    matchCount: matches.length,
    listRow: listRows[0] || null,
    listRows,
    tradeIds: [...new Set(listRows.map(x => x.tradeId).filter(Boolean))],
    sampleKeys: result.sampleKeys,
  };
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

async function fetchDragonTigerDetail({ date, symbol, deep = false, maxReports = 6, maxFilters = 18 }) {
  const code = cleanCode(symbol);
  if (!code) throw new Error('Missing symbol, e.g. ?symbol=002185');
  const tradeDate = formatDate(date);
  const attempts = [];
  let listCheck = null;

  try {
    listCheck = await fetchListRow(tradeDate, code);
    attempts.push({ type: 'list', reportName: LIST_REPORT, rawCount: listCheck.rawCount, matchCount: listCheck.matchCount, tradeIds: listCheck.tradeIds });
    if (!listCheck.listRow) {
      return {
        success: false,
        mode: 'dragon_tiger_detail_v4',
        status: 'not_on_list',
        source: 'eastmoney_datacenter',
        tradeDate,
        code,
        listRow: null,
        listRows: [],
        tradeIds: [],
        count: 0,
        seats: [],
        summary: summarizeSeats([]),
        attempts,
        explanation: '该股票在当日龙虎榜列表中未出现，因此没有席位明细。',
      };
    }
  } catch (err) {
    attempts.push({ type: 'list', reportName: LIST_REPORT, error: String(err && err.message ? err.message : err) });
  }

  if (!deep) {
    return {
      success: false,
      mode: 'dragon_tiger_detail_v4',
      status: listCheck && listCheck.listRow ? 'listed_detail_light' : 'fetch_error',
      source: 'eastmoney_datacenter',
      tradeDate,
      code,
      listRow: listCheck ? listCheck.listRow : null,
      listRows: listCheck ? listCheck.listRows : [],
      tradeIds: listCheck ? listCheck.tradeIds : [],
      count: 0,
      seats: [],
      summary: summarizeSeats([]),
      attempts,
      explanation: listCheck && listCheck.listRow
        ? '轻量模式：该股票已上龙虎榜，但未展开 TRADE_ID 深度席位搜索。需要席位营业部明细时请单票加 deep=true。'
        : '龙虎榜列表检查失败或上游异常，暂时无法确认是否上榜。',
    };
  }

  const filters = buildFilters(tradeDate, code, listCheck ? listCheck.tradeIds : []).slice(0, Math.max(3, Math.min(Number(maxFilters) || 18, 30)));
  const reports = DETAIL_REPORTS.slice(0, Math.max(1, Math.min(Number(maxReports) || 6, DETAIL_REPORTS.length)));

  for (const reportName of reports) {
    for (const filterOverride of filters) {
      try {
        const result = await fetchReport({
          reportName,
          tradeDate,
          symbol: code,
          filterOverride,
          sortColumns: 'TRADE_DATE,SECURITY_CODE,BUY_AMT',
          sortTypes: '-1,1,-1',
          pageSize: 200,
        });
        const matched = result.rows.filter(r => rowCode(r) === code || JSON.stringify(r).includes(code) || (listCheck && listCheck.tradeIds || []).some(id => JSON.stringify(r).includes(String(id))));
        attempts.push({ reportName, filter: filterOverride, rawCount: result.rawCount, matchCount: matched.length, sampleKeys: result.sampleKeys });
        const rowsForNormalize = matched.length ? matched : (filterOverride.includes('SECURITY_CODE') || filterOverride.includes('TRADE_ID') ? result.rows : []);
        if (rowsForNormalize.length) {
          const seats = normalizeDetailRows(rowsForNormalize);
          if (seats.length) {
            return {
              success: true,
              mode: 'dragon_tiger_detail_v4',
              status: 'detail_ok',
              source: 'eastmoney_datacenter',
              reportName,
              filter: filterOverride,
              tradeDate,
              code,
              listRow: listCheck ? listCheck.listRow : null,
              listRows: listCheck ? listCheck.listRows : [],
              tradeIds: listCheck ? listCheck.tradeIds : [],
              count: seats.length,
              seats,
              summary: summarizeSeats(seats),
              attempts,
              note: '席位标签中，机构专用/沪股通/深股通为名称直接识别；游资/量化/拉萨为规则疑似识别，非官方身份确认。',
            };
          }
        }
      } catch (err) {
        attempts.push({ reportName, filter: filterOverride, error: String(err && err.message ? err.message : err) });
      }
    }
  }

  return {
    success: false,
    mode: 'dragon_tiger_detail_v4',
    status: listCheck && listCheck.listRow ? 'listed_detail_missing' : 'fetch_error',
    source: 'eastmoney_datacenter',
    tradeDate,
    code,
    listRow: listCheck ? listCheck.listRow : null,
    listRows: listCheck ? listCheck.listRows : [],
    tradeIds: listCheck ? listCheck.tradeIds : [],
    count: 0,
    seats: [],
    summary: summarizeSeats([]),
    attempts,
    error: 'No seat detail rows returned from fallback reports',
    explanation: listCheck && listCheck.listRow
      ? '该股票已在龙虎榜列表中出现，但当前候选席位明细表没有返回可解析席位行；deep=true 已尝试 SECURITY_CODE 与 TRADE_ID 下钻过滤。'
      : '龙虎榜列表检查失败或上游异常，暂时无法确认是否上榜。',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const date = req.query.date;
  const symbols = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 8);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbol/symbols, e.g. ?date=20260709&symbol=002185' });

  const deepRequested = req.query.deep === 'true' || req.query.full === 'true';
  const deep = deepRequested && symbols.length <= 2;
  const skippedDeepReason = deepRequested && !deep ? 'deep=true only runs for at most 2 symbols at a time to avoid Vercel timeout; retry with one symbol.' : undefined;
  const maxReports = Number(req.query.maxReports || 6);
  const maxFilters = Number(req.query.maxFilters || 18);
  const ttlMs = Math.max(30000, Math.min(Number(req.query.ttlMs || 300000) || 300000, 900000));
  const key = `dragon-tiger-detail:v4:${formatDate(date)}:${symbols.join(',')}:deep=${deep}:mr=${maxReports}:mf=${maxFilters}`;

  try {
    const { value, cached: cacheHit } = await cached(key, ttlMs, async () => {
      const details = [];
      for (const symbol of symbols) {
        details.push(await fetchDragonTigerDetail({ date, symbol, deep, maxReports, maxFilters }));
      }
      return okBase({
        mode: 'dragon_tiger_detail_bundle_v4',
        count: details.length,
        symbols,
        date: formatDate(date),
        deep,
        skippedDeepReason,
        details,
        statusSummary: details.reduce((acc, x) => { acc[x.status || 'unknown'] = (acc[x.status || 'unknown'] || 0) + 1; return acc; }, {}),
        note: deep
          ? '深度模式：已加入 TRADE_ID 下钻过滤；游资识别为规则疑似标签，不能当官方事实。'
          : '轻量模式：默认只确认是否上榜并返回 TRADE_ID，避免 Vercel 超时。单票 deep=true 才尝试席位营业部明细。',
      });
    });
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({
      success: false,
      mode: 'dragon_tiger_detail_bundle_v4',
      error: String(err && err.message ? err.message : err),
      symbols,
      details: [],
    }));
  }
};

module.exports.fetchDragonTigerDetail = fetchDragonTigerDetail;
module.exports.formatDate = formatDate;
