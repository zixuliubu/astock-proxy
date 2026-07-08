const { json, setCors, parseSymbols, secid, buildUrl, requestJson, cached, okBase } = require('./_stock-utils');

async function fetchConceptsForCode(code) {
  const url = buildUrl('https://push2.eastmoney.com/api/qt/slist/get', {
    fltt: 2,
    invt: 2,
    secid: secid(code),
    spt: 3,
    pi: 0,
    pz: 200,
    po: 1,
    fields: 'f12,f14,f3,f128',
  });
  const data = await requestJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 10000 });
  let diff = data?.data?.diff || [];
  if (diff && !Array.isArray(diff) && typeof diff === 'object') diff = Object.values(diff);
  const boards = (Array.isArray(diff) ? diff : []).map((it) => ({
    code: it.f12 || '',
    name: it.f14 || '',
    changePct: it.f3 ?? null,
    leadStock: it.f128 || '',
  })).filter(x => x.code || x.name);
  return {
    code,
    total: boards.length,
    boards,
    conceptTags: boards.map(x => x.name).filter(Boolean),
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const symbols = parseSymbols(req.query.symbols || req.query.code || req.query.symbol, 8);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbols, e.g. ?symbols=600519,300750' });

  const ttlMs = Number(req.query.ttlMs || 5 * 60 * 1000);
  const diagnostics = {};
  const rows = [];
  for (const code of symbols) {
    try {
      const { value, cached: fromCache } = await cached(`stock-concepts:${code}`, ttlMs, () => fetchConceptsForCode(code));
      rows.push({ ...value, cached: fromCache });
    } catch (err) {
      diagnostics[code] = String(err && err.message ? err.message : err);
      rows.push({ code, total: 0, boards: [], conceptTags: [], error: diagnostics[code] });
    }
  }

  return json(res, 200, okBase({
    mode: 'stock_concepts_v1',
    source: 'eastmoney_slist',
    count: rows.length,
    data: rows,
    diagnostics,
    note: '东财 slist 混合返回行业/概念/地域板块，适合题材归因和板块联动验证。',
  }));
};
