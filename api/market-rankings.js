const { json, setCors, buildUrl, requestJson, cached, okBase, num } = require('./_stock-utils');
const RANKINGS = { speed: 'f22', change: 'f3', amount: 'f6', turnover: 'f8', volume_ratio: 'f10' };

function normalize(row) {
  return { code: String(row.f12 || ''), name: row.f14 || '', price: num(row.f2), change_pct: num(row.f3), speed_pct: num(row.f22), amount: num(row.f6), turnover_rate: num(row.f8), volume_ratio: num(row.f10), amplitude: num(row.f7), industry: row.f100 || null, appeared_in: [], source: 'eastmoney', update_time: new Date().toISOString() };
}
async function fetchRankings() {
  const merged = new Map(); const errors = []; let success = 0;
  await Promise.all(Object.entries(RANKINGS).map(async ([name, fid]) => {
    try {
      const url = buildUrl('https://push2.eastmoney.com/api/qt/clist/get', { pn: 1, pz: 30, po: 1, np: 1, fltt: 2, invt: 2, fid, fs: 'm:0+t:6,m:1+t:2,m:1+t:23', fields: 'f12,f14,f2,f3,f22,f6,f8,f10,f7,f100' });
      const diff = (await requestJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' } }))?.data?.diff || [];
      if (!Array.isArray(diff) || !diff.length) throw new Error('empty upstream payload');
      success += 1; diff.forEach(row => { const item = normalize(row); if (!item.code) return; const old = merged.get(item.code) || item; old.appeared_in = [...new Set([...old.appeared_in, name])]; merged.set(item.code, old); });
    } catch (error) { errors.push(`${name}:${String(error?.message || error)}`); }
  }));
  return { status: success === 5 ? 'OK' : success ? 'PARTIAL' : 'FAILED', data: [...merged.values()], errors };
}
module.exports = async (req, res) => { if (setCors(req, res)) return; const { value, cached: fromCache } = await cached('market-rankings:v1', 60000, fetchRankings); return json(res, 200, okBase({ success: value.status !== 'FAILED', mode: 'market_rankings_v1', ...value, count: value.data.length, cached: fromCache })); };
module.exports.fetchRankings = fetchRankings;
