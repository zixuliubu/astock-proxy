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

function moneyYi(v) {
  const n = Number(v || 0);
  return Number((n / 100000000).toFixed(2));
}

async function fetchIndices() {
  const secids = [
    '1.000001', // 上证指数
    '0.399001', // 深证成指
    '0.399006', // 创业板指
    '1.000300', // 沪深300
    '1.000905', // 中证500
    '1.000852', // 中证1000
  ].join(',');
  const fields = 'f12,f14,f2,f3,f4,f5,f6,f17,f18,f15,f16';
  const data = await fetchJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids}&fields=${fields}&_=${Date.now()}`, H);
  const diff = data?.data?.diff || [];
  return diff.map(s => ({
    code: s.f12,
    name: s.f14,
    price: s.f2,
    changePct: s.f3,
    change: s.f4,
    volume: s.f5,
    amount: s.f6,
    amountYi: moneyYi(s.f6),
    open: s.f17,
    prevClose: s.f18,
    high: s.f15,
    low: s.f16,
  }));
}

async function fetchSentiment() {
  const data = await fetchJson(
    'https://flash-api.xuangubao.cn/api/market_indicator/line?fields=rise_count,fall_count,limit_up_count,limit_down_count,limit_up_broken_count,limit_up_broken_ratio',
    { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://xuangubao.cn', 'Referer': 'https://xuangubao.cn/' }
  );
  const items = data?.data || [];
  if (!items.length) return null;
  const d = items[items.length - 1];
  return {
    rise: d.rise_count,
    fall: d.fall_count,
    limitUp: d.limit_up_count,
    limitDown: d.limit_down_count,
    brokenCount: d.limit_up_broken_count,
    brokenRatio: d.limit_up_broken_ratio,
  };
}

function classifyOverview(indices, sentiment) {
  const sh = indices.find(i => i.code === '000001');
  const sz = indices.find(i => i.code === '399001');
  const turnoverYi = moneyYi((sh?.amount || 0) + (sz?.amount || 0));
  let label = '震荡/待确认';
  if ((sh?.changePct || 0) > 0.5 && (sentiment?.rise || 0) > (sentiment?.fall || 0) * 1.5) label = '指数与个股共振偏强';
  else if ((sh?.changePct || 0) < -0.5 && (sentiment?.fall || 0) > (sentiment?.rise || 0) * 1.5) label = '指数与个股共振偏弱';
  else if ((sentiment?.limitUp || 0) >= 50) label = '题材活跃但需看分化';
  return { turnoverYi, note: '两市成交额为上证指数与深证成指成交额近似加总，供盘面复盘使用。', label };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [indices, sentiment] = await Promise.all([
      fetchIndices().catch(() => []),
      fetchSentiment().catch(() => null),
    ]);
    return res.status(200).json({
      success: true,
      overview: classifyOverview(indices, sentiment),
      indices,
      sentiment,
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
