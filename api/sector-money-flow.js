const { json, setCors, buildUrl, requestJson, cached, okBase, num, yi } = require('./_stock-utils');
const { failure, validateSectorRows } = require('./_data-contracts');

const EASTMONEY_TOKEN = 'b2884a393a59ad64002292a3e90d46a5';
const FLOW_FIELDS = 'f12,f14,f2,f3,f6,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205,f124';

function missingFields(row) {
  return [
    ['changePct', 'f3'],
    ['amountYi', 'f6'],
    ['mainNetYi', 'f62'],
  ].filter(([, raw]) => num(row?.[raw]) === null).map(([field]) => field);
}

function normalize(row, sourceKind, source) {
  const missing = missingFields(row);
  return {
    bk: row.f12 || '',
    name: row.f14 || '',
    kind: sourceKind,
    source,
    changePct: num(row.f3),
    amountYi: yi(row.f6),
    mainNetYi: yi(row.f62),
    superNetYi: yi(row.f66),
    largeNetYi: yi(row.f72),
    midNetYi: yi(row.f78),
    smallNetYi: yi(row.f84),
    mainNetRatio: num(row.f184),
    missingFields: missing,
    missingReason: missing.length ? `upstream fields unavailable: ${missing.join(',')}` : '',
  };
}

function parseDiff(data) {
  let diff = data?.data?.diff || [];
  if (diff && !Array.isArray(diff) && typeof diff === 'object') diff = Object.values(diff);
  return Array.isArray(diff) ? diff : [];
}

function sectorType(kind) {
  return kind === 'industry' ? '2' : '3';
}

async function fetchOneKind(kind, top, sort) {
  const fid = { mainNet: 'f62', changePct: 'f3', amount: 'f6' }[sort] || 'f62';
  const url = buildUrl('https://push2.eastmoney.com/api/qt/clist/get', {
    pn: 1,
    pz: top,
    po: 1,
    np: 1,
    ut: EASTMONEY_TOKEN,
    fltt: 2,
    invt: 2,
    fid0: fid,
    fs: `m:90 t:${sectorType(kind)}`,
    stat: 1,
    fields: FLOW_FIELDS,
    rt: 52975239,
    _: Date.now(),
  });
  const payload = await requestJson(url, {
    headers: { Referer: 'https://data.eastmoney.com/bkzj/', Origin: 'https://data.eastmoney.com' },
    timeoutMs: 12000,
  });
  const rows = parseDiff(payload);
  if (!rows.length) throw new Error(`${kind} board flow returned no rows`);
  return rows.map(row => normalize(row, kind, 'eastmoney_push2_akshare_contract'));
}

async function fetchFlow(kind = 'concept', top = 30, sort = 'mainNet') {
  const kinds = kind === 'both' ? ['industry', 'concept'] : [kind];
  const settled = await Promise.allSettled(kinds.map(item => fetchOneKind(item, top, sort)));
  const attempts = [];
  const rows = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') rows.push(...result.value);
    else attempts.push({ kind: kinds[index], error: String(result.reason?.message || result.reason) });
  });
  const deduped = [...new Map(rows.map(row => [`${row.kind}:${row.bk}`, row])).values()];
  const sortField = { mainNet: 'mainNetYi', changePct: 'changePct', amount: 'amountYi' }[sort] || 'mainNetYi';
  deduped.sort((left, right) => Number(right[sortField] ?? -Infinity) - Number(left[sortField] ?? -Infinity));
  const validation = validateSectorRows(deduped);
  if (!validation.success) {
    return { success: false, data: deduped, attempts, validation };
  }
  return {
    success: true,
    source: 'eastmoney_push2_akshare_contract',
    data: deduped,
    attempts,
    status: attempts.length ? 'PARTIAL' : 'OK',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, failure('METHOD_NOT_ALLOWED', 'Method not allowed'));

  const kind = ['concept', 'industry', 'both'].includes(req.query.kind) ? req.query.kind : 'concept';
  const top = Math.min(Math.max(Number(req.query.top || 30), 1), 60);
  const sort = ['mainNet', 'changePct', 'amount'].includes(req.query.sort) ? req.query.sort : 'mainNet';
  const ttlMs = Number(req.query.ttlMs || 3 * 60 * 1000);
  const key = `sector-money-flow:v3:${kind}:${top}:${sort}`;

  try {
    const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchFlow(kind, top, sort));
    if (!value.success) {
      return json(res, 503, {
        ...value.validation,
        mode: 'sector_money_flow_v3',
        kind,
        sort,
        data: value.data,
        diagnostics: { attempts: value.attempts },
      });
    }
    return json(res, 200, okBase({
      mode: 'sector_money_flow_v3',
      status: value.status,
      source: value.source,
      kind,
      sort,
      top,
      cached: fromCache,
      count: value.data.length,
      data: value.data,
      diagnostics: { attempts: value.attempts },
    }));
  } catch (err) {
    return json(res, 503, {
      ...failure('UPSTREAM_FAILED', String(err?.message || err)),
      mode: 'sector_money_flow_v3',
      kind,
      sort,
      data: [],
    });
  }
};

module.exports.fetchFlow = fetchFlow;
module.exports.normalize = normalize;
