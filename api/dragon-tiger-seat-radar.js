const { json, setCors, cleanCode, parseSymbols, requestJson, buildUrl, okBase, cached, yi } = require('./_stock-utils');
const { fetchDragonTigerDetail } = require('./dragon-tiger-detail');

const EASTMONEY_DATA_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

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

async function fetchDragonTigerList(date, limit = 30) {
  const tradeDate = formatDate(date);
  const url = buildUrl(EASTMONEY_DATA_URL, {
    sortColumns: 'TRADE_DATE,SECURITY_CODE',
    sortTypes: '-1,1',
    pageSize: Math.max(1, Math.min(Number(limit) || 30, 100)),
    pageNumber: 1,
    reportName: 'RPT_DAILYBILLBOARD_DETAILS',
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    filter: `(TRADE_DATE='${tradeDate}')`,
    _: Date.now(),
  });
  const data = await requestJson(url, { timeoutMs: 10000, headers: { Referer: 'https://data.eastmoney.com/' } });
  const rows = data && data.result && Array.isArray(data.result.data) ? data.result.data : [];
  return rows.map(r => ({
    tradeDate: r.TRADE_DATE,
    code: cleanCode(r.SECURITY_CODE),
    name: r.SECURITY_NAME_ABBR,
    reason: r.EXPLAIN || r.BILLBOARD_TYPE || '',
    close: n(r.CLOSE_PRICE),
    changePct: n(r.CHANGE_RATE),
    buyAmount: n(r.BUY_AMT),
    sellAmount: n(r.SELL_AMT),
    netAmount: n(r.BILLBOARD_NET_AMT),
    amount: n(r.AMOUNT),
    turnover: n(r.TURNOVERRATE),
  })).filter(x => x.code);
}

function scoreOne(listRow, detail) {
  const s = detail && detail.summary ? detail.summary : {};
  let score = 50;
  const positives = [];
  const risks = [];

  const net = n(s.netTotal || listRow.netAmount);
  const institutionNet = n(s.institutionNet);
  const northboundNet = n(s.northboundNet);
  const lhasaNet = n(s.lhasaNet);
  const hotMoneyNet = n(s.suspectedHotMoneyNet);
  const salesDeptNet = n(s.salesDeptNet);
  const concentration = s.topBuyConcentration;

  if (net > 0) { score += 10; positives.push('龙虎榜整体净买入'); }
  if (net < 0) { score -= 12; risks.push('龙虎榜整体净卖出'); }
  if (institutionNet > 0) { score += 16; positives.push('机构净买入'); }
  if (institutionNet < 0) { score -= 16; risks.push('机构净卖出'); }
  if (northboundNet > 0) { score += 8; positives.push('陆股通净买入'); }
  if (hotMoneyNet > 0) { score += 10; positives.push('疑似活跃游资净买入'); }
  if (salesDeptNet > 0) { score += 6; positives.push('营业部资金净买入'); }
  if (lhasaNet > 0) { score -= 8; risks.push('拉萨系净买入，次日波动可能加大'); }
  if (concentration !== null && concentration !== undefined && concentration >= 0.45) { score -= 10; risks.push('买一集中度较高，一家独大风险'); }
  if (detail && detail.success === false) { score -= 8; risks.push('席位明细暂缺，仅能用列表级数据'); }

  if (listRow.changePct >= 9) positives.push('个股涨幅强，情绪辨识度较高');
  if (/连续|涨停|日价格涨幅|换手/.test(String(listRow.reason || ''))) positives.push('上榜原因具备短线辨识度');

  score = Math.max(0, Math.min(100, Math.round(score)));
  let label = '中性榜';
  if (score >= 80) label = '高质量合力榜';
  else if (score >= 65) label = '偏强榜';
  else if (score >= 50) label = '中性榜';
  else if (score >= 35) label = '分歧风险榜';
  else label = '高风险榜';

  return {
    code: listRow.code,
    name: listRow.name,
    reason: listRow.reason,
    close: listRow.close,
    changePct: listRow.changePct,
    listNetAmountYi: yi(listRow.netAmount),
    amountYi: yi(listRow.amount),
    turnover: listRow.turnover,
    score,
    label,
    positives,
    risks: [...new Set([...(s.riskFlags || []), ...risks])],
    qualityTags: [...new Set([...(s.qualityTags || []), ...positives])],
    summary: {
      netTotalYi: yi(s.netTotal || listRow.netAmount),
      institutionNetYi: yi(institutionNet),
      northboundNetYi: yi(northboundNet),
      suspectedHotMoneyNetYi: yi(hotMoneyNet),
      lhasaNetYi: yi(lhasaNet),
      salesDeptNetYi: yi(salesDeptNet),
      topBuyConcentration: concentration ?? null,
      topBuy: s.topBuy ? { seatName: s.topBuy.seatName, buyAmountYi: s.topBuy.buyAmountYi, style: s.topBuy.style, tags: s.topBuy.tags } : null,
      topSell: s.topSell ? { seatName: s.topSell.seatName, sellAmountYi: s.topSell.sellAmountYi, style: s.topSell.style, tags: s.topSell.tags } : null,
    },
    detailSuccess: detail ? detail.success !== false : false,
    detailReportName: detail ? detail.reportName : undefined,
  };
}

function buildRadar(scored) {
  const list = Array.isArray(scored) ? scored : [];
  return {
    topQuality: [...list].sort((a, b) => b.score - a.score).slice(0, 10),
    institutionNetBuy: [...list].filter(x => (x.summary.institutionNetYi || 0) > 0).sort((a, b) => (b.summary.institutionNetYi || 0) - (a.summary.institutionNetYi || 0)).slice(0, 10),
    suspectedHotMoney: [...list].filter(x => (x.summary.suspectedHotMoneyNetYi || 0) > 0).sort((a, b) => (b.summary.suspectedHotMoneyNetYi || 0) - (a.summary.suspectedHotMoneyNetYi || 0)).slice(0, 10),
    lhasaHeavy: [...list].filter(x => (x.summary.lhasaNetYi || 0) > 0).sort((a, b) => (b.summary.lhasaNetYi || 0) - (a.summary.lhasaNetYi || 0)).slice(0, 10),
    highRisk: [...list].filter(x => x.score < 50 || (x.risks || []).length).sort((a, b) => a.score - b.score).slice(0, 10),
  };
}

async function fetchRadar({ date, symbols, limit }) {
  const tradeDate = formatDate(date);
  const inputSymbols = parseSymbols(symbols, 20);
  let list = [];

  if (inputSymbols.length) {
    const fullList = await fetchDragonTigerList(tradeDate, 100);
    const byCode = new Map(fullList.map(x => [x.code, x]));
    list = inputSymbols.map(code => byCode.get(code) || { code, name: '', reason: '', netAmount: 0, amount: 0, changePct: 0, turnover: 0 });
  } else {
    list = await fetchDragonTigerList(tradeDate, Math.max(1, Math.min(Number(limit) || 30, 50)));
  }

  const scored = [];
  for (const row of list.slice(0, 20)) {
    const detail = await fetchDragonTigerDetail({ date: tradeDate, symbol: row.code });
    scored.push(scoreOne(row, detail));
  }

  return {
    success: true,
    mode: 'dragon_tiger_seat_radar_v1',
    tradeDate,
    count: scored.length,
    data: scored,
    radar: buildRadar(scored),
    note: '席位雷达只用于盘后验证和次日对手盘质量判断；游资/量化/拉萨为规则疑似识别，非官方身份确认。',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const date = req.query.date;
  const symbols = req.query.symbols || req.query.symbol || req.query.code;
  const limit = Number(req.query.limit || 30);
  const ttlMs = Math.max(30000, Math.min(Number(req.query.ttlMs || 300000) || 300000, 900000));
  const key = `dragon-tiger-seat-radar:v1:${formatDate(date)}:${symbols || ''}:limit=${limit}`;

  try {
    const { value, cached: cacheHit } = await cached(key, ttlMs, async () => okBase(await fetchRadar({ date, symbols, limit })));
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({
      success: false,
      mode: 'dragon_tiger_seat_radar_v1',
      error: String(err && err.message ? err.message : err),
      data: [],
      radar: buildRadar([]),
    }));
  }
};
