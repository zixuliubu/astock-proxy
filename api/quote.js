const https = require('https');
const iconv = require('iconv-lite');
const { failure } = require('./_data-contracts');

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function fetchJson(url, headers = {}) {
  return fetchText(url, headers).then(buffer => {
    const text = buffer.toString('utf8').replace(/^jQuery\(/, '').replace(/\);?$/, '');
    return JSON.parse(text);
  });
}

function plainCode(value) {
  return String(value || '').replace(/^(sh|sz|bj)/i, '');
}

async function sinaQuote(symbols) {
  const buffer = await fetchText(`https://hq.sinajs.cn/list=${symbols}`, {
    Referer: 'https://finance.sina.com.cn',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)',
  });
  const text = iconv.decode(buffer, 'gb18030');
  const stocks = [];
  for (const line of text.split('\n').filter(item => item.trim())) {
    const match = line.match(/var hq_str_(\w+)="([^"]*)"/);
    if (!match) continue;
    const fields = match[2].split(',');
    if (fields.length < 32 || !fields[0]) continue;
    const price = parseFloat(fields[3]);
    const prevClose = parseFloat(fields[2]);
    stocks.push({
      source: 'sina',
      code: plainCode(match[1]),
      name: fields[0],
      open: parseFloat(fields[1]),
      prevClose,
      price,
      high: parseFloat(fields[4]),
      low: parseFloat(fields[5]),
      change: Number((price - prevClose).toFixed(3)),
      changePct: prevClose ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : 0,
      volume: parseInt(fields[8], 10),
      amount: parseFloat(fields[9]),
      time: `${fields[30]} ${fields[31]}`,
    });
  }
  return stocks;
}

async function tencentQuote(symbols) {
  const symbolList = String(symbols).split(',').map(symbol => {
    if (/^\d{6}$/.test(symbol)) {
      if (/^(6|5|9)/.test(symbol)) return `sh${symbol}`;
      if (/^(0|3|1)/.test(symbol)) return `sz${symbol}`;
    }
    return symbol;
  }).join(',');
  const buffer = await fetchText(`https://qt.gtimg.cn/q=${symbolList}`, {
    Referer: 'https://gu.qq.com/',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)',
  });
  const text = iconv.decode(buffer, 'gb18030');
  const stocks = [];
  for (const line of text.split('\n').filter(item => item.trim())) {
    const match = line.match(/v_(\w+)="([^"]*)"/);
    if (!match) continue;
    const fields = match[2].split('~');
    if (fields.length < 40 || !fields[1]) continue;
    const price = parseFloat(fields[3]);
    const prevClose = parseFloat(fields[4]);
    stocks.push({
      source: 'tencent',
      code: plainCode(match[1]),
      name: fields[1],
      price,
      prevClose,
      open: parseFloat(fields[5]),
      volume: parseInt(fields[6], 10),
      amount: parseFloat(fields[37]) * 10000,
      high: parseFloat(fields[33]),
      low: parseFloat(fields[34]),
      change: Number((price - prevClose).toFixed(3)),
      changePct: prevClose ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : 0,
      pe: parseFloat(fields[39]) || null,
      time: `${fields[30]} ${fields[31]}`,
    });
  }
  return stocks;
}

function mergeQuotes(sina, tencent) {
  const sinaRows = Array.isArray(sina) ? sina : [];
  const tencentRows = Array.isArray(tencent) ? tencent : [];
  const bySinaCode = new Map(sinaRows.map(row => [plainCode(row.code), row]));
  const byTencentCode = new Map(tencentRows.map(row => [plainCode(row.code), row]));
  const codes = [...new Set([...byTencentCode.keys(), ...bySinaCode.keys()])];
  return codes.map(code => {
    const sinaRow = bySinaCode.get(code);
    const tencentRow = byTencentCode.get(code);
    return {
      ...(sinaRow || {}),
      ...(tencentRow || {}),
      code,
      sources: [sinaRow && 'sina', tencentRow && 'tencent'].filter(Boolean),
    };
  }).filter(row => row.name && Number.isFinite(row.price));
}

async function emDetail(symbol) {
  const code = plainCode(symbol);
  const secid = /^(6|5|9)/.test(code) ? `1.${code}` : `0.${code}`;
  const data = await fetchJson(
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f60,f62,f84,f85,f86,f116,f117,f168,f169,f170`,
    { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
  );
  if (!data?.data) return null;
  const fields = data.data;
  return {
    turnover: fields.f168,
    pe: fields.f169,
    totalCap: fields.f116,
    circCap: fields.f117,
    mainInflow: fields.f62,
    superBuy: fields.f84,
    bigBuy: fields.f85,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols, detail } = req.query;
  if (!symbols) return res.status(400).json(failure('INVALID_ARGUMENT', 'Missing symbols'));

  const list = String(symbols).split(',').slice(0, 20).join(',');
  const start = Date.now();
  const [sinaResult, tencentResult] = await Promise.allSettled([
    sinaQuote(list),
    tencentQuote(list),
  ]);
  const sina = sinaResult.status === 'fulfilled' ? sinaResult.value : [];
  const tencent = tencentResult.status === 'fulfilled' ? tencentResult.value : [];
  let merged = mergeQuotes(sina, tencent);

  if (!merged.length) {
    return res.status(503).json(failure('DATA_INSUFFICIENT', 'Sina and Tencent quote sources returned no usable rows', {
      sources: {
        sina: sinaResult.status === 'fulfilled' ? 'empty' : 'failed',
        tencent: tencentResult.status === 'fulfilled' ? 'empty' : 'failed',
      },
    }));
  }

  if (detail === 'true') {
    const detailData = await emDetail(String(symbols).split(',')[0]).catch(() => null);
    if (detailData) merged = merged.map((row, index) => index === 0 ? { ...row, ...detailData } : row);
  }

  return res.status(200).json({
    success: true,
    status: 'OK',
    count: merged.length,
    data: merged,
    sources: {
      sina: sina.length ? 'ok' : sinaResult.status === 'fulfilled' ? 'empty' : 'failed',
      tencent: tencent.length ? 'ok' : tencentResult.status === 'fulfilled' ? 'empty' : 'failed',
    },
    latency: Date.now() - start,
    updateTime: new Date().toISOString(),
  });
};

module.exports.sinaQuote = sinaQuote;
module.exports.tencentQuote = tencentQuote;
module.exports.mergeQuotes = mergeQuotes;
