const https = require('https');
const iconv = require('iconv-lite');

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchJson(url, headers = {}) {
  return fetchText(url, headers).then(buf => {
    const text = buf.toString('utf8').replace(/^jQuery\(/, '').replace(/\);?$/, '');
    return JSON.parse(text);
  });
}

async function sinaQuote(symbols) {
  const buf = await fetchText(`https://hq.sinajs.cn/list=${symbols}`, {
    'Referer': 'https://finance.sina.com.cn',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)',
  });
  const text = iconv.decode(buf, 'gbk');
  const stocks = [];
  for (const line of text.split('\n').filter(l => l.trim())) {
    const m = line.match(/var hq_str_(\w+)="([^"]*)"/);
    if (!m) continue;
    const f = m[2].split(',');
    if (f.length < 32) continue;
    const price = parseFloat(f[3]);
    const prev = parseFloat(f[2]);
    stocks.push({
      source: 'sina', code: m[1], name: f[0],
      open: parseFloat(f[1]), prevClose: prev, price,
      high: parseFloat(f[4]), low: parseFloat(f[5]),
      change: +(price - prev).toFixed(3),
      changePct: +((price - prev) / prev * 100).toFixed(2),
      volume: parseInt(f[8]), amount: parseFloat(f[9]),
      time: `${f[30]} ${f[31]}`,
    });
  }
  return stocks;
}

async function tencentQuote(symbols) {
  const symList = String(symbols).split(',').map(s => {
    if (/^\d{6}$/.test(s)) {
      if (/^(6|5|9)/.test(s)) return `sh${s}`;
      if (/^(0|3|1)/.test(s)) return `sz${s}`;
    }
    return s;
  }).join(',');
  const buf = await fetchText(`https://qt.gtimg.cn/q=${symList}`, {
    'Referer': 'https://gu.qq.com/',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)',
  });
  const text = iconv.decode(buf, 'gbk');
  const stocks = [];
  for (const line of text.split('\n').filter(l => l.trim())) {
    const m = line.match(/v_(\w+)="([^"]*)"/);
    if (!m) continue;
    const f = m[2].split('~');
    if (f.length < 40) continue;
    const price = parseFloat(f[3]);
    const prev = parseFloat(f[4]);
    stocks.push({
      source: 'tencent', code: m[1], name: f[1],
      price, prevClose: prev,
      open: parseFloat(f[5]),
      volume: parseInt(f[6]),
      amount: parseFloat(f[37]) * 10000,
      high: parseFloat(f[33]), low: parseFloat(f[34]),
      change: +(price - prev).toFixed(3),
      changePct: prev ? +((price - prev) / prev * 100).toFixed(2) : 0,
      pe: parseFloat(f[39]) || null,
      time: `${f[30]} ${f[31]}`,
    });
  }
  return stocks;
}

async function emDetail(symbol) {
  let code = symbol.replace(/^(sh|sz|bj)/, '');
  let secid = /^(6|5|9)/.test(code) ? `1.${code}` : `0.${code}`;
  const data = await fetchJson(
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f60,f62,f84,f85,f86,f116,f117,f168,f169,f170`,
    { 'Referer': 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' }
  );
  if (!data?.data) return null;
  const d = data.data;
  return {
    turnover: d.f168, pe: d.f169, totalCap: d.f116, circCap: d.f117,
    mainInflow: d.f62, superBuy: d.f84, bigBuy: d.f85,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols, detail } = req.query;
  if (!symbols) return res.status(400).json({ error: '缺少 symbols 参数' });

  const list = String(symbols).split(',').slice(0, 20).join(',');
  const start = Date.now();

  const [sina, tencent] = await Promise.all([
    sinaQuote(list).catch(() => null),
    tencentQuote(list).catch(() => null),
  ]);

  let detailData = null;
  if (detail === 'true') {
    detailData = await emDetail(String(symbols).split(',')[0]).catch(() => null);
  }

  const primary = tencent || sina || [];
  const merged = primary.map((p, i) => ({
    ...p,
    ...(sina?.[i] || {}),
    ...(i === 0 && detailData ? detailData : {}),
  }));

  return res.status(200).json({
    success: true,
    count: merged.length,
    data: merged,
    sources: { sina: sina ? 'ok' : 'fail', tencent: tencent ? 'ok' : 'fail' },
    latency: Date.now() - start,
    updateTime: new Date().toISOString(),
  });
};