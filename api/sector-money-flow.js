const { json, setCors, buildUrl, requestJson, cached, okBase, num, yi } = require('./_stock-utils');

function normalize(row, sourceKind, source) {
  return {
    bk: row.f12 || '',
    name: row.f14 || '',
    kind: sourceKind,
    source,
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

function fsFor(kind) {
  if (kind === 'industry') return 'm:90+t:2';
  if (kind === 'both') return 'm:90+t:2,m:90+t:3';
  return 'm:90+t:3';
}

function parseDiff(data) {
  let diff = data?.data?.diff || [];
  if (diff && !Array.isArray(diff) && typeof diff === 'object') diff = Object.values(diff);
  return Array.isArray(diff) ? diff : [];
}

async function requestBoardClist(host, params, label) {
  const url = buildUrl(`${host}/api/qt/clist/get`, params);
  const data = await requestJson(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://quote.eastmoney.com/',
      Origin: 'https://quote.eastmoney.com',
    },
    timeoutMs: 12000,
  });
  const rows = parseDiff(data);
  if (!rows.length) throw new Error(`${label} empty`);
  return rows;
}

async function fetchFlow(kind = 'concept', top = 30, sort = 'mainNet') {
  const fidMap = { mainNet: 'f62', changePct: 'f3', amount: 'f6' };
  const fid = fidMap[sort] || 'f62';
  const pz = Math.min(Math.max(Number(top || 30), 1), 60);
  const baseParams = {
    pn: 1,
    pz,
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid,
    fs: fsFor(kind),
    fields: 'f12,f14,f3,f6,f62,f66,f72,f78,f84,f184',
  };

  const attempts = [];
  const candidates = [
    ['push2', 'https://push2.eastmoney.com', baseParams],
    ['hsmarketwg', 'https://push2.hsmarketwg.eastmoney.com', { ...baseParams, cb: 'jQuery' }],
  ];

  for (const [label, host, params] of candidates) {
    try {
      const rows = await requestBoardClist(host, params, label);
      return {
        source: `eastmoney_${label}_board_flow`,
        data: rows.map(x => normalize(x, kind, label)).filter(x => x.bk || x.name),
        attempts,
      };
    } catch (err) {
      attempts.push({ source: label, error: String(err && err.message ? err.message : err) });
    }
  }

  // 兜底：用已跑通的 hotboard/get 拿板块强度与成交额。该源不一定有 f62 主力净流入字段，mainNetYi 会为空。
  try {
    const hotKind = kind === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
    const url = buildUrl('https://push2.hsmarketwg.eastmoney.com/api/qt/clist/hotboard/get', {
      pn: 1,
      pz,
      po: 1,
      np: 1,
      fltt: 2,
      invt: 2,
      fid: sort === 'amount' ? 'f6' : 'f3',
      fs: hotKind,
      fields: 'f12,f14,f2,f3,f5,f6,f62,f66,f72,f78,f84,f184',
      cb: 'jQuery',
    });
    const data = await requestJson(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 10000 });
    const rows = parseDiff(data);
    if (!rows.length) throw new Error('hotboard empty');
    return {
      source: 'eastmoney_hsmarketwg_hotboard_fallback',
      data: rows.map(x => normalize(x, kind, 'hotboard')).filter(x => x.bk || x.name),
      attempts,
      fallbackNote: 'hotboard 兜底源偏板块强度/成交额，主力净流入字段可能为空。',
    };
  } catch (err) {
    attempts.push({ source: 'hotboard', error: String(err && err.message ? err.message : err) });
  }

  return { source: 'none', data: [], attempts, fallbackNote: '全部上游失败，返回空数组而不是 502。' };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const kind = ['concept', 'industry', 'both'].includes(req.query.kind) ? req.query.kind : 'concept';
  const top = Math.min(Math.max(Number(req.query.top || 30), 1), 60);
  const sort = ['mainNet', 'changePct', 'amount'].includes(req.query.sort) ? req.query.sort : 'mainNet';
  const ttlMs = Number(req.query.ttlMs || 3 * 60 * 1000);
  const key = `sector-money-flow:v2:${kind}:${top}:${sort}`;

  try {
    const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchFlow(kind, top, sort));
    return json(res, 200, okBase({
      mode: 'sector_money_flow_v2',
      source: value.source,
      kind,
      sort,
      top,
      cached: fromCache,
      count: value.data.length,
      data: value.data,
      diagnostics: { attempts: value.attempts || [], fallbackNote: value.fallbackNote || '' },
      limits: { maxTop: 60, redisWrites: 0, defaultTtlMs: ttlMs },
      note: '板块资金流用于验证容量资金方向；若资金流字段为空，会退化为板块强度/成交额兜底，不进入10分钟自动采样。',
    }));
  } catch (err) {
    return json(res, 200, okBase({ success: false, mode: 'sector_money_flow_v2', error: String(err && err.message ? err.message : err), data: [], diagnostics: { reason: 'unexpected handler error' } }));
  }
};
