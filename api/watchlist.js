const quote = require('./quote');
const { failure } = require('./_data-contracts');

const DEFAULT_GROUPS = {
  default: ['sh600584', 'sz002185', 'sz002407', 'sh600793'],
  semiconductor: ['sh600584', 'sz002185', 'sh688981', 'sz002371', 'sh603986', 'sh600460', 'sz300782'],
  robot: ['sz300124', 'sz002031', 'sz002527', 'sh688017', 'sz300024', 'sz002698'],
  ai_compute: ['sh601138', 'sz000977', 'sh603019', 'sz300308', 'sz300502', 'sh688041'],
  innovation_drug: ['sh600276', 'sh688235', 'sh688180', 'sh688266', 'sz300558'],
  fluorochemical: ['sz002407', 'sz002326', 'sh600160', 'sz002709'],
  paper: ['sh600793', 'sh600103', 'sz002511', 'sh600308'],
  market_core: ['sh600519', 'sh601318', 'sh600036', 'sh601398', 'sh600030', 'sz300750'],
};

function normalizeSymbol(code) {
  let s = String(code || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('sh') || s.startsWith('sz') || s.startsWith('bj')) return s;
  if (s.startsWith('6')) return `sh${s}`;
  if (s.startsWith('0') || s.startsWith('3')) return `sz${s}`;
  if (s.startsWith('8') || s.startsWith('4')) return `bj${s}`;
  return s;
}

function toWatchRow(row) {
  const open = Number(row.open);
  const prevClose = Number(row.prevClose);
  const price = Number(row.price);
  const high = Number(row.high);
  const low = Number(row.low);
  const volume = Number(row.volume);
  const amount = Number(row.amount);
  const change = Number((price - prevClose).toFixed(3));
  const changePct = prevClose ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;
  const range = high - low;
  const closePosition = range > 0 ? Number(((price - low) / range).toFixed(2)) : null;
  let support = '无法判断';
  if (closePosition !== null && changePct >= 0 && closePosition >= 0.65) support = '承接较强';
  else if (closePosition !== null && closePosition >= 0.45) support = '承接一般';
  else if (closePosition !== null && closePosition < 0.35) support = '承接偏弱';
  return {
    source: Array.isArray(row.sources) ? row.sources.join('+') : row.source,
    sources: row.sources || [row.source].filter(Boolean),
    code: normalizeSymbol(row.code),
    name: row.name,
    price,
    prevClose,
    open,
    high,
    low,
    change,
    changePct,
    volume,
    amount,
    amountYi: Number((amount / 100000000).toFixed(2)),
    closePosition,
    support,
    time: row.time,
  };
}

async function fetchWatchlistQuotes(symbols) {
  const list = symbols.map(normalizeSymbol).filter(Boolean);
  if (!list.length) return { data: [], sources: { sina: 'empty', tencent: 'empty' } };
  const [sinaResult, tencentResult] = await Promise.allSettled([
    quote.sinaQuote(list.join(',')),
    quote.tencentQuote(list.join(',')),
  ]);
  const sina = sinaResult.status === 'fulfilled' ? sinaResult.value : [];
  const tencent = tencentResult.status === 'fulfilled' ? tencentResult.value : [];
  return {
    data: quote.mergeQuotes(sina, tencent).map(toWatchRow),
    sources: {
      sina: sina.length ? 'ok' : sinaResult.status === 'fulfilled' ? 'empty' : 'failed',
      tencent: tencent.length ? 'ok' : tencentResult.status === 'fulfilled' ? 'empty' : 'failed',
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const group = String(req.query.group || 'default');
    const symbols = req.query.symbols
      ? String(req.query.symbols).split(',').map(s => s.trim()).filter(Boolean)
      : (DEFAULT_GROUPS[group] || DEFAULT_GROUPS.default);
    const result = await fetchWatchlistQuotes(symbols);
    const data = result.data;
    if (!data.length) {
      return res.status(503).json(failure('DATA_INSUFFICIENT', 'Watchlist quote sources returned no usable rows', {
        sources: result.sources,
      }));
    }
    const sorted = [...data].sort((a, b) => (b.amount || 0) - (a.amount || 0));
    return res.status(200).json({
      success: true,
      status: 'OK',
      group,
      symbols: symbols.map(normalizeSymbol),
      count: data.length,
      sources: result.sources,
      data: sorted,
      summary: {
        strongestSupport: sorted.filter(x => x.support === '承接较强').slice(0, 5),
        weakestSupport: sorted.filter(x => x.support === '承接偏弱').slice(0, 5),
        topAmount: sorted.slice(0, 5),
      },
      updateTime: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json(failure('UPSTREAM_FAILED', e.message));
  }
};

module.exports.toWatchRow = toWatchRow;
module.exports.fetchWatchlistQuotes = fetchWatchlistQuotes;
