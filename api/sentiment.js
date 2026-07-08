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

async function xgbSentiment() {
  const data = await fetchJson(
    'https://flash-api.xuangubao.cn/api/market_indicator/line?fields=rise_count,fall_count,limit_up_count,limit_down_count,limit_up_broken_count,limit_up_broken_ratio',
    { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://xuangubao.cn', 'Referer': 'https://xuangubao.cn/' }
  );
  const items = data?.data || [];
  if (!items.length) return null;
  const d = items[items.length - 1];
  const up = d.limit_up_count || 0;
  const broken = d.limit_up_broken_ratio || 0;
  const down = d.limit_down_count || 0;
  let label = '🌫️ 平淡行情';
  if (up >= 80 && broken < 0.2) label = '🔥 大涨行情';
  else if (up >= 50 && broken < 0.3) label = '📈 行情不错';
  else if (up >= 30 && broken < 0.4) label = '⚖️ 震荡行情';
  else if (down >= 30 || broken > 0.5) label = '⚠️ 弱势行情';
  return {
    rise: d.rise_count, fall: d.fall_count,
    limitUp: up, limitDown: down,
    brokenCount: d.limit_up_broken_count,
    brokenRatio: broken,
    label,
  };
}

async function xgbBoardDist() {
  const data = await fetchJson(
    'https://flash-api.xuangubao.cn/api/pool/detail?pool_name=limit_up',
    { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://xuangubao.cn', 'Referer': 'https://xuangubao.cn/' }
  );
  if (data?.code !== 20000) return null;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, '10+': 0 };
  const items = (data.data || []).filter(it => !it.stock_chi_name?.includes('ST'));
  for (const it of items) {
    const days = it.limit_up_days || 0;
    if (days === 0) continue;
    if (days >= 10) dist['10+']++;
    else dist[days]++;
  }
  return { total: items.length, distribution: dist };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [sentiment, dist] = await Promise.all([
      xgbSentiment().catch(() => null),
      xgbBoardDist().catch(() => null),
    ]);
    return res.status(200).json({
      success: true,
      sentiment,
      boardDistribution: dist,
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};