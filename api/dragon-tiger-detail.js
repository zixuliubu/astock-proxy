const { json, setCors, cleanCode, parseSymbols, requestJson, buildUrl, okBase, cached, yi } = require('./_stock-utils');
const { tagSeat, summarizeSeats } = require('./_seat-tags');

const EASTMONEY_DATA_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

const DETAIL_REPORTS = [
  'RPT_BILLBOARD_DAILYDETAILS',
  'RPT_DAILYBILLBOARD_DAILYDETAILS',
  'RPT_BILLBOARD_TRADEDETAILS',
  'RPT_DAILYBILLBOARD_TRADEDETAILS',
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

function normalizeAmount(v) {
  const value = n(v);
  // 东方财富多数金额字段单位为元；若上游返回万元量级，此处保持原值并在 amountYi 中体现。
  return value;
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
    .filter(x => x.seatName || x.buyAmount || x.sellAmount || x.netAmount)
    .sort((a, b) => {
      const absB = Math.abs(b.netAmount || 0) || (b.buyAmount || 0) || (b.sellAmount || 0);
      const absA = Math.abs(a.netAmount || 0) || (a.buyAmount || 0) || (a.sellAmount || 0);
      return absB - absA;
    });
}

async function fetchEastmoneyReport(reportName, tradeDate, symbol) {
  const code = cleanCode(symbol);
  const filter = `(TRADE_DATE='${tradeDate}')(SECURITY_CODE='${code}')`;
  const url = buildUrl(EASTMONEY_DATA_URL, {
    sortColumns: 'TRADE_DATE,SECURITY_CODE,BUY_AMT',
    sortTypes: '-1,1,-1',
    pageSize: 100,
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
  return { reportName, rows, rawCount: rows.length };
}

async function fetchDragonTigerDetail({ date, symbol }) {
  const code = cleanCode(symbol);
  if (!code) throw new Error('Missing symbol, e.g. ?symbol=002185');
  const tradeDate = formatDate(date);
  const attempts = [];

  for (const reportName of DETAIL_REPORTS) {
    try {
      const result = await fetchEastmoneyReport(reportName, tradeDate, code);
      attempts.push({ reportName, rawCount: result.rawCount });
      if (result.rows.length) {
        const seats = normalizeDetailRows(result.rows);
        return {
          success: true,
          mode: 'dragon_tiger_detail_v1',
          source: 'eastmoney_datacenter',
          reportName,
          tradeDate,
          code,
          count: seats.length,
          seats,
          summary: summarizeSeats(seats),
          attempts,
          note: '席位标签中，机构专用/沪股通/深股通为名称直接识别；游资/量化/拉萨为规则疑似识别，非官方身份确认。',
        };
      }
    } catch (err) {
      attempts.push({ reportName, error: String(err && err.message ? err.message : err) });
    }
  }

  return {
    success: false,
    mode: 'dragon_tiger_detail_v1',
    source: 'eastmoney_datacenter',
    tradeDate,
    code,
    count: 0,
    seats: [],
    summary: summarizeSeats([]),
    attempts,
    error: 'No seat detail rows returned from fallback reports',
    note: '可能原因：该票当日未上龙虎榜、龙虎榜尚未更新，或东方财富席位明细 reportName 发生变化。',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const date = req.query.date;
  const symbols = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 8);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbol/symbols, e.g. ?date=20260709&symbol=002185' });

  const ttlMs = Math.max(30000, Math.min(Number(req.query.ttlMs || 300000) || 300000, 900000));
  const key = `dragon-tiger-detail:v1:${formatDate(date)}:${symbols.join(',')}`;

  try {
    const { value, cached: cacheHit } = await cached(key, ttlMs, async () => {
      const details = [];
      for (const symbol of symbols) {
        details.push(await fetchDragonTigerDetail({ date, symbol }));
      }
      return okBase({
        mode: 'dragon_tiger_detail_bundle_v1',
        count: details.length,
        symbols,
        date: formatDate(date),
        details,
        note: '龙虎榜席位明细通常盘后更新；游资识别为规则疑似标签，不能当官方事实。',
      });
    });
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({
      success: false,
      mode: 'dragon_tiger_detail_bundle_v1',
      error: String(err && err.message ? err.message : err),
      symbols,
      details: [],
    }));
  }
};

module.exports.fetchDragonTigerDetail = fetchDragonTigerDetail;
