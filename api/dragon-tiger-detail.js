const { json, setCors, cleanCode, parseSymbols, requestJson, buildUrl, okBase, cached, yi } = require('./_stock-utils');
const { fetchSeat } = require('./dragon-tiger-seat-em');
const { selectDragonTigerSeats, summarizeDragonTigerSeats } = require('./_data-contracts');

const EASTMONEY_DATA_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const LIST_REPORT = 'RPT_DAILYBILLBOARD_DETAILSNEW';

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
  if (v === null || v === undefined || v === '') return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
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
    close: n(pick(row, ['CLOSE_PRICE'], null)),
    changePct: n(pick(row, ['CHANGE_RATE'], null)),
    buyAmount: n(pick(row, ['BILLBOARD_BUY_AMT', 'BUY_AMT'], null)),
    sellAmount: n(pick(row, ['BILLBOARD_SELL_AMT', 'SELL_AMT'], null)),
    netAmount: n(pick(row, ['BILLBOARD_NET_AMT'], null)),
    turnover: n(pick(row, ['TURNOVERRATE'], null)),
    amount: n(pick(row, ['BILLBOARD_DEAL_AMT', 'AMOUNT'], null)),
    buySeat: pick(row, ['BUY_SEAT', 'BUY_SEAT_NEW'], ''),
    sellSeat: pick(row, ['SELL_SEAT', 'SELL_SEAT_NEW'], ''),
  };
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
  if (!data?.result || !Array.isArray(data.result.data)) {
    throw new Error(`${reportName} result.data is unavailable`);
  }
  const rows = data.result.data;
  return { reportName, filter, rows, rawCount: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]).slice(0, 60) : [] };
}

async function fetchListRow(tradeDate, code) {
  const result = await fetchReport({
    reportName: LIST_REPORT,
    tradeDate,
    symbol: code,
    filterOverride: `(TRADE_DATE='${tradeDate}')`,
    pageSize: 5000,
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
    sourceState: result.rawCount > 0 ? 'OK' : 'EMPTY_OR_NOT_PUBLISHED',
  };
}

async function fetchDragonTigerDetail({ date, symbol, deep = false }) {
  const code = cleanCode(symbol);
  if (!code) throw new Error('Missing symbol, e.g. ?symbol=002185');
  const tradeDate = formatDate(date);
  const attempts = [];
  let listCheck = null;

  try {
    listCheck = await fetchListRow(tradeDate, code);
    attempts.push({
      type: 'list',
      reportName: LIST_REPORT,
      rawCount: listCheck.rawCount,
      matchCount: listCheck.matchCount,
      tradeIds: listCheck.tradeIds,
      sourceState: listCheck.sourceState,
    });
    if (listCheck.sourceState !== 'OK') {
      return {
        success: false,
        mode: 'dragon_tiger_detail_v7',
        status: 'fetch_error',
        source: 'eastmoney_datacenter',
        tradeDate,
        code,
        listRow: null,
        listRows: [],
        tradeIds: [],
        count: 0,
        seats: [],
        summary: null,
        attempts,
        error: 'Daily dragon-tiger list is empty or has not been published',
        explanation: '当日龙虎榜总表为空或尚未发布，无法核验该股票是否上榜。',
      };
    }
    if (!listCheck.listRow) {
      return {
        success: true,
        mode: 'dragon_tiger_detail_v7',
        status: 'not_on_list',
        source: 'eastmoney_datacenter',
        tradeDate,
        code,
        listRow: null,
        listRows: [],
        tradeIds: [],
        count: 0,
        seats: [],
        summary: null,
        attempts,
        explanation: '该股票在当日龙虎榜列表中未出现，因此没有席位明细。',
      };
    }
  } catch (err) {
    attempts.push({ type: 'list', reportName: LIST_REPORT, error: String(err && err.message ? err.message : err) });
  }

  if (!listCheck?.listRow) {
    return {
      success: false,
      mode: 'dragon_tiger_detail_v7',
      status: 'fetch_error',
      source: 'eastmoney_datacenter',
      tradeDate,
      code,
      listRow: null,
      listRows: [],
      tradeIds: [],
      count: 0,
      seats: [],
      summary: null,
      attempts,
      error: 'Daily dragon-tiger list could not be verified',
      explanation: '龙虎榜总表检查失败，无法确认是否上榜，也不会生成席位结论。',
    };
  }

  if (!deep) {
    return {
      success: false,
      mode: 'dragon_tiger_detail_v7',
      status: listCheck && listCheck.listRow ? 'listed_detail_light' : 'fetch_error',
      source: 'eastmoney_datacenter',
      tradeDate,
      code,
      listRow: listCheck ? listCheck.listRow : null,
      listRows: listCheck ? listCheck.listRows : [],
      tradeIds: listCheck ? listCheck.tradeIds : [],
      count: 0,
      seats: [],
      summary: null,
      attempts,
      explanation: listCheck && listCheck.listRow
        ? '轻量模式：该股票已上龙虎榜，但未展开 TRADE_ID 深度席位搜索。需要席位营业部明细时请单票加 deep=true。'
        : '龙虎榜列表检查失败或上游异常，暂时无法确认是否上榜。',
    };
  }

  try {
    if (!listCheck.tradeIds.length) {
      throw new Error('Listed row has no TRADE_ID; seat detail cannot be reconciled');
    }
    const verified = await fetchSeat({ date: tradeDate, symbol: code });
    attempts.push(...(verified.attempts || []).map(item => ({ type: 'akshare_verified_seat', ...item })));
    const selectedTradeId = listCheck?.listRow?.tradeId || '';
    const selected = selectDragonTigerSeats(verified.buySeats, verified.sellSeats, selectedTradeId);
    const seats = [...selected.buySeats, ...selected.sellSeats];
    if (seats.length) {
      return {
        success: true,
        mode: 'dragon_tiger_detail_v6',
        status: 'detail_ok',
        source: 'eastmoney_datacenter_akshare_verified',
        tradeDate,
        code,
        listRow: listCheck ? listCheck.listRow : null,
        listRows: listCheck ? listCheck.listRows : [],
        tradeIds: listCheck ? listCheck.tradeIds : [],
        selectedTradeId,
        count: seats.length,
        seats,
        buySeats: selected.buySeats,
        sellSeats: selected.sellSeats,
        summary: summarizeDragonTigerSeats(selected.buySeats, selected.sellSeats, yi, listCheck?.listRow),
        attempts,
        note: 'Seat rows are restricted to the selected list-row TRADE_ID. List totals use BILLBOARD list fields; selected TRADE_ID BUY/SELL rows are exposed as Top-5 coverage without being promoted to list totals; inferred seat tags are not official identity confirmation.',
      };
    }
  } catch (err) {
    attempts.push({ type: 'akshare_verified_seat', error: String(err && err.message ? err.message : err) });
  }

  return {
    success: false,
    mode: 'dragon_tiger_detail_v7',
    status: 'listed_detail_missing',
    source: 'eastmoney_datacenter_akshare_verified',
    tradeDate,
    code,
    listRow: listCheck.listRow,
    listRows: listCheck.listRows,
    tradeIds: listCheck.tradeIds,
    count: 0,
    seats: [],
    summary: null,
    attempts,
    error: 'Verified TRADE_ID seat detail is unavailable or incomplete',
    explanation: '该股票已上榜，但经 TRADE_ID 对账的买卖席位明细不可用或不完整，因此不生成席位汇总结论。',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const date = req.query.date;
  const symbols = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 8);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbol/symbols, e.g. ?date=20260709&symbol=002185' });

  const deepRequested = req.query.deep !== 'false' && req.query.light !== 'true';
  const deep = deepRequested && symbols.length <= 2;
  const skippedDeepReason = deepRequested && !deep ? 'deep=true only runs for at most 2 symbols at a time to avoid Vercel timeout; retry with one symbol.' : undefined;
  const requestedTtlMs = Number(req.query.ttlMs);
  const ttlMs = requestedTtlMs === 0
    ? 0
    : Math.max(30000, Math.min(Number(req.query.ttlMs || 300000) || 300000, 900000));
  const key = `dragon-tiger-detail:v7:${formatDate(date)}:${symbols.join(',')}:deep=${deep}`;

  try {
    const { value, cached: cacheHit } = await cached(key, ttlMs, async () => {
      const details = [];
      for (const symbol of symbols) {
        details.push(await fetchDragonTigerDetail({ date, symbol, deep }));
      }
      const bundleSuccess = details.every(item => item.success === true
        && ['detail_ok', 'not_on_list'].includes(item.status));
      return okBase({
        success: bundleSuccess,
        status: bundleSuccess ? 'OK' : 'DATA_INSUFFICIENT',
        mode: 'dragon_tiger_detail_bundle_v7',
        count: details.length,
        symbols,
        date: formatDate(date),
        deep,
        skippedDeepReason,
        details,
        statusSummary: details.reduce((acc, x) => { acc[x.status || 'unknown'] = (acc[x.status || 'unknown'] || 0) + 1; return acc; }, {}),
        note: deep
          ? '深度模式：已优先使用 TRADE_ID 下钻过滤；游资识别为规则疑似标签，不能当官方事实。'
          : '轻量模式：默认只确认是否上榜并返回 TRADE_ID，避免 Vercel 超时。单票 deep=true 才尝试席位营业部明细。',
      });
    });
    return json(res, value.success === true ? 200 : 503, { ...value, cacheHit });
  } catch (err) {
    return json(res, 503, okBase({
      success: false,
      status: 'UPSTREAM_FAILED',
      mode: 'dragon_tiger_detail_bundle_v5',
      error: String(err && err.message ? err.message : err),
      symbols,
      details: [],
    }));
  }
};

module.exports.fetchDragonTigerDetail = fetchDragonTigerDetail;
module.exports.formatDate = formatDate;
