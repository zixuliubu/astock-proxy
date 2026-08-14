const iconv = require('iconv-lite');
const {
  DEFAULT_UA,
  json,
  setCors,
  parseSymbols,
  prefixedCode,
  buildUrl,
  cached,
  okBase,
  num,
  yi,
} = require('./_stock-utils');

const prevFrames = global.__ASTOCK_ORDERBOOK_LITE_PREV__ || new Map();
global.__ASTOCK_ORDERBOOK_LITE_PREV__ = prevFrames;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function safeRatio(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return round(x / y, 3);
}

function quoteLineRegex() {
  return /var\s+hq_str_([a-z]{2})(\d{6})="([^"]*)";/g;
}

async function requestSinaText(symbols) {
  const list = symbols.map(prefixedCode).join(',');
  const url = buildUrl('https://hq.sinajs.cn/list=' + list, {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2800);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: 'https://finance.sina.com.cn/',
        Accept: '*/*',
      },
      signal: controller.signal,
    });
    const buf = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    return { text: iconv.decode(buf, 'gbk'), httpStatus: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestTencentText(symbols) {
  const list = symbols.map(prefixedCode).join(',');
  const url = buildUrl('https://qt.gtimg.cn/q=' + list, {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://gu.qq.com/', Accept: '*/*' },
      signal: controller.signal,
    });
    const buf = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    return { text: iconv.decode(buf, 'gb18030'), httpStatus: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

function parseFiveLevels(fields, startIndex) {
  const levels = [];
  for (let i = 0; i < 5; i += 1) {
    const volume = num(fields[startIndex + i * 2]);
    const price = num(fields[startIndex + i * 2 + 1]);
    levels.push({
      level: i + 1,
      price,
      volume,
    });
  }
  return levels;
}

function compactLevel(levels) {
  return levels.filter(x => x.price !== null || x.volume !== null);
}

function hasUsableDepth(item) {
  return [...(item.bid || []), ...(item.ask || [])]
    .some(level => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.volume));
}

function hasUsableSide(levels) {
  return (levels || []).some(level => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.volume));
}

function hasUsableBestLevel(levels) {
  const first = (levels || [])[0];
  return Boolean(first && Number.isFinite(first.price) && first.price > 0 && Number.isFinite(first.volume));
}

function dataQualityFor(items, requestedCount) {
  if (!items.length) return 'DATA_INSUFFICIENT';
  const complete = items.length === requestedCount && items.every(item => hasUsableSide(item.bid) && hasUsableSide(item.ask));
  return complete ? 'REALTIME_DEPTH' : 'PARTIAL_DEPTH';
}

function limitPercentFor(code) {
  if (/^(300|688)/.test(String(code))) return 20;
  if (/^(4|8)/.test(String(code))) return 30;
  if (/^(00|60)/.test(String(code))) return 10;
  return null;
}

function isAtDailyLimit(item, direction) {
  const limitPercent = limitPercentFor(item.code);
  const boundary = direction === 'up' ? item.high : item.low;
  if (limitPercent === null || !Number.isFinite(item.changePct) || !Number.isFinite(item.price) || !Number.isFinite(boundary)) return false;
  const expected = direction === 'up' ? limitPercent : -limitPercent;
  return Math.abs(item.changePct - expected) <= 0.15 && Math.abs(item.price - boundary) <= 0.001;
}

function marketStateFor(item) {
  if (!hasUsableSide(item.ask) && isAtDailyLimit(item, 'up')) return 'LIMIT_UP_ONE_SIDED';
  if (!hasUsableSide(item.bid) && isAtDailyLimit(item, 'down')) return 'LIMIT_DOWN_ONE_SIDED';
  return 'NORMAL';
}

function applyDepthSemantics(item, dataQuality, compare) {
  const complete = dataQuality === 'REALTIME_DEPTH' && hasUsableBestLevel(item.bid) && hasUsableBestLevel(item.ask);
  item.marketState = marketStateFor(item);
  if (!complete) {
    prevFrames.delete(item.code);
    item.pressureRatio = null;
    item.spread = null;
    item.delta = null;
    item.strength = {
      score: null,
      label: '盘口深度不完整',
      reasons: ['单边盘口或深度数据不完整，不判断承接强弱'],
    };
    return item;
  }

  const bestBid = item.bid[0].price;
  const bestAsk = item.ask[0].price;
  item.pressureRatio = safeRatio(item.bidTotal, item.askTotal);
  item.spread = round(bestAsk - bestBid, 3);
  const delta = compare ? frameDelta(item.code, item) : null;
  if (!compare) prevFrames.set(item.code, { price: item.price, amountYi: item.amountYi, bidTotal: item.bidTotal, askTotal: item.askTotal, at: Date.now() });
  item.delta = delta;
  item.strength = strengthFor(item, delta);
  return item;
}

function sanitizedError(error) {
  const errorType = error?.name || 'Error';
  if (errorType === 'AbortError') return { errorType, errorMessage: 'request timed out' };
  return {
    errorType,
    errorMessage: String(error?.message || errorType).replace(/https?:\/\/\S+/gi, '[redacted-url]').slice(0, 180),
  };
}

async function runProviderAttempt(provider, timeoutMs, load, parse) {
  const startedAt = Date.now();
  try {
    const response = await load();
    const rows = parse(response.text).filter(hasUsableDepth);
    if (!rows.length) {
      return { rows, attempt: { provider, status: 'parse_error', elapsedMs: Date.now() - startedAt, timeoutMs, httpStatus: response.httpStatus, errorType: 'ParseError', errorMessage: 'upstream response contained no usable five-level depth' } };
    }
    return { rows, attempt: { provider, status: 'ok', elapsedMs: Date.now() - startedAt, timeoutMs, httpStatus: response.httpStatus, errorType: null, errorMessage: null } };
  } catch (error) {
    const { errorType, errorMessage } = sanitizedError(error);
    return { rows: [], attempt: { provider, status: errorType === 'AbortError' ? 'timeout' : error?.httpStatus ? 'http_error' : 'network_error', elapsedMs: Date.now() - startedAt, timeoutMs, httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null, errorType, errorMessage } };
  }
}

function frameDelta(code, item) {
  const prev = prevFrames.get(code);
  const current = {
    price: item.price,
    amountYi: item.amountYi,
    bidTotal: item.bidTotal,
    askTotal: item.askTotal,
    at: Date.now(),
  };
  prevFrames.set(code, current);
  if (!prev) return null;

  const pricePct = prev.price ? round(((item.price - prev.price) / prev.price) * 100, 3) : null;
  const amountDeltaYi = (item.amountYi !== null && prev.amountYi !== null) ? round(item.amountYi - prev.amountYi, 3) : null;
  const bidTotalPct = prev.bidTotal ? round(((item.bidTotal - prev.bidTotal) / prev.bidTotal) * 100, 2) : null;
  const askTotalPct = prev.askTotal ? round(((item.askTotal - prev.askTotal) / prev.askTotal) * 100, 2) : null;

  return {
    intervalMs: Date.now() - prev.at,
    pricePct,
    amountDeltaYi,
    bidTotalPct,
    askTotalPct,
  };
}

function strengthFor(item, delta) {
  let score = 50;
  const reasons = [];
  const r = item.pressureRatio;

  if (r !== null) {
    if (r >= 2) { score += 20; reasons.push('买五档总量显著大于卖五档'); }
    else if (r >= 1.4) { score += 12; reasons.push('买五档总量强于卖五档'); }
    else if (r >= 1.1) { score += 6; reasons.push('买盘略强于卖盘'); }
    else if (r <= 0.5) { score -= 20; reasons.push('卖五档总量显著大于买五档'); }
    else if (r <= 0.7) { score -= 12; reasons.push('卖盘明显强于买盘'); }
    else if (r <= 0.9) { score -= 6; reasons.push('卖盘略强于买盘'); }
    else { reasons.push('买卖盘相对均衡'); }
  }

  if (item.changePct !== null) {
    if (item.changePct >= 7) { score += 10; reasons.push('个股涨幅较高，处于强势区'); }
    else if (item.changePct >= 3) { score += 6; reasons.push('个股涨幅为正且具备一定强度'); }
    else if (item.changePct <= -3) { score -= 10; reasons.push('个股跌幅较大，盘口偏弱'); }
    else if (item.changePct < 0) { score -= 5; reasons.push('个股处于绿盘，承接需谨慎'); }
  }

  if (item.spread !== null && item.spread <= 0.01 && item.price > 0) {
    score += 3;
    reasons.push('买卖价差较小，盘口连续性较好');
  }

  if (delta) {
    if (delta.pricePct !== null) {
      if (delta.pricePct >= 0.2) { score += 10; reasons.push('上一帧至当前价格明显上行'); }
      else if (delta.pricePct > 0) { score += 5; reasons.push('上一帧至当前价格小幅上行'); }
      else if (delta.pricePct <= -0.2) { score -= 10; reasons.push('上一帧至当前价格明显回落'); }
      else if (delta.pricePct < 0) { score -= 5; reasons.push('上一帧至当前价格小幅回落'); }
    }
    if (delta.amountDeltaYi !== null && delta.amountDeltaYi > 0) {
      score += 5;
      reasons.push('成交额相对上一帧增加');
    }
    if (delta.bidTotalPct !== null) {
      if (delta.bidTotalPct >= 10) { score += 7; reasons.push('买五档总量较上一帧增加'); }
      else if (delta.bidTotalPct <= -10) { score -= 7; reasons.push('买五档总量较上一帧减少'); }
    }
    if (delta.askTotalPct !== null) {
      if (delta.askTotalPct <= -10) { score += 7; reasons.push('卖五档总量较上一帧下降'); }
      else if (delta.askTotalPct >= 10) { score -= 7; reasons.push('卖五档总量较上一帧增加'); }
    }
  }

  score = clamp(Math.round(score), 0, 100);
  let label = '盘口均衡';
  if (score >= 80) label = '强承接';
  else if (score >= 65) label = '买盘增强';
  else if (score >= 50) label = '盘口均衡';
  else if (score >= 35) label = '卖压增强';
  else label = '盘口转弱';

  return { score, label, reasons: reasons.slice(0, 8) };
}

function parseSinaQuotes(text, symbols, compare) {
  const byCode = {};
  const re = quoteLineRegex();
  let m;
  while ((m = re.exec(text))) {
    const market = m[1];
    const code = m[2];
    const raw = m[3] || '';
    const fields = raw.split(',');
    const name = fields[0] || '';
    if (!name) continue;

    const open = num(fields[1]);
    const prevClose = num(fields[2]);
    const price = num(fields[3]);
    const high = num(fields[4]);
    const low = num(fields[5]);
    const volume = num(fields[8]);
    const amount = num(fields[9]);
    const amountYi = yi(amount);
    const bid = compactLevel(parseFiveLevels(fields, 10));
    const ask = compactLevel(parseFiveLevels(fields, 20));
    const bidTotal = bid.reduce((s, x) => s + (Number(x.volume) || 0), 0);
    const askTotal = ask.reduce((s, x) => s + (Number(x.volume) || 0), 0);
    const changePct = (prevClose && price !== null) ? round(((price - prevClose) / prevClose) * 100, 2) : null;

    const item = {
      code,
      market,
      name,
      price,
      changePct,
      open,
      prevClose,
      high,
      low,
      volume,
      amountYi,
      bid,
      ask,
      bidTotal,
      askTotal,
      pressureRatio: null,
      spread: null,
      quoteTime: `${fields[30] || ''} ${fields[31] || ''}`.trim(),
      source: 'sina',
    };
    byCode[code] = item;
  }
  return symbols.map(code => byCode[code] || { code, success: false, error: 'No quote returned from sina' });
}

function parseTencentQuotes(text, symbols, compare) {
  const byCode = {};
  const re = /v_([a-z]{2})(\d{6})="([^"]*)";/g;
  let match;
  while ((match = re.exec(text))) {
    const market = match[1];
    const code = match[2];
    const fields = (match[3] || '').split('~');
    const name = fields[1] || '';
    if (!name) continue;
    const price = num(fields[3]);
    const prevClose = num(fields[4]);
    const bid = compactLevel(Array.from({ length: 5 }, (_, index) => ({
      level: index + 1,
      price: num(fields[9 + index * 2]),
      volume: num(fields[10 + index * 2]),
    })));
    const ask = compactLevel(Array.from({ length: 5 }, (_, index) => ({
      level: index + 1,
      price: num(fields[19 + index * 2]),
      volume: num(fields[20 + index * 2]),
    })));
    const bidTotal = bid.reduce((sum, level) => sum + (Number(level.volume) || 0), 0);
    const askTotal = ask.reduce((sum, level) => sum + (Number(level.volume) || 0), 0);
    const item = {
      code,
      market,
      name,
      price,
      changePct: (prevClose && price !== null) ? round(((price - prevClose) / prevClose) * 100, 2) : null,
      open: num(fields[5]),
      prevClose,
      high: num(fields[33]),
      low: num(fields[34]),
      volume: num(fields[6]),
      amountYi: yi(num(fields[37]) === null ? null : num(fields[37]) * 10000),
      bid,
      ask,
      bidTotal,
      askTotal,
      pressureRatio: null,
      spread: null,
      quoteTime: fields[30] || '',
      source: 'tencent',
    };
    byCode[code] = item;
  }
  return symbols.map(code => byCode[code] || { code, success: false, error: 'No quote returned from tencent' });
}

function unavailableItem(code) {
  return { code, success: false, error: 'No usable realtime depth returned' };
}

async function loadOrderbook(symbols, compare) {
  const sina = await runProviderAttempt('sina', 2800, () => requestSinaText(symbols), text => parseSinaQuotes(text, symbols, compare));
  const byCode = new Map(sina.rows.map(item => [item.code, item]));
  const attempts = [sina.attempt];
  let fallbackUsed = false;
  if (byCode.size < symbols.length) {
    const tencent = await runProviderAttempt('tencent', 2500, () => requestTencentText(symbols), text => parseTencentQuotes(text, symbols, compare));
    attempts.push(tencent.attempt);
    for (const item of tencent.rows) {
      if (!byCode.has(item.code)) {
        byCode.set(item.code, item);
        fallbackUsed = true;
      }
    }
  }
  const usable = symbols.map(code => byCode.get(code)).filter(Boolean);
  const success = usable.length > 0;
  const dataQuality = dataQualityFor(usable, symbols.length);
  const selected = [...new Set(usable.map(item => item.source))];
  const data = success
    ? symbols.map(code => byCode.get(code) || unavailableItem(code)).map(item => item.success === false ? item : applyDepthSemantics(item, dataQuality, compare))
    : [];
  return okBase({
    success,
    status: success ? 'OK' : 'DATA_INSUFFICIENT',
    mode: 'orderbook_lite_v1',
    count: usable.length,
    symbols,
    data,
    missingSymbols: success ? symbols.filter(code => !byCode.has(code)) : symbols,
    providerAttempts: attempts,
    selectedProvider: selected.join('+') || null,
    fallbackUsed,
    dataQuality,
  });
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const symbols = parseSymbols(req.query.symbols || req.query.symbol || req.query.code, 8);
  if (!symbols.length) return json(res, 400, { success: false, error: 'Missing symbols, e.g. ?symbols=600519,300750' });

  const ttlMs = clamp(Number(req.query.ttlMs || 5000) || 5000, 1000, 10000);
  const compare = String(req.query.compare || '').toLowerCase() === 'true';
  const key = `orderbook-lite:v2:${symbols.join(',')}:compare=${compare}`;

  try {
    const { value, cached: cacheHit } = await cached(key, ttlMs, async () => {
      const value = await loadOrderbook(symbols, compare);
      if (!value.success) {
        const error = new Error('all realtime depth providers failed');
        error.orderbook = value;
        throw error;
      }
      return {
        ...value,
        ttlMs,
        compare,
        note: '轻量五档盘口，仅查询指定股票；不做全市场扫描，不写 Redis，不等同于 Level-2 逐笔盘口。',
        limits: {
          maxSymbols: 8,
          defaultTtlMs: 5000,
          minTtlMs: 1000,
          maxTtlMs: 10000,
        },
      };
    });
    return json(res, 200, { ...value, cacheHit });
  } catch (err) {
    if (err?.orderbook) {
      return json(res, 200, okBase({
        ...err.orderbook,
        success: false,
        error: 'No usable realtime depth provider returned data',
      }));
    }
    return json(res, 200, okBase({
      success: false,
      mode: 'orderbook_lite_v1',
      error: String(err && err.message ? err.message : err),
      count: 0,
      symbols,
      data: [],
      note: '上游盘口源失败时返回 success=false，但 HTTP 仍为 200，避免拖垮主复盘链路。',
    }));
  }
};

module.exports.parseSinaQuotes = parseSinaQuotes;
module.exports.parseTencentQuotes = parseTencentQuotes;
module.exports.loadOrderbook = loadOrderbook;
