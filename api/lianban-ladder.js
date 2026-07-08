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

function isoTime(sec) {
  return sec ? new Date(sec * 1000).toISOString() : null;
}

function normalizeCode(code) {
  if (!code) return '';
  return String(code).replace(/^(sh|sz|bj)/i, '');
}

function buildLadder(items) {
  const clean = (items || [])
    .filter(it => it && it.code && !it.isST)
    .map(it => ({ ...it, continuousBoards: Number(it.continuousBoards || 1) || 1 }))
    .sort((a, b) => {
      if (b.continuousBoards !== a.continuousBoards) return b.continuousBoards - a.continuousBoards;
      return String(a.firstLimitUpTime || '').localeCompare(String(b.firstLimitUpTime || ''));
    });

  const groups = {};
  for (const it of clean) {
    const key = String(it.continuousBoards || 1);
    if (!groups[key]) groups[key] = [];
    groups[key].push(it);
  }

  const maxBoard = clean.length ? Math.max(...clean.map(it => it.continuousBoards || 1)) : 0;
  const distribution = {};
  for (const [board, arr] of Object.entries(groups)) distribution[board] = arr.length;

  return {
    total: clean.length,
    maxBoard,
    distribution,
    highest: maxBoard ? groups[String(maxBoard)] || [] : [],
    boards: groups,
    board2: groups['2'] || [],
    board3: groups['3'] || [],
    firstBoard: groups['1'] || [],
  };
}

async function xgbLimitUp() {
  const data = await fetchJson('https://flash-api.xuangubao.cn/api/pool/detail?pool_name=limit_up', XGB_H);
  if (data?.code !== 20000) return null;
  return (data.data || []).map(it => ({
    source: 'xuangubao',
    code: normalizeCode(it.symbol),
    symbol: it.symbol,
    name: it.stock_chi_name,
    continuousBoards: it.limit_up_days || 1,
    firstLimitUpTime: isoTime(it.first_limit_up),
    lastLimitUpTime: isoTime(it.last_limit_up),
    industry: it.surge_reason?.related_plates?.[0]?.plate_name || '',
    reason: it.surge_reason?.surge_reason_title || '',
    isNew: it.is_new_stock || false,
    isST: it.stock_chi_name?.includes('ST') || false,
  }));
}

async function push2exLimitUp(date) {
  const targetDate = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const data = await fetchJson(
    `https://push2ex.eastmoney.com/getTopicZTPool?ut=${UT}&dpt=${DPT}&Pageindex=0&pagesize=300&sort=fbt:asc&date=${targetDate}&_=${Date.now()}`,
    H
  );
  const pool = data?.data?.pool || [];
  return pool.map(it => ({
    source: 'push2ex',
    code: normalizeCode(it.code),
    symbol: it.code,
    name: it.n,
    price: (it.p || 0) / 1000,
    changePct: it.zdp || 0,
    turnover: it.hs || 0,
    continuousBoards: it.lb || 1,
    firstLimitUpTime: it.fbt || null,
    lastLimitUpTime: it.lbt || null,
    industry: it.hybk || '',
    reason: it.reason || '',
    isST: it.n?.includes('ST') || false,
  }));
}

function mergeByCode(primary = [], secondary = []) {
  const map = new Map();
  for (const it of secondary || []) map.set(normalizeCode(it.code), it);
  for (const it of primary || []) {
    const code = normalizeCode(it.code);
    const old = map.get(code) || {};
    map.set(code, { ...old, ...it, code });
  }
  return Array.from(map.values());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date } = req.query;
  try {
    const [xgb, push] = await Promise.all([
      xgbLimitUp().catch(() => null),
      push2exLimitUp(date).catch(() => null),
    ]);

    const primary = xgb || push || [];
    const merged = mergeByCode(primary, push || []);
    const ladder = buildLadder(merged);

    return res.status(200).json({
      success: true,
      sourcePriority: xgb ? ['xuangubao', 'push2ex'] : ['push2ex'],
      ladder,
      raw: {
        xuangubao: xgb ? { count: xgb.length, data: xgb.slice(0, 100) } : null,
        push2ex: push ? { count: push.length, data: push.slice(0, 100) } : null,
      },
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
