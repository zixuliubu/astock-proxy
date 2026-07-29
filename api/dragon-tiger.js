const { buildUrl, requestJson } = require('./_stock-utils');
const { failure, validateDragonTigerRows } = require('./_data-contracts');

function chinaToday() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function formatDate(date) {
  const value = String(date || '').trim();
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return chinaToday();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalize(row) {
  return {
    tradeDate: row.TRADE_DATE,
    code: String(row.SECURITY_CODE || ''),
    name: row.SECURITY_NAME_ABBR || '',
    close: number(row.CLOSE_PRICE),
    changePct: number(row.CHANGE_RATE),
    reason: row.EXPLANATION || row.EXPLAIN || '',
    interpretation: row.EXPLAIN || '',
    buyAmount: number(row.BILLBOARD_BUY_AMT),
    sellAmount: number(row.BILLBOARD_SELL_AMT),
    netAmount: number(row.BILLBOARD_NET_AMT),
    amount: number(row.BILLBOARD_DEAL_AMT),
    marketAmount: number(row.ACCUM_AMOUNT),
    turnover: number(row.TURNOVERRATE),
  };
}

async function fetchDragonTiger(date) {
  const tradeDate = formatDate(date);
  const url = buildUrl('https://datacenter-web.eastmoney.com/api/data/v1/get', {
    sortColumns: 'SECURITY_CODE,TRADE_DATE',
    sortTypes: '1,-1',
    pageSize: 5000,
    pageNumber: 1,
    reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
    columns: [
      'SECURITY_CODE', 'SECUCODE', 'SECURITY_NAME_ABBR', 'TRADE_DATE', 'EXPLAIN',
      'CLOSE_PRICE', 'CHANGE_RATE', 'BILLBOARD_NET_AMT', 'BILLBOARD_BUY_AMT',
      'BILLBOARD_SELL_AMT', 'BILLBOARD_DEAL_AMT', 'ACCUM_AMOUNT',
      'TURNOVERRATE', 'EXPLANATION',
    ].join(','),
    source: 'WEB',
    client: 'WEB',
    filter: `(TRADE_DATE='${tradeDate}')`,
  });
  const payload = await requestJson(url, {
    headers: { Referer: 'https://data.eastmoney.com/stock/tradedetail.html' },
    timeoutMs: 12000,
  });
  return (payload?.result?.data || []).map(normalize);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json(failure('METHOD_NOT_ALLOWED', 'Method not allowed'));

  try {
    const data = await fetchDragonTiger(req.query.date);
    const validation = validateDragonTigerRows(data);
    if (!validation.success) {
      return res.status(503).json({
        ...validation,
        mode: 'dragon_tiger_list_v2',
        date: formatDate(req.query.date),
        data,
      });
    }
    const sorted = [...data].sort((a, b) => Math.abs(b.netAmount) - Math.abs(a.netAmount));
    return res.status(200).json({
      success: true,
      status: 'OK',
      mode: 'dragon_tiger_list_v2',
      source: 'eastmoney_RPT_DAILYBILLBOARD_DETAILSNEW_akshare_contract',
      count: sorted.length,
      data: sorted,
      summary: {
        topNetBuy: [...data].sort((a, b) => b.netAmount - a.netAmount).slice(0, 10),
        topNetSell: [...data].sort((a, b) => a.netAmount - b.netAmount).slice(0, 10),
      },
      updateTime: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      ...failure('UPSTREAM_FAILED', String(err?.message || err)),
      mode: 'dragon_tiger_list_v2',
      data: [],
    });
  }
};

module.exports.fetchDragonTiger = fetchDragonTiger;
module.exports.normalize = normalize;
module.exports.formatDate = formatDate;
