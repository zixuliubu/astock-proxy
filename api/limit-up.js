const https = require('https');
const { cleanCode, num, reconcileTextRows } = require('./_stock-utils');

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

function chinaDate() {
  const p = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  return `${p.year}${p.month}${p.day}`;
}

function normalizeDate(date) { return String(date || chinaDate()).replace(/-/g, ''); }
function priceFromMilli(v) { const n = num(v); return n === null ? null : n / 1000; }
function normalizeZtStat(value) {
  const stat = value || {};
  const days = stat.days ?? stat.d;
  const count = stat.ct ?? stat.count;
  return days && count ? `${days}天${count}板` : '';
}

function normalizePush2exLimitUp(it = {}) {
  const code = cleanCode(it.code || it.c || it.SECURITY_CODE || it.symbol);
  return {
    code,
    name: it.name || it.n || it.SECURITY_NAME_ABBR || it.stockName || '',
    price: priceFromMilli(it.p),
    changePct: num(it.zdp) || 0,
    amount: num(it.amount),
    floatCap: num(it.ltsz),
    turnover: num(it.hs) || 0,
    continuousBoards: num(it.lbc ?? it.lb ?? it.limit_days) || 0,
    firstLimitUpTime: it.fbt || it.firstLimitUpTime || null,
    lastLimitUpTime: it.lbt || it.lastLimitUpTime || null,
    sealFund: num(it.fund),
    breakTimes: num(it.zbc),
    industry: it.hybk || it.industry || '',
    reason: it.reason || it.ztReason || it.limitReason || '',
    ztStat: normalizeZtStat(it.zttj),
    source: 'push2ex',
  };
}

async function xgbLimitUp(date) {
  const targetDate = normalizeDate(date);
  if (targetDate !== chinaDate()) return null;
  const data = await fetchJson(`https://flash-api.xuangubao.cn/api/pool/detail?pool_name=limit_up`, {
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://xuangubao.cn',
    'Referer': 'https://xuangubao.cn/',
  });
  if (data?.code !== 20000) return null;
  return (data.data || []).map(it => ({
    code: cleanCode(it.symbol),
    name: it.stock_chi_name,
    continuousBoards: it.limit_up_days || 0,
    firstLimitUpTime: it.first_limit_up ? new Date(it.first_limit_up * 1000).toISOString() : null,
    industry: it.surge_reason?.related_plates?.[0]?.plate_name || '',
    reason: it.surge_reason?.surge_reason_title || '',
    isNew: it.is_new_stock || false,
    isST: it.stock_chi_name?.includes('ST') || false,
    source: 'xuangubao',
  })).filter(it => it.code);
}

async function push2exLimitUp(date) {
  const targetDate = normalizeDate(date);
  const data = await fetchJson(
    `https://push2ex.eastmoney.com/getTopicZTPool?ut=${UT}&dpt=${DPT}&Pageindex=0&pagesize=100&sort=fbt:asc&date=${targetDate}&_=${Date.now()}`,
    H
  );
  const pool = data?.data?.pool || [];
  return pool.map(normalizePush2exLimitUp).filter(it => it.code);
}

async function emLimitUp() {
  const data = await fetchJson(
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m%3A0%2Bt%3A2%2Bf%3A%212%2Cm%3A0%2Bt%3A23%2Bf%3A%212%2Cm%3A1%2Bt%3A2%2Bf%3A%212%2Cm%3A1%2Bt%3A23%2Bf%3A%212&fields=f12,f14,f2,f3,f5,f6&cb=jQuery`,
    H
  );
  return (data?.data?.diff || [])
    .filter(s => s.f3 >= 9.5)
    .map(s => ({ code: cleanCode(s.f12), name: s.f14, price: s.f2, changePct: s.f3, source: 'eastmoney' }))
    .filter(it => it.code);
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date } = req.query;
  const max = Math.min(Math.max(Number(req.query.top || req.query.max || 100), 1), 500);
  try {
    const [xgb, push, em] = await Promise.all([
      xgbLimitUp(date).catch(() => null),
      push2exLimitUp(date).catch(() => null),
      emLimitUp().catch(() => null),
    ]);
    const reconciledXgb = xgb ? reconcileTextRows(xgb, push || []) : null;
    return res.status(200).json({
      success: true,
      xuangubao: reconciledXgb ? { count: reconciledXgb.length, data: reconciledXgb.slice(0, max) } : null,
      push2ex: push ? { count: push.length, data: push.slice(0, max) } : null,
      eastmoney: em ? { count: em.length, data: em.slice(0, Math.min(max, 50)) } : null,
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

module.exports = handler;
module.exports.normalizePush2exLimitUp = normalizePush2exLimitUp;
module.exports.push2exLimitUp = push2exLimitUp;
