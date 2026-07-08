const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';
const SERVER_NAME = 'astock-mcp';
const SERVER_VERSION = '1.4.0';
const PRIVATE_MCP_PATH = '/mcp-laoda-20260708-x7k29q';

function emptyInputSchema() {
  return { type: 'object', properties: {}, required: [], additionalProperties: false };
}

function dateInputSchema() {
  return {
    type: 'object',
    properties: {
      date: { type: 'string', description: '日期，格式 YYYYMMDD，例如 20260708。不填默认今日。' },
    },
    required: [],
    additionalProperties: false,
  };
}

function genericObjectOutputSchema(extraProperties = {}) {
  return {
    type: 'object',
    properties: { success: { type: 'boolean' }, updateTime: { type: 'string' }, ...extraProperties },
    additionalProperties: true,
  };
}

const tools = [
  {
    name: 'get_daily_review_bundle',
    title: '获取一键短线复盘聚合包',
    description: '一键聚合今日短线复盘所需数据：大盘指数和成交额、情绪、涨停池、炸板池、跌停池、连板梯队、热门板块、核心观察票、消息催化、龙虎榜、盘中节点时间线。适用于用户说“复盘今天”“开搞”“今天盘面怎么变化”。优先使用此工具，避免一次复盘调用过多工具导致变慢。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期，格式 YYYYMMDD，例如 20260708。不填默认今日。' },
        group: { type: 'string', description: '观察池预设组：default、semiconductor、robot、ai_compute、innovation_drug、fluorochemical、paper、market_core。默认 default。' },
        symbols: { type: 'string', description: '自定义观察股票代码，多个用英文逗号分隔，例如 sh600584,sz002185,sz002407。传 symbols 时优先使用自定义列表。' },
        raw: { type: 'boolean', description: '是否返回原始完整数据。默认 false；复盘时建议 false，速度更快、上下文更省。' },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: genericObjectOutputSchema({
      date: { type: 'string' },
      mode: { type: 'string' },
      cached: { type: 'boolean' },
      marketOverview: { type: 'object', additionalProperties: true },
      marketSentiment: { type: 'object', additionalProperties: true },
      lianbanLadder: { type: 'object', additionalProperties: true },
      limitUpPool: { type: 'object', additionalProperties: true },
      brokenLimitPool: { type: 'object', additionalProperties: true },
      limitDownPool: { type: 'object', additionalProperties: true },
      hotSectors: { type: 'object', additionalProperties: true },
      coreWatchlist: { type: 'object', additionalProperties: true },
      newsCatalysts: { type: 'object', additionalProperties: true },
      dragonTiger: { type: 'object', additionalProperties: true },
      intradayTimeline: { type: 'object', additionalProperties: true },
      reviewHints: { type: 'array', items: { type: 'string' } },
      diagnostics: { type: 'object', additionalProperties: true },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_stock_quote',
    title: '获取A股个股实时行情',
    description: '查询A股个股实时行情。适用于用户询问某只股票当前价格、涨跌幅、成交额、开高低、贵州茅台/长电科技等个股行情。支持 sh600519、sz000001，多个代码用英文逗号分隔。',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'string', description: '股票代码，多个代码用英文逗号分隔，例如 sh600519,sz000001。' },
        detail: { type: 'boolean', description: '是否返回补充详情，默认 false。' },
      },
      required: ['symbols'],
      additionalProperties: false,
    },
    outputSchema: genericObjectOutputSchema({ count: { type: 'integer' }, data: { type: 'array', items: { type: 'object', additionalProperties: true } } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_market_overview',
    title: '获取大盘指数和两市成交额',
    description: '查询上证、深证、创业板、沪深300、中证500、中证1000等指数表现，并给出两市成交额近似值、涨跌家数和市场总览标签。适用于复盘第一步判断指数环境和成交额。',
    inputSchema: emptyInputSchema(),
    outputSchema: genericObjectOutputSchema({ overview: { type: 'object', additionalProperties: true }, indices: { type: 'array', items: { type: 'object', additionalProperties: true } }, sentiment: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_limit_up_pool',
    title: '获取今日涨停池',
    description: '查询A股涨停池、连板数据、最高板、二板、三板、首板、题材归因。适用于用户询问今天涨停池、涨停梯队、有哪些二板、最高板是谁。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({ xuangubao: { type: 'object', additionalProperties: true }, push2ex: { type: 'object', additionalProperties: true }, eastmoney: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_broken_limit_pool',
    title: '获取今日炸板池',
    description: '查询A股炸板池、炸板个股、炸板数量、炸板题材和炸板时间。适用于用户询问今天炸板池有哪些、哪个方向炸板多、封板质量差不差、亏钱效应是否扩散。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({ xuangubao: { type: 'object', additionalProperties: true }, push2ex: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_limit_down_pool',
    title: '获取今日跌停池',
    description: '查询A股跌停池、跌停个股、连续跌停、跌停时间和风险方向。适用于用户询问今天跌停池有哪些、亏钱效应在哪里、高标是否出现负反馈。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({ xuangubao: { type: 'object', additionalProperties: true }, push2ex: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_lianban_ladder',
    title: '获取标准化连板梯队',
    description: '返回标准化连板梯队，按最高板、三板、二板、首板、连板分布整理。适用于用户要求按最高板/三板/二板/首板输出，或要求直接查看连板梯队。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({ sourcePriority: { type: 'array', items: { type: 'string' } }, ladder: { type: 'object', additionalProperties: true }, raw: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_core_stock_watchlist',
    title: '获取板块核心大票和观察池状态',
    description: '查询板块核心大票或自定义观察票的成交额、涨跌幅、分时位置和承接强弱。适用于长电科技、华天科技、多氟多、宜宾纸业等观察池，也适用于半导体、机器人、算力、创新药等板块核心大票承接分析。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '预设观察组：default、semiconductor、robot、ai_compute、innovation_drug、fluorochemical、paper、market_core。' },
        symbols: { type: 'string', description: '自定义股票代码，多个用英文逗号分隔，例如 sh600584,sz002185,sz002407。传 symbols 时优先使用自定义列表。' },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: genericObjectOutputSchema({ group: { type: 'string' }, count: { type: 'integer' }, data: { type: 'array', items: { type: 'object', additionalProperties: true } }, summary: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_hot_sectors',
    title: '获取A股热门板块',
    description: '查询A股热门板块、板块涨幅、板块强度，用于判断今日主线、次主线和资金进攻方向。适用于用户询问今天最强板块、主线是否切换到算力/机器人/创新药等。',
    inputSchema: emptyInputSchema(),
    outputSchema: genericObjectOutputSchema({ count: { type: 'integer' }, data: { type: 'array', items: { type: 'object', additionalProperties: true } } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_market_sentiment',
    title: '获取A股市场情绪',
    description: '查询A股市场情绪数据，包括涨停数、跌停数、炸板率、连板分布等。适用于用户询问今天情绪强弱、涨停跌停结构、炸板情况、市场是否退潮或修复。',
    inputSchema: emptyInputSchema(),
    outputSchema: genericObjectOutputSchema({ sentiment: { type: 'object', additionalProperties: true }, boardDistribution: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_intraday_node_snapshot',
    title: '获取盘中节点快照',
    description: '获取当前时刻所属盘中节点、下一节点、指数/情绪/连板/板块快照。适用于9:35、10:35、11:35、13:35、14:35节点跟踪。当前版本是无存储即时快照。',
    inputSchema: emptyInputSchema(),
    outputSchema: genericObjectOutputSchema({ mode: { type: 'string' }, chinaTime: { type: 'string' }, currentNode: { type: 'string' }, nextNode: { type: 'string' }, snapshot: { type: 'object', additionalProperties: true }, brief: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_intraday_timeline',
    title: '获取已保存的盘中节点变化时间线',
    description: '读取数据库中已保存的9:35、10:35、11:35、13:35、14:35、15:00节点快照，并输出节点变化、涨停变化、炸板变化、成交额变化、连板高度变化。适用于用户询问今天盘面是怎么一步步变化的。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({ date: { type: 'string' }, count: { type: 'integer' }, nodes: { type: 'array', items: { type: 'string' } }, changes: { type: 'array', items: { type: 'object', additionalProperties: true } }, conclusion: { type: 'string' } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_news_catalysts',
    title: '获取消息面催化线索',
    description: '获取盘中/盘后财经快讯和题材催化线索，用于解释板块异动、消息发酵和次日预案。消息源只做催化验证，不作为硬盘口主源。',
    inputSchema: emptyInputSchema(),
    outputSchema: genericObjectOutputSchema({ count: { type: 'integer' }, data: { type: 'array', items: { type: 'object', additionalProperties: true } }, sourceStatus: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_dragon_tiger_list',
    title: '获取龙虎榜列表',
    description: '获取东方财富龙虎榜列表，包括上榜原因、净买额、买入额、卖出额。适用于盘后复盘游资/机构参与方向。席位级明细后续再加。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({ count: { type: 'integer' }, data: { type: 'array', items: { type: 'object', additionalProperties: true } }, summary: { type: 'object', additionalProperties: true } }),
    annotations: { readOnlyHint: true },
  },
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Cache-Control', 'no-store');
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }; }

function requestPath(req) {
  try { return new URL(req.url || PRIVATE_MCP_PATH, 'https://astock-proxy.vercel.app').pathname; }
  catch (err) { return PRIVATE_MCP_PATH; }
}

function safeUrlString(url) {
  try {
    const safe = new URL(url.toString());
    if (safe.searchParams.has('token')) safe.searchParams.set('token', '[redacted]');
    return safe.toString();
  } catch (err) {
    return '[unavailable]';
  }
}

async function fetchJson(path, query = {}) {
  const url = new URL(path, ASTOCK_BASE_URL);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
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
  } finally {
    clearTimeout(timeout);
  }
}

async function callTool(name, args = {}) {
  if (name === 'get_daily_review_bundle') return fetchJson('/api/daily-review-bundle', { date: args.date, group: args.group, symbols: args.symbols, raw: args.raw === true ? 'true' : undefined });
  if (name === 'get_stock_quote') return fetchJson('/api/quote', { symbols: args.symbols, detail: args.detail === true ? 'true' : undefined });
  if (name === 'get_market_overview') return fetchJson('/api/market-overview');
  if (name === 'get_limit_up_pool') return fetchJson('/api/limit-up', { date: args.date });
  if (name === 'get_broken_limit_pool') return fetchJson('/api/broken-limit', { date: args.date });
  if (name === 'get_limit_down_pool') return fetchJson('/api/limit-down', { date: args.date });
  if (name === 'get_lianban_ladder') return fetchJson('/api/lianban-ladder', { date: args.date });
  if (name === 'get_core_stock_watchlist') return fetchJson('/api/watchlist', { group: args.group, symbols: args.symbols });
  if (name === 'get_hot_sectors') return fetchJson('/api/sector');
  if (name === 'get_market_sentiment') return fetchJson('/api/sentiment');
  if (name === 'get_intraday_node_snapshot') return fetchJson('/api/intraday-nodes');
  if (name === 'get_intraday_timeline') return fetchJson('/api/intraday-timeline', { date: args.date, token: process.env.CAPTURE_SECRET });
  if (name === 'get_news_catalysts') return fetchJson('/api/news-catalysts');
  if (name === 'get_dragon_tiger_list') return fetchJson('/api/dragon-tiger', { date: args.date });
  throw new Error(`Unknown tool: ${name}`);
}

async function handleRpc(message) {
  const { id, method, params } = message || {};
  if (!method) return rpcError(id, -32600, 'Invalid Request');
  if (id === undefined && method.startsWith('notifications/')) return null;
  if (method === 'initialize') return rpcResult(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools });
  if (method === 'tools/call') {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const structuredContent = await callTool(toolName, args);
      return rpcResult(id, { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }] });
    } catch (err) {
      return rpcError(id, -32000, String(err && err.message ? err.message : err));
    }
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
    if (accepts.includes('text/event-stream')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Connection', 'keep-alive');
      res.write(`event: endpoint\ndata: ${PRIVATE_MCP_PATH}\n\n`);
      return res.end();
    }
    return json(res, 200, { name: SERVER_NAME, version: SERVER_VERSION, endpoint: PRIVATE_MCP_PATH, transport: 'streamable-http-json-rpc', tools: tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description })) });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  let body;
  try { body = await readBody(req); }
  catch (err) { return json(res, 400, rpcError(null, -32700, 'Parse error', String(err && err.message ? err.message : err))); }
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of messages) {
    // eslint-disable-next-line no-await-in-loop
    const response = await handleRpc(message);
    if (response) responses.push(response);
  }
  if (responses.length === 0) return res.status(202).end();
  return json(res, 200, Array.isArray(body) ? responses : responses[0]);
};
