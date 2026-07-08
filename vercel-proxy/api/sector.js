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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const data = await fetchJson(
      'https://push2.hsmarketwg.eastmoney.com/api/qt/clist/hotboard/get?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m%3A90%2Bt%3A2&fields=f12,f14,f2,f3,f5,f6&cb=jQuery',
      { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' }
    );
    const sectors = (data?.data?.diff || []).map(s => ({
      code: s.f12, name: s.f14, changePct: s.f3, price: s.f2,
    }));
    return res.status(200).json({
      success: true,
      count: sectors.length,
      data: sectors,
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};