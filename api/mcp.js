const ASTOCK_BASE_URL = process.env.ASTOCK_BASE_URL || 'https://astock-proxy.vercel.app';
const SERVER_NAME = 'astock-mcp';
const SERVER_VERSION = '1.1.0';
const PRIVATE_MCP_PATH = '/mcp-laoda-20260708-x7k29q';

function dateInputSchema() {
  return {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: '日期，格式 YYYYMMDD，例如 20260708。不填默认今日。',
      },
    },
    required: [],
    additionalProperties: false,
  };
}

function genericObjectOutputSchema(extraProperties = {}) {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      updateTime: { type: 'string' },
      ...extraProperties,
    },
    additionalProperties: true,
  };
}

const tools = [
  {
    name: 'get_stock_quote',
    title: '获取A股个股实时行情',
    description: '查询A股个股实时行情。适用于用户询问某只股票当前价格、涨跌幅、成交额、开高低、贵州茅台/长电科技等个股行情。支持 sh600519、sz000001，多个代码用英文逗号分隔。',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'string',
          description: '股票代码，多个代码用英文逗号分隔，例如 sh600519,sz000001。',
        },
        detail: {
          type: 'boolean',
          description: '是否返回补充详情，默认 false。',
        },
      },
      required: ['symbols'],
      additionalProperties: false,
    },
    outputSchema: genericObjectOutputSchema({
      count: { type: 'integer' },
      data: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_limit_up_pool',
    title: '获取今日涨停池',
    description: '查询A股涨停池、连板数据、最高板、二板、三板、首板、题材归因。适用于用户询问今天涨停池、涨停梯队、有哪些二板、最高板是谁。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({
      xuangubao: { type: 'object', additionalProperties: true },
      push2ex: { type: 'object', additionalProperties: true },
      eastmoney: { type: 'object', additionalProperties: true },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_broken_limit_pool',
    title: '获取今日炸板池',
    description: '查询A股炸板池、炸板个股、炸板数量、炸板题材和炸板时间。适用于用户询问今天炸板池有哪些、哪个方向炸板多、封板质量差不差、亏钱效应是否扩散。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({
      xuangubao: { type: 'object', additionalProperties: true },
      push2ex: { type: 'object', additionalProperties: true },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_limit_down_pool',
    title: '获取今日跌停池',
    description: '查询A股跌停池、跌停个股、连续跌停、跌停时间和风险方向。适用于用户询问今天跌停池有哪些、亏钱效应在哪里、高标是否出现负反馈。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({
      xuangubao: { type: 'object', additionalProperties: true },
      push2ex: { type: 'object', additionalProperties: true },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_lianban_ladder',
    title: '获取标准化连板梯队',
    description: '返回标准化连板梯队，按最高板、三板、二板、首板、连板分布整理。适用于用户要求按最高板/三板/二板/首板输出，或要求直接查看连板梯队。',
    inputSchema: dateInputSchema(),
    outputSchema: genericObjectOutputSchema({
      sourcePriority: { type: 'array', items: { type: 'string' } },
      ladder: { type: 'object', additionalProperties: true },
      raw: { type: 'object', additionalProperties: true },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_hot_sectors',
    title: '获取A股热门板块',
    description: '查询A股热门板块、板块涨幅、板块强度，用于判断今日主线、次主线和资金进攻方向。适用于用户询问今天最强板块、主线是否切换到算力/机器人/创新药等。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: genericObjectOutputSchema({
      count: { type: 'integer' },
      data: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_market_sentiment',
    title: '获取A股市场情绪',
    description: '查询A股市场情绪数据，包括涨停数、跌停数、炸板率、连板分布等。适用于用户询问今天情绪强弱、涨停跌停结构、炸板情况、市场是否退潮或修复。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: genericObjectOutputSchema({
      sentiment: { type: 'object', additionalProperties: true },
      boardDistribution: { type: 'object', additionalProperties: true },
    }),
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

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function requestPath(req) {
  try {
    return new URL(req.url || PRIVATE_MCP_PATH, 'https://astock-proxy.vercel.app').pathname;
  } catch (err) {
    return PRIVATE_MCP_PATH;
  }
}

async function fetchJson(path, query = {}) {
  const url = new URL(path, ASTOCK_BASE_URL);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = { raw: text };
    }
    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        error: `Upstream returned HTTP ${response.status}`,
        data,
        url: url.toString(),
      };
    }
    return data;
  } catch (err) {
    return {
      success: false,
      error: err && err.name === 'AbortError' ? 'Upstream request timeout' : String(err && err.message ? err.message : err),
      url: url.toString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callTool(name, args = {}) {
  if (name === 'get_stock_quote') {
    return fetchJson('/api/quote', {
      symbols: args.symbols,
      detail: args.detail === true ? 'true' : undefined,
    });
  }

  if (name === 'get_limit_up_pool') {
    return fetchJson('/api/limit-up', { date: args.date });
  }

  if (name === 'get_broken_limit_pool') {
    return fetchJson('/api/broken-limit', { date: args.date });
  }

  if (name === 'get_limit_down_pool') {
    return fetchJson('/api/limit-down', { date: args.date });
  }

  if (name === 'get_lianban_ladder') {
    return fetchJson('/api/lianban-ladder', { date: args.date });
  }

  if (name === 'get_hot_sectors') {
    return fetchJson('/api/sector');
  }

  if (name === 'get_market_sentiment') {
    return fetchJson('/api/sentiment');
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleRpc(message) {
  const { id, method, params } = message || {};

  if (!method) return rpcError(id, -32600, 'Invalid Request');

  if (id === undefined && method.startsWith('notifications/')) return null;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools });
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const structuredContent = await callTool(toolName, args);
      return rpcResult(id, {
        structuredContent,
        content: [
          {
            type: 'text',
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
      });
    } catch (err) {
      return rpcError(id, -32000, String(err && err.message ? err.message : err));
    }
  }

  if (method === 'resources/list') {
    return rpcResult(id, { resources: [] });
  }

  if (method === 'prompts/list') {
    return rpcResult(id, { prompts: [] });
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

module.exports = async (req, res) => {
  setCommonHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  const pathname = requestPath(req);
  if (pathname !== PRIVATE_MCP_PATH && pathname !== '/api/mcp.js') {
    return json(res, 404, { error: 'Not Found' });
  }

  if (req.method === 'GET') {
    const accepts = req.headers.accept || '';
    if (accepts.includes('text/event-stream')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Connection', 'keep-alive');
      res.write(`event: endpoint\ndata: ${PRIVATE_MCP_PATH}\n\n`);
      return res.end();
    }

    return json(res, 200, {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      endpoint: PRIVATE_MCP_PATH,
      transport: 'streamable-http-json-rpc',
      tools: tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description })),
    });
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, rpcError(null, -32700, 'Parse error', String(err && err.message ? err.message : err)));
  }

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
