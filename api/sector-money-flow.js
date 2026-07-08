const { json, setCors, buildUrl, requestJson, cached, okBase, num, yi } = require('./_stock-utils');

function normalize(row, sourceKind) {
  return {
    bk: row.f12 || '',
    name: row.f14 || '',
    kind: sourceKind,
    changePct: num(row.f3),
    amountYi: yi(row.f6),
    mainNetYi: yi(row.f62),
    superNetYi: yi(row.f66),
    largeNetYi: yi(row.f72),
    midNetYi: yi(row.f78),
    smallNetYi: yi(row.f84),
    mainNetRatio: num(row.f184),
  };
}

async function fetchFlow(kind = 'concept', top = 30, sort = 'mainNet') {
  const fs = kind === 'industry' ? 'm:90+t:2' : kind === 'both' ? 'm:90+t:2,m:90+t:3' : 'm:90+t:3';
  const fidMap = { mainNet: 'f62', changePct: 'f3', amount: 'f6' };
  const fid = fidMap[sort] || 'f62';
  const url = buildUrl('https://push2.eastmoney.com/api/qt/clist/get', {
    pn: 1,
    pz: Math.min(Math.max(Number(top || 30), 1), 60),
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid,
    fs,
    fields: 'f12,f14,f3,f6,f62,f66,f72,f78,f84,f184',
  });
  const data = await requestJson(url, { headers: { Referer: 'https://data.eastmoney.com/bkzj/gn.html' }, timeoutMs: 12000 });
  let diff = data?.data?.diff || [];
  if (diff && !Array.isArray(diff) && typeof diff === 'object') diff = Object.values(diff);
  return (Array.isArray(diff) ? diff : []).map(x => normalize(x, kind)).filter(x => x.bk || x.name);
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const kind = ['concept', 'industry', 'both'].includes(req.query.kind) ? req.query.kind : 'concept';
  const top = Math.min(Math.max(Number(req.query.top || 30), 1), 60);
  const sort = ['mainNet', 'changePct', 'amount'].includes(req.query.sort) ? req.query.sort : 'mainNet';
  const ttlMs = Number(req.query.ttlMs || 3 * 60 * 1000);
  const key = `sector-money-flow:${kind}:${top}:${sort}`;

  try {
    const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchFlow(kind, top, sort));
    return json(res, 200, okBase({
      mode: 'sector_money_flow_v1',
      source: 'eastmoney_push2_board_flow',
      kind,
      sort,
      top,
      cached: fromCache,
      count: value.length,
      data: value,
      limits: { maxTop: 60, redisWrites: 0, defaultTtlMs: ttlMs },
      note: '板块资金流用于验证容量资金方向；不进入10分钟自动采样，避免高频打源。',
    }));
  } catch (err) {
    return json(res, 500, { success: false, mode: 'sector_money_flow_v1', error: String(err && err.message ? err.message : err), updateTime: new Date().toISOString() });
  }
};
