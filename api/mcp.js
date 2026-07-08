const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';
const SERVER_NAME = 'astock-mcp';
const SERVER_VERSION = '1.7.1';
const PRIVATE_MCP_PATH = '/mcp-laoda-20260708-x7k29q';

function schema(props = {}, required = []) { return { type: 'object', properties: props, required, additionalProperties: false }; }
function emptyInputSchema() { return schema(); }
function dateInputSchema() { return schema({ date: { type: 'string', description: '日期 YYYYMMDD；不填默认今日。' } }); }
function symbolsInputSchema(extra = {}, required = ['symbols']) { return schema({ symbols: { type: 'string', description: '股票代码，多个用英文逗号分隔，例如 600519,300750。' }, ...extra }, required); }
function out(extra = {}) { return { type: 'object', properties: { success: { type: 'boolean' }, updateTime: { type: 'string' }, ...extra }, additionalProperties: true }; }
function tool(name, title, description, inputSchema, outputSchema = out()) { return { name, title, description, inputSchema, outputSchema, annotations: { readOnlyHint: true } }; }

const tools = [
  tool('get_health_check', '获取服务健康检查', '检查 astock-proxy 服务版本、MCP 路径、已挂载接口、环境变量是否存在，以及容量策略。不会返回任何 secret 值。', schema({ full: { type: 'boolean', description: '是否返回完整检查；当前保留字段。' } })),
  tool('get_daily_review_bundle', '获取一键短线复盘聚合包', '一键聚合今日短线复盘所需数据。当前默认返回增强包：基础盘口数据 + 核心票概念、资金流、新闻公告、人气榜、观察池自动标签。适用于“复盘今天”“开搞”“今天盘面怎么变化”。', schema({ date: { type: 'string', description: '日期 YYYYMMDD。' }, group: { type: 'string', description: '观察池组：default、semiconductor、robot、ai_compute、innovation_drug、fluorochemical、paper、market_core。' }, symbols: { type: 'string', description: '自定义核心观察票，多个逗号分隔。' }, raw: { type: 'boolean', description: '是否返回原始完整数据。' }, extra: { type: 'boolean', description: '是否返回增强信号；默认 true。' } })),
  tool('get_stock_quote', '获取A股个股实时行情', '查询A股个股实时行情，支持多个代码。', symbolsInputSchema({ detail: { type: 'boolean', description: '是否返回补充详情。' } })),
  tool('get_market_overview', '获取大盘指数和两市成交额', '查询指数表现、成交额近似值、涨跌家数和市场总览标签。', emptyInputSchema()),
  tool('get_limit_up_pool', '获取今日涨停池', '查询涨停池、连板数据、最高板、二板、三板、首板、题材归因。', dateInputSchema()),
  tool('get_broken_limit_pool', '获取今日炸板池', '查询炸板池、炸板数量、炸板题材和炸板时间。', dateInputSchema()),
  tool('get_limit_down_pool', '获取今日跌停池', '查询跌停池、连续跌停、跌停时间和风险方向。', dateInputSchema()),
  tool('get_lianban_ladder', '获取标准化连板梯队', '按最高板、三板、二板、首板、连板分布整理。', dateInputSchema()),
  tool('get_core_stock_watchlist', '获取板块核心大票和观察池状态', '查询板块核心大票或自定义观察票的成交额、涨跌幅、分时位置和承接强弱。', schema({ group: { type: 'string', description: '预设观察组。' }, symbols: { type: 'string', description: '自定义股票代码。' } })),
  tool('get_hot_sectors', '获取A股热门板块', '查询热门板块、板块涨幅、强度，用于判断主线、次主线和资金进攻方向。', emptyInputSchema()),
  tool('get_market_sentiment', '获取A股市场情绪', '查询涨停数、跌停数、炸板率、连板分布等市场情绪数据。', emptyInputSchema()),
  tool('get_intraday_node_snapshot', '获取盘中节点快照', '获取当前时刻所属10分钟盘中节点、下一节点、指数/情绪/连板/板块快照。', emptyInputSchema()),
  tool('get_intraday_timeline', '获取已保存的盘中节点变化时间线', '读取已保存的10分钟级盘中节点快照，输出节点变化、涨停变化、炸板变化、成交额变化、连板高度变化。', dateInputSchema()),
  tool('get_news_catalysts', '获取消息面催化线索', '获取盘中/盘后财经快讯和题材催化线索；只做催化验证，不作为硬盘口主源。', emptyInputSchema()),
  tool('get_dragon_tiger_list', '获取龙虎榜列表', '获取东方财富龙虎榜列表，包括上榜原因、净买额、买入额、卖出额。', dateInputSchema()),
  tool('get_stock_concepts', '获取个股概念和板块归属', '轻量查询个股所属行业/概念/地域板块和概念标签，用于题材归因、板块联动验证、盘前观察池归类。', symbolsInputSchema()),
  tool('get_stock_popularity', '获取市场人气榜和个股热榜概念', '查询同花顺热榜、东方财富人气榜，以及指定个股的人气关联概念。用于观察散户关注度、踏空资金和热度扩散。', schema({ top: { type: 'integer', description: '前N名，默认50，最多100。' }, period: { type: 'string', description: 'hour 或 day。' }, source: { type: 'string', description: 'both、ths、eastmoney。' }, symbols: { type: 'string', description: '可选个股代码。' } })),
  tool('get_stock_capital_flow', '获取个股资金流摘要', '查询东方财富个股资金流，支持分钟资金流、日级资金流或两者。用于验证核心票承接和容量资金态度。', symbolsInputSchema({ range: { type: 'string', description: 'minute、daily、both。' }, dailyLimit: { type: 'integer', description: '日级资金流返回天数，最多120。' } })),
  tool('get_stock_news', '获取个股新闻和公告催化', '查询指定个股的东方财富新闻和巨潮公告，并提取催化线索。用于解释异动、盘后验证和次日预案。', symbolsInputSchema({ include: { type: 'string', description: 'all、news、announcements。' }, pageSize: { type: 'integer', description: '每只股票新闻/公告数量，最多50。' } })),
  tool('get_stock_kline', '获取A股K线行情备源', 'Ashare轻量移植版：新浪/腾讯双源K线，支持日/周/月和1m/5m/15m/30m/60m分钟线。用于分时、日K、趋势中军验证，不做全市场落库。', symbolsInputSchema({ frequency: { type: 'string', description: '1d、1w、1M、1m、5m、15m、30m、60m，默认1d。' }, count: { type: 'integer', description: 'K线条数，默认60，最多240。' }, source: { type: 'string', description: 'auto、sina、tencent，默认auto。' } })),
  tool('get_review_rules', '获取短线复盘与交易系统规则模板', '返回确认优先交易系统的复盘模板、情绪周期、观察池标签、策略模板、监控模板和连板梯队展示规则。静态规则接口，不请求外部源。', schema({ section: { type: 'string', description: 'all、principles、dailyReviewTemplate、intradayTimelineTemplate、watchlistLabels、emotionCycle、strategyTemplates、monitorTemplates、ladderDisplay、capacityPolicy。默认all。' } })),
  tool('get_concept_members', '获取板块/概念成分股', '按东方财富板块代码 BKxxxx 或关键词查询概念/行业成分股。用于验证板块扩散、中军、后排和容量核心。默认最多3个板块、每板块80只。', schema({ bk: { type: 'string', description: '板块代码，如 BKxxxx，多个逗号分隔。' }, keyword: { type: 'string', description: '板块关键词，如 机器人、半导体、算力。' }, kind: { type: 'string', description: 'concept、industry、both，默认 concept。' }, limit: { type: 'integer', description: '每个板块返回数量，默认80，最多100。' } })),
  tool('get_sector_money_flow', '获取板块资金流', '查询东方财富行业/概念板块资金流榜单。用于验证主线是否有容量资金参与；默认不进入10分钟自动采样。', schema({ kind: { type: 'string', description: 'concept、industry、both，默认 concept。' }, top: { type: 'integer', description: '返回前N，默认30，最多60。' }, sort: { type: 'string', description: 'mainNet、changePct、amount，默认 mainNet。' } })),
  tool('get_limit_reason', '获取涨停原因归因增强', '基于涨停池原因、行业、概念标签和可选新闻公告生成涨停原因证据。用于题材归因增强和主线确认。', schema({ date: { type: 'string', description: '日期 YYYYMMDD。' }, symbols: { type: 'string', description: '可选，只看指定股票。' }, top: { type: 'integer', description: '默认30，最多50。' }, includeNews: { type: 'boolean', description: '是否附加新闻公告催化，默认 false。' } })),
  tool('get_watchlist_auto_label', '观察池自动打标签', '自动给观察池或自定义股票打标签：盘前固定、盘中新增、确认用、可参与观察、风险锚、降级删除。用于避免盘中马后炮加票。', schema({ group: { type: 'string', description: '观察池组，默认 default。' }, symbols: { type: 'string', description: '自定义股票代码。' }, context: { type: 'string', description: 'pre、intraday、new，默认 pre。' }, light: { type: 'boolean', description: '轻量模式，只用观察池数据，默认 false。' } })),
];

function json(res, status, body) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }
function setCommonHeaders(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version'); res.setHeader('Cache-Control', 'no-store'); }
async function readBody(req) { if (req.body && typeof req.body === 'object') return req.body; if (typeof req.body === 'string') return JSON.parse(req.body || '{}'); const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString('utf8'); return raw ? JSON.parse(raw) : {}; }
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }; }
function requestPath(req) { try { return new URL(req.url || PRIVATE_MCP_PATH, 'https://astock-proxy.vercel.app').pathname; } catch (err) { return PRIVATE_MCP_PATH; } }
function safeUrlString(url) { try { const safe = new URL(url.toString()); if (safe.searchParams.has('token')) safe.searchParams.set('token', '[redacted]'); return safe.toString(); } catch (err) { return '[unavailable]'; } }

async function fetchJson(path, query = {}) {
  const url = new URL(path, ASTOCK_BASE_URL);
  Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
    if (!response.ok) return { success: false, status: response.status, error: `Upstream returned HTTP ${response.status}`, data, url: safeUrlString(url) };
    return data;
  } catch (err) {
    return { success: false, error: err && err.name === 'AbortError' ? 'Upstream request timeout' : String(err && err.message ? err.message : err), url: safeUrlString(url) };
  } finally { clearTimeout(timeout); }
}

async function callTool(name, args = {}) {
  const map = {
    get_health_check: ['/api/health-check', { full: args.full === true ? 'true' : undefined }],
    get_daily_review_bundle: ['/api/daily-review-bundle', { date: args.date, group: args.group, symbols: args.symbols, raw: args.raw === true ? 'true' : undefined, extra: args.extra === false ? 'false' : undefined }],
    get_stock_quote: ['/api/quote', { symbols: args.symbols, detail: args.detail === true ? 'true' : undefined }],
    get_market_overview: ['/api/market-overview', {}],
    get_limit_up_pool: ['/api/limit-up', { date: args.date }],
    get_broken_limit_pool: ['/api/broken-limit', { date: args.date }],
    get_limit_down_pool: ['/api/limit-down', { date: args.date }],
    get_lianban_ladder: ['/api/lianban-ladder', { date: args.date }],
    get_core_stock_watchlist: ['/api/watchlist', { group: args.group, symbols: args.symbols }],
    get_hot_sectors: ['/api/sector', {}],
    get_market_sentiment: ['/api/sentiment', {}],
    get_intraday_node_snapshot: ['/api/intraday-nodes', {}],
    get_intraday_timeline: ['/api/intraday-timeline', { date: args.date, token: process.env.CAPTURE_SECRET }],
    get_news_catalysts: ['/api/news-catalysts', {}],
    get_dragon_tiger_list: ['/api/dragon-tiger', { date: args.date }],
    get_stock_concepts: ['/api/stock-concepts', { symbols: args.symbols }],
    get_stock_popularity: ['/api/stock-popularity', { top: args.top, period: args.period, source: args.source, symbols: args.symbols }],
    get_stock_capital_flow: ['/api/stock-capital-flow', { symbols: args.symbols, range: args.range, dailyLimit: args.dailyLimit }],
    get_stock_news: ['/api/stock-news', { symbols: args.symbols, include: args.include, pageSize: args.pageSize }],
    get_stock_kline: ['/api/stock-kline', { symbols: args.symbols, frequency: args.frequency, count: args.count, source: args.source }],
    get_review_rules: ['/api/review-rules', { section: args.section }],
    get_concept_members: ['/api/concept-members', { bk: args.bk, keyword: args.keyword, kind: args.kind, limit: args.limit }],
    get_sector_money_flow: ['/api/sector-money-flow', { kind: args.kind, top: args.top, sort: args.sort }],
    get_limit_reason: ['/api/limit-reason', { date: args.date, symbols: args.symbols, top: args.top, includeNews: args.includeNews === true ? 'true' : undefined }],
    get_watchlist_auto_label: ['/api/watchlist-auto-label', { group: args.group, symbols: args.symbols, context: args.context, light: args.light === true ? 'true' : undefined }],
  };
  if (!map[name]) throw new Error(`Unknown tool: ${name}`);
  return fetchJson(map[name][0], map[name][1]);
}

async function handleRpc(message) {
  const { id, method, params } = message || {};
  if (!method) return rpcError(id, -32600, 'Invalid Request');
  if (id === undefined && method.startsWith('notifications/')) return null;
  if (method === 'initialize') return rpcResult(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools });
  if (method === 'tools/call') {
    try {
      const structuredContent = await callTool(params && params.name, (params && params.arguments) || {});
      return rpcResult(id, { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }] });
    } catch (err) { return rpcError(id, -32000, String(err && err.message ? err.message : err)); }
  }
  if (method === 'resources/list') return rpcResult(id, { resources: [] });
  if (method === 'prompts/list') return rpcResult(id, { prompts: [] });
  return rpcError(id, -32601, `Method not found: ${method}`);
}

module.exports = async (req, res) => {
  setCommonHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const pathname = requestPath(req);
  if (pathname !== PRIVATE_MCP_PATH && pathname !== '/api/mcp.js') return json(res, 404, { error: 'Not Found' });
  if (req.method === 'GET') {
    const accepts = req.headers.accept || '';
    if (accepts.includes('text/event-stream')) { res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); res.setHeader('Connection', 'keep-alive'); res.write(`event: endpoint\ndata: ${PRIVATE_MCP_PATH}\n\n`); return res.end(); }
    return json(res, 200, { name: SERVER_NAME, version: SERVER_VERSION, endpoint: PRIVATE_MCP_PATH, transport: 'streamable-http-json-rpc', tools: tools.map(t => ({ name: t.name, title: t.title, description: t.description })) });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  let body;
  try { body = await readBody(req); } catch (err) { return json(res, 400, rpcError(null, -32700, 'Parse error', String(err && err.message ? err.message : err))); }
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of messages) { const response = await handleRpc(message); if (response) responses.push(response); }
  if (responses.length === 0) return res.status(202).end();
  return json(res, 200, Array.isArray(body) ? responses : responses[0]);
};
