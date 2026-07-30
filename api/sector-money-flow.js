const { json, setCors, buildUrl, requestJson, requestJsonFallback, cached, okBase, num, yi } = require('./_stock-utils');
const { failure, validateSectorRows } = require('./_data-contracts');

const EASTMONEY_TOKEN = 'b2884a393a59ad64002292a3e90d46a5';
const FLOW_FIELDS = 'f12,f14,f2,f3,f6,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205,f124';
const PUSH2_HOSTS = [
  ['eastmoney_push2_79', 'https://79.push2.eastmoney.com'],
  ['eastmoney_push2_17', 'https://17.push2.eastmoney.com'],
  ['eastmoney_push2', 'https://push2.eastmoney.com'],
];
const SINA_MONEYFLOW_URL = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk';

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

function normalizeSina(row, sourceKind) {
  const inflow = num(row?.inamount);
  const outflow = num(row?.outamount);
  const classifiedAmount = inflow !== null && outflow !== null ? inflow + outflow : null;
  const missing = [
    ['changePct', num(row?.avg_changeratio)],
    ['amountYi', classifiedAmount],
    ['netFlowYi', num(row?.netamount)],
  ].filter(([, value]) => value === null).map(([field]) => field);
  return {
    bk: row?.category || '',
    name: row?.name || '',
    kind: sourceKind,
    source: 'sina_moneyflow',
    changePct: num(row?.avg_changeratio) === null ? null : Number((num(row.avg_changeratio) * 100).toFixed(4)),
    amountYi: yi(classifiedAmount),
    amountSemantics: 'classified_inflow_plus_outflow',
    mainNetYi: null,
    netFlowYi: yi(row?.netamount),
    netFlowRatio: num(row?.ratioamount) === null ? null : Number((num(row.ratioamount) * 100).toFixed(4)),
    mainNetRatio: null,
    missingFields: missing,
    missingReason: 'Sina exposes overall classified net flow for sectors, not a main-order-only net-flow field.',
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
  const params = {
    pn: 1,
    pz: Math.max(top, 20),
    po: 1,
    np: 1,
    ut: EASTMONEY_TOKEN,
    fltt: 2,
    invt: 2,
    fid0: fid,
    fs: `m:90 t:${sectorType(kind)} f:!50`,
    stat: 1,
    fields: FLOW_FIELDS,
    rt: 52975239,
    _: Date.now(),
  };
  const candidates = PUSH2_HOSTS.map(([source, host]) => ({
    source,
    url: buildUrl(`${host}/api/qt/clist/get`, params),
  }));
  const eastmoney = async () => {
    const result = await requestJsonFallback(candidates, {
      headers: { Referer: 'https://data.eastmoney.com/bkzj/', Origin: 'https://data.eastmoney.com' },
      timeoutMs: 3000,
      accept: payload => parseDiff(payload).length > 0,
    });
    return {
      rows: parseDiff(result.data)
        .slice(0, top)
        .map(row => normalize(row, kind, result.source)),
      source: result.source,
      attempts: result.attempts,
    };
  };
  const sina = async () => {
    const sinaUrl = buildUrl(SINA_MONEYFLOW_URL, {
      page: 1,
      num: Math.max(200, top),
      sort: sort === 'changePct' ? 'avg_changeratio' : 'netamount',
      asc: 0,
      fenlei: kind === 'industry' ? 0 : 1,
      _: Date.now(),
    });
    const data = await requestJson(sinaUrl, {
      timeoutMs: 8000,
      headers: { Referer: 'https://vip.stock.finance.sina.com.cn/moneyflow/' },
    });
    if (!Array.isArray(data) || !data.length) throw new Error('Sina sector payload is empty');
    return {
      rows: data.map(row => normalizeSina(row, kind)).slice(0, top),
      source: 'sina_moneyflow',
      attempts: [{ source: 'sina_moneyflow', status: 'ok', rawCount: data.length }],
    };
  };
  try {
    return await sina();
  } catch (sinaError) {
    try {
      const result = await eastmoney();
      result.attempts.unshift({ source: 'sina_moneyflow', error: String(sinaError?.message || sinaError) });
      return result;
    } catch (eastmoneyError) {
      const error = new Error('All independent sector providers failed');
      error.attempts = [
        { source: 'sina_moneyflow', error: String(sinaError?.message || sinaError) },
        ...(eastmoneyError.attempts || []),
      ];
      throw error;
    }
  }
}

async function fetchFlow(kind = 'concept', top = 30, sort = 'mainNet') {
  const kinds = kind === 'both' ? ['industry', 'concept'] : [kind];
  const attempts = [];
  const rows = [];
  const sources = {};
  const settled = await Promise.allSettled(kinds.map(item => fetchOneKind(item, top, sort)));
  settled.forEach((resultState, index) => {
    const item = kinds[index];
    if (resultState.status === 'fulfilled') {
      const result = resultState.value;
      rows.push(...result.rows);
      sources[item] = result.source;
      attempts.push(...result.attempts.map(attempt => ({ kind: item, ...attempt })));
    } else {
      const error = resultState.reason;
      attempts.push(...(error.attempts || [{ error: String(error?.message || error) }])
        .map(attempt => ({ kind: item, ...attempt })));
    }
  });
  const deduped = [...new Map(rows.map(row => [`${row.kind}:${row.bk}`, row])).values()];
  const sortField = { mainNet: 'mainNetYi', changePct: 'changePct', amount: 'amountYi' }[sort] || 'mainNetYi';
  const sortValue = row => sort === 'mainNet'
    ? row.mainNetYi ?? row.netFlowYi
    : row[sortField];
  deduped.sort((left, right) => Number(sortValue(right) ?? -Infinity) - Number(sortValue(left) ?? -Infinity));
  const validation = validateSectorRows(deduped);
  const availableKinds = kinds.filter(item => deduped.some(row => row.kind === item));
  const missingKinds = kinds.filter(item => !availableKinds.includes(item));
  if (!validation.success || missingKinds.length) {
    return {
      success: false,
      data: deduped,
      attempts,
      sources,
      availableKinds,
      missingKinds,
      validation: validation.success
        ? failure('DATA_INSUFFICIENT', 'One or more requested sector kinds are unavailable', { missingKinds })
        : validation,
    };
  }
  return {
    success: true,
    source: [...new Set(Object.values(sources))].join('+'),
    sources,
    data: deduped,
    attempts,
    availableKinds,
    missingKinds,
    status: 'OK',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, failure('METHOD_NOT_ALLOWED', 'Method not allowed'));

  const kind = ['concept', 'industry', 'both'].includes(req.query.kind) ? req.query.kind : 'concept';
  const top = Math.min(Math.max(Number(req.query.top || 30), 1), 60);
  const sort = ['mainNet', 'changePct', 'amount'].includes(req.query.sort) ? req.query.sort : 'mainNet';
  const ttlMs = Number(req.query.ttlMs || 3 * 60 * 1000);
  const key = `sector-money-flow:v4:${kind}:${top}:${sort}`;

  try {
    const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchFlow(kind, top, sort));
    if (!value.success) {
      return json(res, 503, {
        ...value.validation,
        mode: 'sector_money_flow_v4',
        kind,
        sort,
        data: value.data,
        diagnostics: {
          attempts: value.attempts,
          sources: value.sources,
          availableKinds: value.availableKinds,
          missingKinds: value.missingKinds,
        },
      });
    }
    return json(res, 200, okBase({
      mode: 'sector_money_flow_v4',
      status: value.status,
      source: value.source,
      kind,
      sort,
      top,
      cached: fromCache,
      count: value.data.length,
      data: value.data,
      diagnostics: {
        attempts: value.attempts,
        sources: value.sources,
        availableKinds: value.availableKinds,
        missingKinds: value.missingKinds,
      },
    }));
  } catch (err) {
    return json(res, 503, {
      ...failure('UPSTREAM_FAILED', String(err?.message || err)),
      mode: 'sector_money_flow_v4',
      kind,
      sort,
      data: [],
    });
  }
};

module.exports.fetchFlow = fetchFlow;
module.exports.normalize = normalize;
module.exports.normalizeSina = normalizeSina;
