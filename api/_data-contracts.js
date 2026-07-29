const REQUIRED_INDEX_CODES = ['000001', '399001', '399006'];
const TRADING_NODES = [
  '09:15', '09:20', '09:25',
  '09:35', '09:45', '09:55',
  '10:05', '10:15', '10:25', '10:35', '10:45', '10:55',
  '11:05', '11:15', '11:25',
  '13:05', '13:15', '13:25', '13:35', '13:45', '13:55',
  '14:05', '14:15', '14:25', '14:35', '14:45', '14:55', '15:00',
];

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function failure(code, message, diagnostics = {}) {
  return {
    success: false,
    status: code,
    error: { code, message },
    diagnostics,
    updateTime: new Date().toISOString(),
  };
}

function validateMarketOverview(indices, turnoverYi) {
  const rows = Array.isArray(indices) ? indices : [];
  const missing = REQUIRED_INDEX_CODES.filter(code => !rows.some(row => row.code === code));
  const invalid = rows
    .filter(row => REQUIRED_INDEX_CODES.includes(row.code))
    .filter(row => !row.name || !isNumber(row.price) || !isNumber(row.changePct))
    .map(row => row.code);
  if (missing.length || invalid.length) {
    return failure('DATA_INSUFFICIENT', 'Required index quotes are missing or invalid', {
      missingIndexCodes: missing,
      invalidIndexCodes: invalid,
    });
  }
  if (!isNumber(turnoverYi) || turnoverYi <= 0) {
    return failure('DATA_INSUFFICIENT', 'Shanghai and Shenzhen turnover is unavailable', {
      turnoverYi,
    });
  }
  return { success: true, status: 'OK' };
}

function validateSectorRows(rows) {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) return failure('DATA_INSUFFICIENT', 'Sector source returned no rows');
  const invalid = data.filter(row => (
    !row.name
    || !isNumber(row.changePct)
    || !isNumber(row.amountYi)
    || (!isNumber(row.mainNetYi) && !row.missingReason)
  ));
  if (invalid.length) {
    return failure('DATA_INSUFFICIENT', 'Sector rows are missing required market fields', {
      invalidCount: invalid.length,
      sample: invalid.slice(0, 3).map(row => ({ bk: row.bk, name: row.name, missingFields: row.missingFields })),
    });
  }
  return { success: true, status: 'OK' };
}

function summarizeCumulativeFlow(rows, wan, yi) {
  const safe = Array.isArray(rows) ? rows : [];
  const latest = safe.length ? safe[safe.length - 1] : null;
  const main = latest?.mainNetYuan ?? null;
  const large = latest?.largeNetYuan ?? null;
  const superNet = latest?.superNetYuan ?? null;
  return {
    points: safe.length,
    latest,
    aggregation: 'latest_cumulative_point',
    totalMainWan: wan(main),
    totalMainYi: yi(main),
    totalLargeWan: wan(large),
    totalSuperWan: wan(superNet),
    bias: main > 0 ? 'inflow' : main < 0 ? 'outflow' : 'neutral',
  };
}

function normalizeNode(value) {
  const node = String(value || '').trim();
  return TRADING_NODES.includes(node) ? node : null;
}

function chinaClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
  };
}

function timelineCoverage(timeline, requestedDate, now = new Date()) {
  const input = Array.isArray(timeline) ? timeline : [];
  const valid = input.filter(item => normalizeNode(item?.node));
  const invalidStoredNodes = input.filter(item => !normalizeNode(item?.node)).map(item => item?.node).filter(Boolean);
  const byNode = new Map();
  const overwrittenNodes = [];
  for (const item of valid) {
    if (byNode.has(item.node)) overwrittenNodes.push(item.node);
    byNode.set(item.node, item);
  }
  const sorted = TRADING_NODES.map(node => byNode.get(node)).filter(Boolean);
  const clock = chinaClock(now);
  const expectedNodes = requestedDate < clock.date
    ? TRADING_NODES
    : requestedDate > clock.date
      ? []
      : TRADING_NODES.filter(node => node <= clock.hm);
  const actualCapturedNodes = sorted.map(item => item.node);
  const missingNodes = expectedNodes.filter(node => !byNode.has(node));
  return {
    sorted,
    scheduledNodes: TRADING_NODES,
    expectedNodes,
    actualCapturedNodes,
    missingNodes,
    invalidStoredNodes,
    overwrittenNodes: [...new Set(overwrittenNodes)],
    complete: expectedNodes.length > 0 && missingNodes.length === 0,
  };
}

function validateDragonTigerRows(rows) {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) return failure('DATA_INSUFFICIENT', 'Dragon-tiger list returned no rows');
  const incomplete = data.filter(row => (
    !row.code
    || !row.name
    || !isNumber(row.buyAmount)
    || !isNumber(row.sellAmount)
    || !isNumber(row.amount)
    || row.buyAmount < 0
    || row.sellAmount < 0
    || row.amount <= 0
    || row.buyAmount + row.sellAmount <= 0
    || Math.abs(row.amount - row.buyAmount - row.sellAmount) > Math.max(1, row.amount * 0.001)
  ));
  if (incomplete.length) {
    return failure('DATA_INSUFFICIENT', 'Dragon-tiger rows have incomplete amount fields', {
      incompleteCount: incomplete.length,
      sampleCodes: incomplete.slice(0, 10).map(row => row.code),
    });
  }
  return { success: true, status: 'OK' };
}

function validateReviewMinimum(bundle) {
  const overview = bundle?.marketOverview;
  const required = {
    marketOverview: overview?.success === true
      && validateMarketOverview(overview.indices, overview.overview?.turnoverYi).success,
    marketSentiment: bundle?.marketSentiment?.success === true,
    lianbanLadder: bundle?.lianbanLadder?.success === true,
    limitUpPool: bundle?.limitUpPool?.success === true,
    brokenLimitPool: bundle?.brokenLimitPool?.success === true,
    limitDownPool: bundle?.limitDownPool?.success === true,
    hotSectors: bundle?.hotSectors?.success === true
      && Array.isArray(bundle?.hotSectors?.top)
      && bundle.hotSectors.top.length > 0,
    dragonTiger: bundle?.dragonTiger?.success === true,
    intradayTimeline: bundle?.intradayTimeline?.success === true,
  };
  const criticalFailures = Object.entries(required)
    .filter(([, ok]) => !ok)
    .map(([component]) => component);
  return {
    success: criticalFailures.length === 0,
    status: criticalFailures.length ? 'DATA_INSUFFICIENT' : 'OK',
    criticalFailures,
  };
}

function selectDragonTigerSeats(buySeats, sellSeats, tradeId) {
  const id = String(tradeId || '');
  const select = rows => (Array.isArray(rows) ? rows : [])
    .filter(row => !id || String(row.tradeId || '') === id);
  return {
    buySeats: select(buySeats),
    sellSeats: select(sellSeats),
  };
}

function summarizeDragonTigerSeats(buySeats, sellSeats, yi, listRow = null) {
  const buyers = Array.isArray(buySeats) ? buySeats : [];
  const sellers = Array.isArray(sellSeats) ? sellSeats : [];
  const seatTop5BuyTotal = buyers.reduce((sum, row) => sum + Number(row.buyAmount || 0), 0);
  const seatTop5SellTotal = sellers.reduce((sum, row) => sum + Number(row.sellAmount || 0), 0);
  const listBuy = Number(listRow?.buyAmount);
  const listSell = Number(listRow?.sellAmount);
  const listNet = Number(listRow?.netAmount);
  const buyTotal = Number.isFinite(listBuy) ? listBuy : seatTop5BuyTotal;
  const sellTotal = Number.isFinite(listSell) ? listSell : seatTop5SellTotal;
  const netTotal = Number.isFinite(listNet) ? listNet : buyTotal - sellTotal;
  const buyCoverage = buyTotal > 0 ? seatTop5BuyTotal / buyTotal : null;
  const sellCoverage = sellTotal > 0 ? seatTop5SellTotal / sellTotal : null;
  return {
    buyTotal,
    sellTotal,
    netTotal,
    buyTotalYi: yi(buyTotal),
    sellTotalYi: yi(sellTotal),
    netTotalYi: yi(netTotal),
    buySeatCount: buyers.length,
    sellSeatCount: sellers.length,
    seatTop5BuyTotal,
    seatTop5SellTotal,
    seatTop5BuyTotalYi: yi(seatTop5BuyTotal),
    seatTop5SellTotalYi: yi(seatTop5SellTotal),
    seatTop5BuyCoverage: buyCoverage,
    seatTop5SellCoverage: sellCoverage,
    reconciliationStatus: buyCoverage !== null && sellCoverage !== null
      && buyCoverage >= 0.99 && sellCoverage >= 0.99 ? 'MATCHED' : 'PARTIAL',
    topBuy: buyers[0] || null,
    topSell: sellers[0] || null,
    aggregation: Number.isFinite(listBuy) && Number.isFinite(listSell)
      ? 'authoritative_list_row_totals_with_selected_trade_id_top5_breakdown'
      : 'selected_trade_id_top5_breakdown_only',
  };
}

function compactReviewSector(row) {
  const value = row || {};
  return {
    name: value.name || value.sector || value.title || '',
    changePct: value.changePct ?? value.zdf ?? value.涨跌幅 ?? null,
    amount: value.amountYi ?? value.amount ?? value.成交额 ?? null,
    mainNetYi: value.mainNetYi ?? null,
    strength: value.strength ?? value.score ?? value.强度 ?? null,
    raw: value,
  };
}

module.exports = {
  REQUIRED_INDEX_CODES,
  TRADING_NODES,
  failure,
  isNumber,
  validateMarketOverview,
  validateSectorRows,
  summarizeCumulativeFlow,
  normalizeNode,
  chinaClock,
  timelineCoverage,
  validateDragonTigerRows,
  validateReviewMinimum,
  selectDragonTigerSeats,
  summarizeDragonTigerSeats,
  compactReviewSector,
};
