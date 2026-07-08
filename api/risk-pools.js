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
const XGB_H = { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://xuangubao.cn', 'Referer': 'https://xuangubao.cn/' };
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const DPT = 'wz.ztzt';

function isoTime(sec) { return sec ? new Date(sec * 1000).toISOString() : null; }
function today() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }

async function xgbBrokenLimit() {
  const data = await fetchJson('https://flash-api.xuangubao.cn/api/pool/detail?pool_name=limit_up_broken', XGB_H);
  if (data?.code !== 20000) return null;
  return (data.data || []).map(it => ({
    code: it.symbol,
    name: it.stock_chi_name,
    price: it.price || null,
    changePct: it.change_percent || null,
    continuousBoards: it.limit_up_days || 0,
    firstLimitUpTime: isoTime(it.first_limit_up),
    lastLimitUpTime: isoTime(it.last_limit_up),
    breakTime: isoTime(it.last_break_limit_up || it.break_limit_up_time),
    industry: it.surge_reason?.related_plates?.[0]?.plate_name || '',
    reason: it.surge_reason?.surge_reason_title || '',
    isNew: it.is_new_stock || false,
    isST: it.stock_chi_name?.includes('ST') || false,
  }));
}

async function push2exBrokenLimit(date) {
  const targetDate = date || today();
  const data = await fetchJson(`https://push2ex.eastmoney.com/getTopicZBPool?ut=${UT}&dpt=${DPT}&Pageindex=0&pagesize=200&sort=fbt:asc&date=${targetDate}&_=${Date.now()}`, H);
  const pool = data?.data?.pool || [];
  return pool.map(it => ({
    code: it.code,
    name: it.n,
    price: (it.p || 0) / 1000,
    changePct: it.zdp || 0,
    turnover: it.hs || 0,
    continuousBoards: it.lb || 0,
    firstLimitUpTime: it.fbt || null,
    lastLimitUpTime: it.lbt || null,
    breakTime: it.zttj?.lastTime || it.ztzt || null,
    industry: it.hybk || '',
    reason: it.reason || '',
  }));
}

async function xgbLimitDown() {
  const data = await fetchJson('https://flash-api.xuangubao.cn/api/pool/detail?pool_name=limit_down', XGB_H);
  if (data?.code !== 20000) return null;
  return (data.data || []).map(it => ({
    code: it.symbol,
    name: it.stock_chi_name,
    price: it.price || null,
    changePct: it.change_percent || null,
    limitDownDays: it.limit_down_days || 0,
    firstLimitDownTime: isoTime(it.first_limit_down),
    lastLimitDownTime: isoTime(it.last_limit_down),
    industry: it.surge_reason?.related_plates?.[0]?.plate_name || '',
    reason: it.surge_reason?.surge_reason_title || '',
    isNew: it.is_new_stock || false,
    isST: it.stock_chi_name?.includes('ST') || false,
  }));
}

async function push2exLimitDown(date) {
  const targetDate = date || today();
  const data = await fetchJson(`https://push2ex.eastmoney.com/getTopicDTPool?ut=${UT}&dpt=${DPT}&Pageindex=0&pagesize=200&sort=fbt:asc&date=${targetDate}&_=${Date.now()}`, H);
  const pool = data?.data?.pool || [];
  return pool.map(it => ({
    code: it.code,
    name: it.n,
    price: (it.p || 0) / 1000,
    changePct: it.zdp || 0,
    turnover: it.hs || 0,
    limitDownDays: it.lxdt || it.lb || 0,
    firstLimitDownTime: it.fbt || null,
    lastLimitDownTime: it.lbt || null,
    industry: it.hybk || '',
    reason: it.reason || '',
  }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date } = req.query;
  const type = String(req.query.type || 'broken');
  try {
    const tasks = type === 'down'
      ? [xgbLimitDown().catch(() => null), push2exLimitDown(date).catch(() => null)]
      : [xgbBrokenLimit().catch(() => null), push2exBrokenLimit(date).catch(() => null)];
    const [xgb, push] = await Promise.all(tasks);
    return res.status(200).json({
      success: true,
      type,
      xuangubao: xgb ? { count: xgb.length, data: xgb.slice(0, 100) } : null,
      push2ex: push ? { count: push.length, data: push.slice(0, 100) } : null,
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message, type });
  }
};
