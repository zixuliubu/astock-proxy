const { json, setCors, buildUrl, requestJson, cached, okBase, num, yi } = require('./_stock-utils');

function splitList(value, max = 3) {
  return String(value || '').split(/[，,\s]+/).map(x => x.trim()).filter(Boolean).slice(0, max);
}

function normalizeBoard(row) {
  return {
    bk: row.f12 || row.code || '',
    name: row.f14 || row.name || '',
    changePct: num(row.f3),
    amountYi: yi(row.f6),
    mainNetYi: yi(row.f62),
  };
}

async function fetchBoardList(kind = 'concept') {
  const fs = kind === 'industry' ? 'm:90+t:2' : kind === 'both' ? 'm:90+t:2,m:90+t:3' : 'm:90+t:3';
  const url = buildUrl('https://push2.eastmoney.com/api/qt/clist/get', {
    pn: 1,
    pz: 500,
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: 'f3',
    fs,
    fields: 'f12,f14,f3,f6,f62',
  });
  const data = await requestJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 10000 });
  let diff = data?.data?.diff || [];
  if (diff && !Array.isArray(diff) && typeof diff === 'object') diff = Object.values(diff);
  return (Array.isArray(diff) ? diff : []).map(normalizeBoard).filter(x => x.bk && x.name);
}

async function resolveBoards({ bk, keyword, kind }) {
  const explicit = splitList(bk, 3).map(x => ({ bk: x.toUpperCase(), name: '' })).filter(x => /^BK\d+$/i.test(x.bk));
  if (explicit.length) return explicit;
  const words = splitList(keyword, 3);
  if (!words.length) return [];
  const boards = await cached(`board-list:${kind || 'concept'}`, 5 * 60 * 1000, () => fetchBoardList(kind || 'concept'));
  const all = boards.value || [];
  return words.map(w => all.find(b => b.name.includes(w) || b.bk.toUpperCase() === w.toUpperCase())).filter(Boolean).slice(0, 3);
}

function normalizeMember(row) {
  return {
    code: row.f12 || '',
    name: row.f14 || '',
    price: num(row.f2),
    changePct: num(row.f3),
    amountYi: yi(row.f6),
    turnover: num(row.f8),
    pe: num(row.f9),
    marketCapYi: yi(row.f20),
    industry: row.f100 || '',
  };
}

async function fetchMembers(board, limit = 80) {
  const url = buildUrl('https://push2.eastmoney.com/api/qt/clist/get', {
    pn: 1,
    pz: Math.min(Math.max(Number(limit || 80), 1), 100),
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: 'f3',
    fs: `b:${board.bk}`,
    fields: 'f12,f14,f2,f3,f6,f8,f9,f20,f100',
  });
  const data = await requestJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 12000 });
  let diff = data?.data?.diff || [];
  if (diff && !Array.isArray(diff) && typeof diff === 'object') diff = Object.values(diff);
  const members = (Array.isArray(diff) ? diff : []).map(normalizeMember).filter(x => x.code);
  return { ...board, count: members.length, members };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });

  const kind = ['concept', 'industry', 'both'].includes(req.query.kind) ? req.query.kind : 'concept';
  const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 100);
  const ttlMs = Number(req.query.ttlMs || 5 * 60 * 1000);
  const diagnostics = {};

  try {
    const boards = await resolveBoards({ bk: req.query.bk || req.query.board, keyword: req.query.keyword || req.query.name, kind });
    if (!boards.length) return json(res, 400, okBase({ success: false, mode: 'concept_members_v1', error: 'Missing board. Use ?bk=BKxxxx or ?keyword=机器人', data: [] }));
    const data = [];
    for (const board of boards.slice(0, 3)) {
      try {
        const key = `concept-members:${board.bk}:${limit}`;
        const { value, cached: fromCache } = await cached(key, ttlMs, () => fetchMembers(board, limit));
        data.push({ ...value, cached: fromCache });
      } catch (err) {
        diagnostics[board.bk] = String(err && err.message ? err.message : err);
        data.push({ ...board, count: 0, members: [], error: diagnostics[board.bk] });
      }
    }
    return json(res, 200, okBase({ mode: 'concept_members_v1', kind, limit, count: data.length, data, diagnostics, limits: { maxBoards: 3, maxMembersPerBoard: 100, redisWrites: 0 }, note: '板块成分股用于验证扩散和梯队，不直接构成买点。' }));
  } catch (err) {
    return json(res, 500, { success: false, mode: 'concept_members_v1', error: String(err && err.message ? err.message : err), diagnostics, updateTime: new Date().toISOString() });
  }
};
