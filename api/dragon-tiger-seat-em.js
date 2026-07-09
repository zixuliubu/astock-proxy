const { json, setCors, cleanCode, parseSymbols, requestJson, buildUrl, okBase, cached, yi } = require('./_stock-utils');
const { tagSeat } = require('./_seat-tags');

const EASTMONEY_DATA_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const REPORT_BUY = 'RPT_BILLBOARD_DAILYDETAILSBUY';
const REPORT_SELL = 'RPT_BILLBOARD_DAILYDETAILSSELL';

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

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function pick(row, keys, fallback = '') {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return fallback;
}

function compact(row) {
  const out = {};
  for (const k of Object.keys(row || {}).slice(0, 80)) {
    const v = row[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function seatName(row) {
  return String(pick(row, [
    'OPERATEDEPT_NAME', 'OPERATEDEPT', 'DEPARTMENT_NAME', 'SALES_DEPT_NAME', 'TRADE_DEPT_NAME',
    'SEAT_NAME', 'BRANCH_NAME', 'ORG_NAME_ABBR', 'OPERATEDEPT_NAME_ABBR'
  ], '')).trim();
}

function normalizeSeat(row, side, index) {
  const name = seatName(row);
  const buyAmount = n(pick(row, ['BUY', 'BUY_AMT', 'BUY_AMOUNT', 'BILLBOARD_BUY_AMT'], 0));
  const sellAmount = n(pick(row, ['SELL', 'SELL_AMT', 'SELL_AMOUNT', 'BILLBOARD_SELL_AMT'], 0));
  const netRaw = pick(row, ['NET_AMT', 'NET', 'NET_AMOUNT', 'BILLBOARD_NET_AMT'], null);
  const netAmount = netRaw === null ? buyAmount - sellAmount : n(netRaw);
  const tags = tagSeat(name);
  return {
    rank: index + 1,
    side,
    seatName: name,
    seatCode: String(pick(row, ['OPERATEDEPT_CODE', 'SEAT_CODE', 'OPERATEDEPT_CODE_OLD'], '') || '').trim(),
    seatType: String(pick(row, ['OPERATEDEPT_TYPE', 'TYPE', 'DEPT_TYPE'], '') || '').trim(),
    buyAmount,
    sellAmount,
    netAmount,
    buyAmountYi: yi(buyAmount),
    sellAmountYi: yi(sellAmount),
    netAmountYi: yi(netAmount),
    buyRatio: n(pick(row, ['BUY_RATIO', 'BUY_RATE'], 0)),
    sellRatio: n(pick(row, ['SELL_RATIO', 'SELL_RATE'], 0)),
    style: tags.style,
    tags: tags.tags,
    confidence: tags.confidence,
    official: tags.official,
    tagNote: tags.note,
    raw: compact(row),
  };
}

async function fetchSide({ tradeDate, code, side }) {
  const reportName = side === 'buy' ? REPORT_BUY : REPORT_SELL;
  const sortColumns = side === 'buy' ? 'BUY' : 'SELL';
  const filter = `(TRADE_DATE='${tradeDate}')(SECURITY_CODE="${code}")`;
  const url = buildUrl(EASTMONEY_DATA_URL, {
    reportName,
    columns: 'ALL',
    filter,
    pageNumber: 1,
    pageSize: 500,
    sortTypes: '-1',
    sortColumns,
    source: 'WEB',
    client: 'WEB',
    _: Date.now(),
  });
  const data = await requestJson(url, {
    timeoutMs: 10000,
    headers: { Referer: `https://data.eastmoney.com/stock/lhb/${code}.html` },
  });
  const rows = data && data.result && Array.isArray(data.result.data) ? data.result.data : [];
  const seats = rows.map((row, index) => normalizeSeat(row, side, index)).filter(x => x.seatName);
  return {
    reportName,
    filter,
    rawCount: rows.length,
    sampleKeys: rows[0] ? Object.keys(rows[0]).slice(0, 80) : [],
    sampleRows: rows.slice(0, 3).map(compact),
    seats,
  };
}

function summarize(buySeats, sellSeats) {
  const all = [...buySeats, ...sellSeats];
  const buyTotal = all.reduce((s, x) => s + n(x.buyAmount), 0);
  const sellTotal = all.reduce((s, x) => s + n(x.sellAmount), 0);
  const netTotal = all.reduce((s, x) => s + n(x.netAmount), 0);
  return {
    buyTotal,
    sellTotal,
    netTotal,
    buyTotalYi: yi(buyTotal),
    sellTotalYi: yi(sellTotal),
    netTotalYi: yi(netTotal),
    buySeatCount: buySeats.length,
    sellSeatCount: sellSeats.length,
    topBuy: buySeats[0] || null,
    topSell: sellSeats[0] || null,
  };
}

async function fetchSeat({ date, symbol }) {
  const tradeDate = formatDate(date);
  const code = cleanCode(symbol);
  const [buy, sell] = await Promise.all([
    fetchSide({ tradeDate, code, side: 'buy' }),
    fetchSide({ tradeDate, code, side: 'sell' }),
  ]);
  const status = buy.seats.length || sell.seats.length ? 'seat_found' : 'seat_missing';
  return okBase({
    mode: 'dragon_tiger_seat_em_v1',
    source: 'eastmoney_datacenter_akshare_verified',
    tradeDate,
    code,
    status,
    buySeats: buy.seats,
    sellSeats: sell.seats,
    summary: summarize(buy.seats, sell.seats),
    attempts: [
      { side: 'buy', reportName: buy.reportName, filter: buy.filter, rawCount: buy.rawCount, sampleKeys: buy.sampleKeys, sampleRows: buy.sampleRows },
      { side: 'sell', reportName: sell.reportName, filter: sell.filter, rawCount: sell.rawCount, sampleKeys: sell.sampleKeys, sampleRows: sell.sampleRows },
    ],
    note: '数据源为东方财富 datacenter 个股龙虎榜买入/卖出席位表；游资/量化/拉萨标签为规则疑似识别，非官方身份确认。',
  });
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });
  const symbols = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 1);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbol, e.g. ?date=20260709&symbol=002185' });
  const key = `dragon-tiger-seat-em:v1:${formatDate(req.query.date)}:${symbols[0]}`;
  try {
    const { value, cached: cacheHit } = await cached(key, 300000, async () => fetchSeat({ date: req.query.date, symbol: symbols[0] }));
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({ success: false, mode: 'dragon_tiger_seat_em_v1', error: String(err && err.message ? err.message : err) }));
  }
};
