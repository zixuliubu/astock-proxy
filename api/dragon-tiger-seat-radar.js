const { json, setCors, cleanCode, parseSymbols, requestJson, buildUrl, okBase, cached, yi } = require('./_stock-utils');
const { fetchDragonTigerDetail, formatDate } = require('./dragon-tiger-detail');

const EASTMONEY_DATA_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

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
    buyAmount: n(r.BUY_AMT || r.BILLBOARD_BUY_AMT),
    sellAmount: n(r.SELL_AMT || r.BILLBOARD_SELL_AMT),
    netAmount: n(r.BILLBOARD_NET_AMT),
    amount: n(r.AMOUNT || r.ACCUM_AMOUNT),
    turnover: n(r.TURNOVERRATE),
  })).filter(x => x.code);
}

function scoreOne(listRow, detail) {
  const status = detail && detail.status ? detail.status : 'unknown';
  const s = detail && detail.summary ? detail.summary : {};
  let score = 50;
  const positives = [];
  const risks = [];
  const diagnostics = [];

  const net = n(s.netTotal || listRow.netAmount);
  const institutionNet = n(s.institutionNet);
  const northboundNet = n(s.northboundNet);
  const lhasaNet = n(s.lhasaNet);
  const hotMoneyNet = n(s.suspectedHotMoneyNet);
  const salesDeptNet = n(s.salesDeptNet);
  const concentration = s.topBuyConcentration;

  if (status === 'not_on_list') {
    score = 0;
    diagnostics.push('未上龙虎榜：没有席位明细，不能做席位质量判断');
  } else {
    if (net > 0) { score += 10; positives.push('龙虎榜整体净买入'); }
    if (net < 0) { score -= 12; risks.push('龙虎榜整体净卖出'); }
    if (institutionNet > 0) { score += 16; positives.push('机构净买入'); }
    if (institutionNet < 0) { score -= 16; risks.push('机构净卖出'); }
    if (northboundNet > 0) { score += 8; positives.push('陆股通净买入'); }
    if (hotMoneyNet > 0) { score += 10; positives.push('疑似活跃游资净买入'); }
    if (salesDeptNet > 0) { score += 6; positives.push('营业部资金净买入'); }
    if (lhasaNet > 0) { score -= 8; risks.push('拉萨系净买入，次日波动可能加大'); }
    if (concentration !== null && concentration !== undefined && concentration >= 0.45) { score -= 10; risks.push('买一集中度较高，一家独大风险'); }
    if (status === 'listed_detail_missing') { score -= 4; diagnostics.push('已上榜但席位明细未返回，需单票 deep=true 进一步确认'); }
    if (status === 'listed_detail_light') { score -= 2; diagnostics.push('轻量模式：已确认上榜，但未展开席位明细；不能当完整席位质量结论'); }
    if (status === 'fetch_error') { score -= 8; diagnostics.push('龙虎榜列表/明细抓取异常'); }
  }

  if (listRow.changePct >= 9) positives.push('个股涨幅强，情绪辨识度较高');
  if (/连续|涨停|日价格涨幅|换手/.test(String(listRow.reason || ''))) positives.push('上榜原因具备短线辨识度');

  score = Math.max(0, Math.min(100, Math.round(score)));
  let label = '中性榜';
  if (status === 'not_on_list') label = '未上榜';
  else if (status === 'listed_detail_light') label = '已上榜轻量确认';
  else if (status === 'listed_detail_missing') label = '已上榜但席位缺失';
  else if (score >= 80) label = '高质量合力榜';
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
    status,
    score,
    label,
    positives,
    risks: [...new Set([...(s.riskFlags || []), ...risks])],
    diagnostics,
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
    detailSuccess: status === 'detail_ok',
    detailReportName: detail ? detail.reportName : undefined,
    listRow: detail ? detail.listRow : undefined,
  };
}

function buildRadar(scored) {
  const list = Array.isArray(scored) ? scored : [];
  return {
    topQuality: [...list].filter(x => x.status !== 'not_on_list').sort((a, b) => b.score - a.score).slice(0, 10),
    institutionNetBuy: [...list].filter(x => (x.summary.institutionNetYi || 0) > 0).sort((a, b) => (b.summary.institutionNetYi || 0) - (a.summary.institutionNetYi || 0)).slice(0, 10),
    suspectedHotMoney: [...list].filter(x => (x.summary.suspectedHotMoneyNetYi || 0) > 0).sort((a, b) => (b.summary.suspectedHotMoneyNetYi || 0) - (a.summary.suspectedHotMoneyNetYi || 0)).slice(0, 10),
    lhasaHeavy: [...list].filter(x => (x.summary.lhasaNetYi || 0) > 0).sort((a, b) => (b.summary.lhasaNetYi || 0) - (a.summary.lhasaNetYi || 0)).slice(0, 10),
    detailLight: [...list].filter(x => x.status === 'listed_detail_light').slice(0, 20),
    detailMissing: [...list].filter(x => x.status === 'listed_detail_missing').slice(0, 20),
    notOnList: [...list].filter(x => x.status === 'not_on_list').slice(0, 20),
    highRisk: [...list].filter(x => x.status !== 'not_on_list' && (x.score < 50 || (x.risks || []).length)).sort((a, b) => a.score - b.score).slice(0, 10),
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
    const detail = await fetchDragonTigerDetail({ date: tradeDate, symbol: row.code, deep: false });
    scored.push(scoreOne(row, detail));
  }

  return {
    success: true,
    mode: 'dragon_tiger_seat_radar_v3',
    tradeDate,
    count: scored.length,
    statusSummary: scored.reduce((acc, x) => { acc[x.status || 'unknown'] = (acc[x.status || 'unknown'] || 0) + 1; return acc; }, {}),
    data: scored,
    radar: buildRadar(scored),
    note: '席位雷达默认轻量确认是否上榜，不展开席位明细，避免 Vercel 超时；需要真实营业部字段时单票调用 dragon-tiger-detail 或 debug 的 deep=true。游资/量化/拉萨为规则疑似识别，非官方身份确认。',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const date = req.query.date;
  const symbols = req.query.symbols || req.query.symbol || req.query.code;
  const limit = Number(req.query.limit || 30);
  const ttlMs = Math.max(30000, Math.min(Number(req.query.ttlMs || 300000) || 300000, 900000));
  const key = `dragon-tiger-seat-radar:v3:${formatDate(date)}:${symbols || ''}:limit=${limit}`;

  try {
    const { value, cached: cacheHit } = await cached(key, ttlMs, async () => okBase(await fetchRadar({ date, symbols, limit })));
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    return json(res, 200, okBase({
      success: false,
      mode: 'dragon_tiger_seat_radar_v3',
      error: String(err && err.message ? err.message : err),
      data: [],
      radar: buildRadar([]),
    }));
  }
};
