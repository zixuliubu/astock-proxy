const { json, setCors, parseSymbols, buildUrl, requestJson, cached, okBase } = require('./_stock-utils');

const EM_HOT_BODY = { appId: 'appId01', globalId: '786e4c21-70dc-435a-93bb-38' };

async function fetchThsHot(period = 'hour') {
  const url = buildUrl('https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock', {
    stock_type: 'a',
    type: period === 'day' ? 'day' : 'hour',
    list_type: 'normal',
  });
  const data = await requestJson(url, { timeoutMs: 10000 });
  const list = data?.data?.stock_list || [];
  return list.map((it) => {
    const tag = it.tag || {};
    return {
      source: 'ths',
      rank: it.order ?? null,
      code: it.code || '',
      name: it.name || '',
      heat: it.rate ?? null,
      pct: it.rise_and_fall ?? null,
      rankChg: it.hot_rank_chg ?? null,
      concepts: tag.concept_tag || [],
      tag: tag.popularity_tag || '',
    };
  });
}

async function fetchEastmoneyHot(top = 50) {
  const rankData = await requestJson('https://emappdata.eastmoney.com/stockrank/getAllCurrentList', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...EM_HOT_BODY, marketType: '', pageNo: 1, pageSize: top }),
    timeoutMs: 10000,
  });
  const list = rankData?.data || [];
  if (!Array.isArray(list) || !list.length) return [];
  const secids = list.map((it) => `${String(it.sc || '').startsWith('SZ') ? '0' : '1'}.${String(it.sc || '').slice(2)}`).join(',');
  const quoteUrl = buildUrl('https://push2.eastmoney.com/api/qt/ulist.np/get', {
    ut: 'f057cbcbce2a86e2866ab8877db1d059',
    fltt: 2,
    invt: 2,
    fields: 'f14,f3,f12,f2',
    secids,
  });
  let quoteMap = {};
  try {
    const q = await requestJson(quoteUrl, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 10000 });
    let diff = q?.data?.diff || [];
    if (diff && !Array.isArray(diff) && typeof diff === 'object') diff = Object.values(diff);
    quoteMap = Object.fromEntries((Array.isArray(diff) ? diff : []).map(x => [x.f12, x]));
  } catch (err) {}
  return list.map((it) => {
    const code = String(it.sc || '').slice(2);
    const q = quoteMap[code] || {};
    return {
      source: 'eastmoney',
      rank: it.rk ?? null,
      code,
      name: q.f14 || '',
      price: q.f2 ?? null,
      pct: q.f3 ?? null,
      rankChg: it.hisRc ?? null,
    };
  });
}

async function fetchHotConcept(code) {
  const prefix = code.startsWith('6') ? 'SH' : 'SZ';
  const data = await requestJson('https://emappdata.eastmoney.com/stockrank/getHotStockRankList', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...EM_HOT_BODY, srcSecurityCode: prefix + code }),
    timeoutMs: 10000,
  });
  const list = data?.data || [];
  return (Array.isArray(list) ? list : []).map(x => ({
    concept: x.conceptName || '',
    bk: x.conceptId || '',
    hit: x.hitCount ?? null,
  })).filter(x => x.concept || x.bk);
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const top = Math.min(Math.max(Number(req.query.top || 50), 1), 100);
  const period = req.query.period === 'day' ? 'day' : 'hour';
  const source = String(req.query.source || 'both');
  const symbols = parseSymbols(req.query.symbols || '', 8);
  const ttlMs = Number(req.query.ttlMs || 60 * 1000);
  const diagnostics = {};

  const result = { ths: [], eastmoney: [], hotConcepts: {} };
  const tasks = [];
  if (source === 'both' || source === 'ths') tasks.push(cached(`ths-hot:${period}:${top}`, ttlMs, () => fetchThsHot(period)).then(x => { result.ths = x.value.slice(0, top); result.thsCached = x.cached; }).catch(e => { diagnostics.ths = String(e.message || e); }));
  if (source === 'both' || source === 'eastmoney') tasks.push(cached(`em-hot:${top}`, ttlMs, () => fetchEastmoneyHot(top)).then(x => { result.eastmoney = x.value.slice(0, top); result.eastmoneyCached = x.cached; }).catch(e => { diagnostics.eastmoney = String(e.message || e); }));
  for (const code of symbols) {
    tasks.push(cached(`em-hot-concept:${code}`, 5 * 60 * 1000, () => fetchHotConcept(code)).then(x => { result.hotConcepts[code] = x.value; }).catch(e => { diagnostics[`hotConcept:${code}`] = String(e.message || e); result.hotConcepts[code] = []; }));
  }
  await Promise.all(tasks);

  return json(res, 200, okBase({
    mode: 'stock_popularity_v1',
    source,
    period,
    top,
    count: { ths: result.ths.length, eastmoney: result.eastmoney.length, hotConcepts: Object.keys(result.hotConcepts).length },
    data: result,
    diagnostics,
    note: '热榜/人气榜只作市场关注度和踏空情绪观察，不作为买入依据。',
  }));
};
