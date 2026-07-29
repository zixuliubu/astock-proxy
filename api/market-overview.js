const https = require('https');
const { validateMarketOverview, failure } = require('./_data-contracts');
const { sinaQuote, tencentQuote, mergeQuotes } = require('./quote');

const EASTMONEY_TOKEN = 'b2884a393a59ad64002292a3e90d46a5';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' };
const INDEX_SECIDS = [
  '1.000001', '0.399001', '0.399006',
  '1.000300', '1.000905', '1.000852',
];
const INDEX_SYMBOLS = 'sh000001,sz399001,sz399006,sh000300,sh000905,sh000852';

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: 8000 }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data.replace(/^jQuery\(/, '').replace(/\);?$/, '')));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timeout'));
    });
  });
}

function moneyYi(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number((amount / 100000000).toFixed(2)) : null;
}

function normalizeEastmoney(row) {
  return {
    code: String(row.f12 || ''),
    name: row.f14,
    price: Number(row.f2),
    changePct: Number(row.f3),
    change: Number(row.f4),
    volume: Number(row.f5),
    amount: Number(row.f6),
    amountYi: moneyYi(row.f6),
    open: Number(row.f17),
    prevClose: Number(row.f18),
    high: Number(row.f15),
    low: Number(row.f16),
    source: 'eastmoney',
  };
}

async function fetchIndicesEastmoney() {
  const fields = 'f12,f14,f2,f3,f4,f5,f6,f17,f18,f15,f16';
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${INDEX_SECIDS.join(',')}&fields=${fields}&ut=${EASTMONEY_TOKEN}&_=${Date.now()}`;
  const data = await fetchJson(url, HEADERS);
  return (data?.data?.diff || []).map(normalizeEastmoney);
}

async function fetchIndicesQuotes() {
  const [sinaResult, tencentResult] = await Promise.allSettled([
    sinaQuote(INDEX_SYMBOLS),
    tencentQuote(INDEX_SYMBOLS),
  ]);
  return mergeQuotes(
    sinaResult.status === 'fulfilled' ? sinaResult.value : [],
    tencentResult.status === 'fulfilled' ? tencentResult.value : [],
  ).map(row => ({
    ...row,
    code: String(row.code || '').replace(/^(sh|sz)/, ''),
    amountYi: moneyYi(row.amount),
    source: row.sources?.join('+') || row.source,
  }));
}

async function fetchHistoricalTurnover() {
  const fetchOne = async secid => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&lmt=2&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&ut=${EASTMONEY_TOKEN}`;
    const data = await fetchJson(url, HEADERS);
    const line = data?.data?.klines?.at(-1);
    const fields = String(line || '').split(',');
    return { date: fields[0], amount: Number(fields[6]) };
  };
  const [shanghai, shenzhen] = await Promise.all([fetchOne('1.000001'), fetchOne('0.399001')]);
  if (!Number.isFinite(shanghai.amount) || !Number.isFinite(shenzhen.amount)) return null;
  return {
    turnoverYi: moneyYi(shanghai.amount + shenzhen.amount),
    asOf: shanghai.date === shenzhen.date ? shanghai.date : `${shanghai.date}/${shenzhen.date}`,
    source: 'eastmoney_historical_kline',
  };
}

async function fetchSentiment() {
  const data = await fetchJson(
    'https://flash-api.xuangubao.cn/api/market_indicator/line?fields=rise_count,fall_count,limit_up_count,limit_down_count,limit_up_broken_count,limit_up_broken_ratio',
    { 'User-Agent': 'Mozilla/5.0', Origin: 'https://xuangubao.cn', Referer: 'https://xuangubao.cn/' },
  );
  const items = data?.data || [];
  if (!items.length) return null;
  const row = items.at(-1);
  return {
    rise: row.rise_count,
    fall: row.fall_count,
    limitUp: row.limit_up_count,
    limitDown: row.limit_down_count,
    brokenCount: row.limit_up_broken_count,
    brokenRatio: row.limit_up_broken_ratio,
  };
}

function classifyOverview(indices, sentiment, turnover) {
  const shanghai = indices.find(item => item.code === '000001');
  let label = '震荡/待确认';
  if ((shanghai?.changePct || 0) > 0.5 && (sentiment?.rise || 0) > (sentiment?.fall || 0) * 1.5) label = '指数与个股共振偏强';
  else if ((shanghai?.changePct || 0) < -0.5 && (sentiment?.fall || 0) > (sentiment?.rise || 0) * 1.5) label = '指数与个股共振偏弱';
  else if ((sentiment?.limitUp || 0) >= 50) label = '题材活跃但需看分化';
  return {
    turnoverYi: turnover.turnoverYi,
    turnoverAsOf: turnover.asOf,
    turnoverSource: turnover.source,
    note: '两市成交额为上证指数与深证成指成交额加总；盘前使用最近交易日成交额并明确 asOf。',
    label,
  };
}

function sourceConflict(primary, secondary) {
  const conflicts = [];
  for (const code of ['000001', '399001', '399006']) {
    const left = primary.find(row => row.code === code);
    const right = secondary.find(row => row.code === code);
    if (!left || !right || !left.price || !right.price) continue;
    const deviation = Math.abs(left.price - right.price) / Math.max(Math.abs(left.price), Math.abs(right.price));
    if (deviation > 0.005) conflicts.push({ code, eastmoney: left.price, quote: right.price, deviation });
  }
  return conflicts;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const [eastmoneyResult, quoteResult, sentimentResult] = await Promise.allSettled([
    fetchIndicesEastmoney(),
    fetchIndicesQuotes(),
    fetchSentiment(),
  ]);
  const eastmoney = eastmoneyResult.status === 'fulfilled' ? eastmoneyResult.value : [];
  const quotes = quoteResult.status === 'fulfilled' ? quoteResult.value : [];
  const eastmoneyValid = validateMarketOverview(eastmoney, 1).success;
  const quotesValid = validateMarketOverview(quotes, 1).success;

  if (eastmoneyValid && quotesValid) {
    const conflicts = sourceConflict(eastmoney, quotes);
    if (conflicts.length) {
      return res.status(409).json(failure('CONFLICT', 'Index quote sources disagree beyond tolerance', {
        conflicts,
        sources: { eastmoney: 'ok', sinaTencent: 'ok' },
      }));
    }
  }

  const indices = eastmoneyValid ? eastmoney : quotesValid ? quotes : [];
  if (!indices.length) {
    return res.status(503).json(failure('DATA_INSUFFICIENT', 'No index source returned the required quotes', {
      sources: {
        eastmoney: eastmoneyResult.status === 'fulfilled' ? 'invalid' : 'failed',
        sinaTencent: quoteResult.status === 'fulfilled' ? 'invalid' : 'failed',
      },
    }));
  }

  const shanghai = indices.find(item => item.code === '000001');
  const shenzhen = indices.find(item => item.code === '399001');
  let turnover = {
    turnoverYi: moneyYi(Number(shanghai?.amount) + Number(shenzhen?.amount)),
    asOf: shanghai?.time || shenzhen?.time || new Date().toISOString(),
    source: eastmoneyValid ? 'eastmoney_live_indices' : 'sina_tencent_live_indices',
  };
  if (!(turnover.turnoverYi > 0)) {
    turnover = await fetchHistoricalTurnover().catch(() => null);
  }

  const validation = validateMarketOverview(indices, turnover?.turnoverYi);
  if (!validation.success) {
    return res.status(503).json({
      ...validation,
      diagnostics: {
        ...validation.diagnostics,
        indexSource: eastmoneyValid ? 'eastmoney' : 'sina_tencent',
        turnover,
      },
    });
  }

  const sentiment = sentimentResult.status === 'fulfilled' ? sentimentResult.value : null;
  return res.status(200).json({
    success: true,
    status: sentiment ? 'OK' : 'PARTIAL',
    overview: classifyOverview(indices, sentiment, turnover),
    indices,
    sentiment,
    sources: {
      indices: eastmoneyValid ? 'eastmoney' : 'sina_tencent',
      turnover: turnover.source,
      sentiment: sentiment ? 'xuangubao' : 'unavailable',
    },
    updateTime: new Date().toISOString(),
  });
};

module.exports.moneyYi = moneyYi;
module.exports.normalizeEastmoney = normalizeEastmoney;
module.exports.sourceConflict = sourceConflict;
