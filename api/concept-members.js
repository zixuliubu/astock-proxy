const { json, setCors, buildUrl, requestJson, cached, okBase, num, yi } = require('./_stock-utils');

function splitList(value, max = 3) {
  return String(value || '').split(/[，,\s]+/).map(x => x.trim()).filter(Boolean).slice(0, max);
}

function normalizeBoard(row, source = '') {
  return {
    bk: row.f12 || row.code || '',
    name: row.f14 || row.name || '',
    source,
    changePct: num(row.f3),
    amountYi: yi(row.f6),
    mainNetYi: yi(row.f62),
  };
}

function normalizeMember(row, source = '') {
  return {
    code: row.f12 || '',
    name: row.f14 || '',
    source,
    price: num(row.f2),
    changePct: num(row.f3),
    amountYi: yi(row.f6),
    turnover: num(row.f8),
    pe: num(row.f9),
    marketCapYi: yi(row.f20),
    industry: row.f100 || '',
  };
}

function fsFor(kind) {
  if (kind === 'industry') return 'm:90+t:2';
  if (kind === 'both') return 'm:90+t:2,m:90+t:3';
  return 'm:90+t:3';
}

function parseDiff(data) {
  let diff = data?.data?.diff || [];
  if (diff && !Array.isArray(diff) && typeof diff === 'object') diff = Object.values(diff);
  return Array.isArray(diff) ? diff : [];
}

async function requestClist(host, params, label, referer = 'https://quote.eastmoney.com/') {
  const url = buildUrl(`${host}/api/qt/clist/get`, params);
  const data = await requestJson(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer, Origin: 'https://quote.eastmoney.com' },
    timeoutMs: 12000,
  });
  const rows = parseDiff(data);
  if (!rows.length) throw new Error(`${label} empty`);
  return rows;
}

async function fetchBoardList(kind = 'concept') {
  const params = {
    pn: 1,
    pz: 500,
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: 'f3',
    fs: fsFor(kind),
    fields: 'f12,f14,f3,f6,f62',
  };
  const attempts = [];
  const candidates = [
    ['push2', 'https://push2.eastmoney.com', params],
    ['hsmarketwg', 'https://push2.hsmarketwg.eastmoney.com', { ...params, cb: 'jQuery' }],
  ];
  for (const [label, host, p] of candidates) {
    try {
      const rows = await requestClist(host, p, label);
      return { data: rows.map(x => normalizeBoard(x, label)).filter(x => x.bk && x.name), attempts };
    } catch (err) {
      attempts.push({ source: label, error: String(err && err.message ? err.message : err) });
    }
  }

  // 兜底：hotboard 已被现有 /api/sector 证明可用，但它更偏热门板块，概念覆盖可能不完整。
  try {
    const hotFs = kind === 'industry' ? 'm:90+t:2' : 'm:90+t:3';
    const url = buildUrl('https://push2.hsmarketwg.eastmoney.com/api/qt/clist/hotboard/get', {
      pn: 1,
      pz: 500,
      po: 1,
      np: 1,
      fltt: 2,
      invt: 2,
      fid: 'f3',
      fs: hotFs,
      fields: 'f12,f14,f2,f3,f5,f6,f62',
      cb: 'jQuery',
    });
    const data = await requestJson(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 10000 });
    const rows = parseDiff(data);
    if (!rows.length) throw new Error('hotboard empty');
    return { data: rows.map(x => normalizeBoard(x, 'hotboard')).filter(x => x.bk && x.name), attempts, fallbackNote: 'hotboard 兜底源只覆盖热门板块，关键词可能找不到完整概念。' };
  } catch (err) {
    attempts.push({ source: 'hotboard', error: String(err && err.message ? err.message : err) });
  }

  return { data: [], attempts, fallbackNote: '板块列表全部上游失败。' };
}

async function resolveBoards({ bk, keyword, kind }) {
  const explicit = splitList(bk, 3).map(x => ({ bk: x.toUpperCase(), name: '', source: 'explicit' })).filter(x => /^BK\d+$/i.test(x.bk));
  if (explicit.length) return { boards: explicit, diagnostics: { explicit: true } };
  const words = splitList(keyword, 3);
  if (!words.length) return { boards: [], diagnostics: { error: 'missing keyword or bk' } };
  const { value } = await cached(`board-list:v2:${kind || 'concept'}`, 5 * 60 * 1000, () => fetchBoardList(kind || 'concept'));
  const all = value?.data || [];
  const boards = words.map(w => all.find(b => b.name.includes(w) || b.bk.toUpperCase() === w.toUpperCase())).filter(Boolean).slice(0, 3);
  return { boards, diagnostics: { attempts: value?.attempts || [], fallbackNote: value?.fallbackNote || '', matchedKeywords: words, boardListCount: all.length } };
}

async function fetchMembers(board, limit = 80) {
  const pz = Math.min(Math.max(Number(limit || 80), 1), 100);
  const params = {
    pn: 1,
    pz,
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: 'f3',
    fs: `b:${board.bk}`,
    fields: 'f12,f14,f2,f3,f6,f8,f9,f20,f100',
  };
  const attempts = [];
  const candidates = [
    ['push2', 'https://push2.eastmoney.com', params],
    ['hsmarketwg', 'https://push2.hsmarketwg.eastmoney.com', { ...params, cb: 'jQuery' }],
  ];
  for (const [label, host, p] of candidates) {
    try {
      const rows = await requestClist(host, p, label);
      const members = rows.map(x => normalizeMember(x, label)).filter(x => x.code);
      return { ...board, source: label, count: members.length, members, attempts };
    } catch (err) {
      attempts.push({ source: label, error: String(err && err.message ? err.message : err) });
    }
  }
  return { ...board, source: 'none', count: 0, members: [], attempts, error: 'member upstream failed' };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const kind = ['concept', 'industry', 'both'].includes(req.query.kind) ? req.query.kind : 'concept';
  const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 100);
  const ttlMs = Number(req.query.ttlMs || 5 * 60 * 1000);
  const diagnostics = {};

  try {
    const resolved = await resolveBoards({ bk: req.query.bk || req.query.board, keyword: req.query.keyword || req.query.name, kind });
    Object.assign(diagnostics, resolved.diagnostics || {});
    const boards = resolved.boards || [];
    if (!boards.length) {
      return json(res, 200, okBase({
        success: false,
        mode: 'concept_members_v2',
        error: 'No matched board. Use ?bk=BKxxxx or a more exact ?keyword=',
        kind,
        limit,
        count: 0,
        data: [],
        diagnostics,
        note: '没有匹配到板块时不再返回 502；请用更精确板块名或 BK 代码。',
      }));
    }

    const data = [];
    for (const board of boards.slice(0, 3)) {
      const key = `concept-members:v2:${board.bk}:${limit}`;
      const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchMembers(board, limit));
      data.push({ ...value, cached: fromCache });
    }

    return json(res, 200, okBase({
      mode: 'concept_members_v2',
      kind,
      limit,
      count: data.length,
      data,
      diagnostics,
      limits: { maxBoards: 3, maxMembersPerBoard: 100, redisWrites: 0 },
      note: '板块成分股用于验证扩散和梯队，不直接构成买点；若上游失败会返回 diagnostics 而不是 502。',
    }));
  } catch (err) {
    return json(res, 200, okBase({ success: false, mode: 'concept_members_v2', error: String(err && err.message ? err.message : err), data: [], diagnostics }));
  }
};
