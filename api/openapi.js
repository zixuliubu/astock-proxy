const endpoints = [
  ['quote', 'getStockQuote', '获取A股个股实时行情', { symbols: '股票代码，多个逗号分隔', detail: 'true/false' }],
  ['market-overview', 'getMarketOverview', '获取大盘指数和两市成交额', {}],
  ['sentiment', 'getMarketSentiment', '获取市场情绪数据', {}],
  ['sector', 'getHotSectors', '获取热门板块', {}],
  ['limit-up', 'getLimitUpPool', '获取涨停池', { date: 'YYYYMMDD' }],
  ['broken-limit', 'getBrokenLimitPool', '获取炸板池', { date: 'YYYYMMDD' }],
  ['limit-down', 'getLimitDownPool', '获取跌停池', { date: 'YYYYMMDD' }],
  ['lianban-ladder', 'getLianbanLadder', '获取标准化连板梯队', { date: 'YYYYMMDD' }],
  ['watchlist', 'getCoreStockWatchlist', '获取核心观察池', { group: '观察池组', symbols: '股票代码，多个逗号分隔' }],
  ['dragon-tiger', 'getDragonTigerList', '获取龙虎榜列表', { date: 'YYYYMMDD' }],
  ['news-catalysts', 'getNewsCatalysts', '获取消息面催化线索', {}],
  ['intraday-nodes', 'getIntradayNodeSnapshot', '获取盘中节点快照', {}],
  ['capture-node', 'captureIntradayNode', '保存盘中节点快照', { node: '节点，如 09:35', date: 'YYYYMMDD', token: 'CAPTURE_SECRET' }],
  ['intraday-timeline', 'getIntradayTimeline', '获取已保存盘中节点时间线', { date: 'YYYYMMDD', token: 'CAPTURE_SECRET' }],
  ['daily-review-bundle', 'getDailyReviewBundle', '获取一键短线复盘增强包', { date: 'YYYYMMDD', group: '观察池组', symbols: '核心观察票', raw: 'true/false', extra: 'true/false' }],
  ['daily-review-bundle-base', 'getDailyReviewBundleBase', '获取一键短线复盘基础包', { date: 'YYYYMMDD', group: '观察池组', symbols: '核心观察票', raw: 'true/false' }],
  ['daily-review-plus', 'getDailyReviewPlus', '获取一键短线复盘增强包别名', { date: 'YYYYMMDD', group: '观察池组', symbols: '核心观察票', raw: 'true/false', extra: 'true/false' }],
  ['stock-concepts', 'getStockConcepts', '获取个股概念和板块归属', { symbols: '股票代码，多个逗号分隔' }],
  ['stock-popularity', 'getStockPopularity', '获取市场人气榜和个股热榜概念', { top: '返回前N名', period: 'hour/day', source: 'both/ths/eastmoney', symbols: '可选股票代码' }],
  ['stock-capital-flow', 'getStockCapitalFlow', '获取个股资金流摘要', { symbols: '股票代码，多个逗号分隔', range: 'minute/daily/both', dailyLimit: '日级天数' }],
  ['stock-news', 'getStockNews', '获取个股新闻和公告催化', { symbols: '股票代码，多个逗号分隔', include: 'all/news/announcements', pageSize: '每只数量' }],
  ['stock-kline', 'getStockKline', '获取A股K线行情备源', { symbols: '股票代码，多个逗号分隔', frequency: '1d/1w/1M/1m/5m/15m/30m/60m', count: 'K线条数', source: 'auto/sina/tencent' }],
  ['review-rules', 'getReviewRules', '获取短线复盘与交易规则模板', { section: 'all/principles/emotionCycle/strategyTemplates等' }],
  ['concept-members', 'getConceptMembers', '获取板块/概念成分股', { bk: '板块代码 BKxxxx', keyword: '板块关键词', kind: 'concept/industry/both', limit: '每板块数量' }],
  ['sector-money-flow', 'getSectorMoneyFlow', '获取板块资金流', { kind: 'concept/industry/both', top: '返回前N', sort: 'mainNet/changePct/amount' }],
  ['limit-reason', 'getLimitReason', '获取涨停原因归因增强', { date: 'YYYYMMDD', symbols: '可选股票代码', top: '返回前N', includeNews: 'true/false' }],
  ['watchlist-auto-label', 'getWatchlistAutoLabel', '观察池自动打标签', { group: '观察池组', symbols: '可选股票代码', context: 'pre/intraday/new', light: 'true/false' }],
  ['health-check', 'getHealthCheck', '获取服务健康检查', { full: 'true/false' }],
];

function paramObjects(params) {
  return Object.entries(params || {}).map(([name, description]) => ({
    name,
    in: 'query',
    required: false,
    description,
    schema: { type: 'string' },
  }));
}

function pathFor([name, operationId, summary, params]) {
  return {
    get: {
      operationId,
      summary,
      description: `${summary}。本服务为老大A股短线复盘系统的轻量 API / MCP 数据入口。`,
      parameters: paramObjects(params),
      responses: {
        200: {
          description: '成功返回 JSON 数据。不同接口字段不同，统一包含 success/updateTime/mode 等通用字段。',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  mode: { type: 'string' },
                  updateTime: { type: 'string' },
                  data: { type: ['array', 'object', 'null'], items: { type: 'object', additionalProperties: true }, additionalProperties: true },
                  count: { type: ['integer', 'object', 'null'], additionalProperties: true },
                  diagnostics: { type: 'object', additionalProperties: true },
                },
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
  };
}

const schema = {
  openapi: '3.1.0',
  info: {
    title: 'A股实时行情API中转服务',
    description: '老大A股短线复盘系统：行情、涨停池、炸板池、连板梯队、板块资金流、观察池标签、盘中节点、复盘增强包与 MCP 工具入口。',
    version: '1.7.0',
  },
  servers: [{ url: 'https://astock-proxy.vercel.app' }],
  paths: Object.fromEntries(endpoints.map(e => [`/api/${e[0]}`, pathFor(e)])),
  components: {
    schemas: {
      GenericResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          mode: { type: 'string' },
          updateTime: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
  },
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });
  return json(res, 200, schema);
};
