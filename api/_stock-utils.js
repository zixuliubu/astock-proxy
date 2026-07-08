const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const cache = global.__ASTOCK_EXTRA_CACHE__ || new Map();
global.__ASTOCK_EXTRA_CACHE__ = cache;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-capture-token');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function cleanCode(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/(\d{6})/);
  return match ? match[1] : '';
}

function marketPrefix(code) {
  if (code.startsWith('6') || code.startsWith('9')) return 'sh';
  if (code.startsWith('8') || code.startsWith('4')) return 'bj';
  return 'sz';
}

function secid(code) {
  return `${code.startsWith('6') ? 1 : 0}.${code}`;
}

function prefixedCode(code) {
  return `${marketPrefix(code)}${code}`;
}

function parseSymbols(value, max = 5) {
  const list = String(value || '')
    .split(/[，,\s]+/)
    .map(cleanCode)
    .filter(Boolean);
  return [...new Set(list)].slice(0, max);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function wan(v) {
  const n = num(v);
  return n === null ? null : Number((n / 10000).toFixed(2));
}

function yi(v) {
  const n = num(v);
  return n === null ? null : Number((n / 100000000).toFixed(3));
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function parseMaybeJsonp(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const l = s.indexOf('(');
  const r = s.lastIndexOf(')');
  if (l >= 0 && r > l) return JSON.parse(s.slice(l + 1, r));
  return {};
}

async function requestText(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 10000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...(options.headers || {}) },
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(url, options = {}) {
  const text = await requestText(url, options);
  return parseMaybeJsonp(text);
}

function buildUrl(base, params = {}) {
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  return url.toString();
}

async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.time < ttlMs) return { value: hit.value, cached: true };
  const value = await loader();
  cache.set(key, { time: now, value });
  return { value, cached: false };
}

function okBase(extra = {}) {
  return { success: true, ...extra, updateTime: new Date().toISOString() };
}

module.exports = {
  DEFAULT_UA,
  json,
  setCors,
  cleanCode,
  marketPrefix,
  secid,
  prefixedCode,
  parseSymbols,
  num,
  wan,
  yi,
  stripHtml,
  parseMaybeJsonp,
  requestText,
  requestJson,
  buildUrl,
  cached,
  okBase,
};
