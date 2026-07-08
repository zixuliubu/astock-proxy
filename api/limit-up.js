const https = require('https');

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data.replace(/^jQuery\(/, '').replace(/\);?$/, ''))); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () {
      this.destroy(); reject(new Error('timeout'));
    });
  });
}

const H = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' };
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const DPT = 'wz.ztzt';

async function xgbLimitUp() {
  const data = await fetchJson(`https://flash-api.xuangubao.cn/api/pool/detail?pool_name=limit_up`, {
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://xuangubao.cn',
    'Referer': 'https://xuangubao.cn/',
  });
  if (data?.code !== 20000) return null;
  return (data.data || []).map(it => ({
    code: it.symbol,
    name: it.stock_chi_name,
    continuousBoards: it.limit_up_days || 0,
    firstLimitUpTime: it.first_limit_up ? new Date(it.first_limit_up * 1000).toISOString() : null,
    industry: it.surge_reason?.related_plates?.[0]?.plate_name || '',
    reason: it.surge_reason?.surge_reason_title || '',
    isNew: it.is_new_stock || false,
    isST: it.stock_chi_name?.includes('ST') || false,
  }));
}

async function push2exLimitUp(date) {
  const targetDate = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const data = await fetchJson(
    `https://push2ex.eastmoney.com/getTopicZTPool?ut=${UT}&dpt=${DPT}&Pageindex=0&pagesize=100&sort=fbt:asc&date=${targetDate}&_=${Date.now()}`,
    H
  );
  const pool = data?.data?.pool || [];
  return pool.map(it => ({
    code: it.code, name: it.n, price: (it.p || 0) / 1000,
    changePct: it.zdp || 0, turnover: it.hs || 0,
    continuousBoards: it.lb || 0,
    industry: it.hybk || '',
  }));
}

async function emLimitUp() {
  const data = await fetchJson(
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m%3A0%2Bt%3A2%2Bf%3A%212%2Cm%3A0%2Bt%3A23%2Bf%3A%212%2Cm%3A1%2Bt%3A2%2Bf%3A%212%2Cm%3A1%2Bt%3A23%2Bf%3A%212&fields=f12,f14,f2,f3,f5,f6&cb=jQuery`,
    H
  );
  return (data?.data?.diff || [])
    .filter(s => s.f3 >= 9.5)
    .map(s => ({ code: s.f12, name: s.f14, price: s.f2, changePct: s.f3 }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date } = req.query;
  try {
    const [xgb, push, em] = await Promise.all([
      xgbLimitUp().catch(() => null),
      push2exLimitUp(date).catch(() => null),
      emLimitUp().catch(() => null),
    ]);
    return res.status(200).json({
      success: true,
      xuangubao: xgb ? { count: xgb.length, data: xgb.slice(0, 50) } : null,
      push2ex: push ? { count: push.length, data: push.slice(0, 50) } : null,
      eastmoney: em ? { count: em.length, data: em.slice(0, 50) } : null,
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};