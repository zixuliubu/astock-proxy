const schema = {
  openapi: '3.1.0',
  info: {
    title: 'A股实时行情API中转服务',
    description: '获取A股实时行情、涨停池、热门板块和市场情绪数据。',
    version: '1.0.0',
  },
  servers: [
    { url: 'https://astock-proxy.vercel.app' },
  ],
  paths: {
    '/api/quote': {
      get: {
        operationId: 'getStockQuote',
        summary: '获取A股个股实时行情',
        description: '根据股票代码获取实时行情。支持 sh600519、sz000001，多个代码用英文逗号分隔。',
        parameters: [
          {
            name: 'symbols',
            in: 'query',
            required: true,
            description: '股票代码，例如 sh600519 或 sz000001，多个代码用英文逗号分隔。',
            schema: { type: 'string' },
          },
          {
            name: 'detail',
            in: 'query',
            required: false,
            description: '是否返回补充详情。',
            schema: { type: 'string', enum: ['true', 'false'] },
          },
        ],
        responses: {
          200: {
            description: '成功返回个股行情',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    count: { type: 'integer' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          source: { type: 'string' },
                          code: { type: 'string' },
                          name: { type: 'string' },
                          price: { type: 'number' },
                          prevClose: { type: 'number' },
                          open: { type: 'number' },
                          high: { type: 'number' },
                          low: { type: 'number' },
                          change: { type: 'number' },
                          changePct: { type: 'number' },
                          volume: { type: 'number' },
                          amount: { type: 'number' },
                          pe: { type: 'number' },
                          time: { type: 'string' },
                        },
                        additionalProperties: true,
                      },
                    },
                    sources: {
                      type: 'object',
                      properties: {
                        sina: { type: 'string' },
                        tencent: { type: 'string' },
                      },
                      additionalProperties: true,
                    },
                    latency: { type: 'integer' },
                    updateTime: { type: 'string' },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    },
    '/api/limit-up': {
      get: {
        operationId: 'getLimitUpPool',
        summary: '获取今日涨停池',
        description: '获取A股涨停池数据，用于整理涨停梯队、最高板、二板、三板和题材归因。',
        parameters: [
          {
            name: 'date',
            in: 'query',
            required: false,
            description: '日期，格式 YYYYMMDD，例如 20260708。不填默认今日。',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: '成功返回涨停池',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    xuangubao: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        data: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              code: { type: 'string' },
                              name: { type: 'string' },
                              continuousBoards: { type: 'integer' },
                              firstLimitUpTime: { type: 'string' },
                              industry: { type: 'string' },
                              reason: { type: 'string' },
                              isNew: { type: 'boolean' },
                              isST: { type: 'boolean' },
                            },
                            additionalProperties: true,
                          },
                        },
                      },
                      additionalProperties: true,
                    },
                    push2ex: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        data: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              code: { type: 'string' },
                              name: { type: 'string' },
                              price: { type: 'number' },
                              changePct: { type: 'number' },
                              turnover: { type: 'number' },
                              continuousBoards: { type: 'integer' },
                              industry: { type: 'string' },
                            },
                            additionalProperties: true,
                          },
                        },
                      },
                      additionalProperties: true,
                    },
                    eastmoney: {
                      type: 'object',
                      properties: {
                        count: { type: 'integer' },
                        data: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              code: { type: 'string' },
                              name: { type: 'string' },
                              price: { type: 'number' },
                              changePct: { type: 'number' },
                            },
                            additionalProperties: true,
                          },
                        },
                      },
                      additionalProperties: true,
                    },
                    updateTime: { type: 'string' },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    },
    '/api/sector': {
      get: {
        operationId: 'getHotSectors',
        summary: '获取热门板块',
        description: '获取热门板块数据，用于判断今日主线、板块强度和资金进攻方向。',
        responses: {
          200: {
            description: '成功返回热门板块',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    count: { type: 'integer' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          code: { type: 'string' },
                          name: { type: 'string' },
                          changePct: { type: 'number' },
                          price: { type: 'number' },
                        },
                        additionalProperties: true,
                      },
                    },
                    updateTime: { type: 'string' },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    },
    '/api/sentiment': {
      get: {
        operationId: 'getMarketSentiment',
        summary: '获取市场情绪数据',
        description: '获取涨停数、跌停数、炸板率、连板分布等市场情绪数据。',
        responses: {
          200: {
            description: '成功返回市场情绪',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    sentiment: {
                      type: 'object',
                      properties: {
                        rise: { type: 'integer' },
                        fall: { type: 'integer' },
                        limitUp: { type: 'integer' },
                        limitDown: { type: 'integer' },
                        brokenCount: { type: 'integer' },
                        brokenRatio: { type: 'number' },
                        label: { type: 'string' },
                      },
                      additionalProperties: true,
                    },
                    boardDistribution: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer' },
                        distribution: {
                          type: 'object',
                          properties: {
                            '1': { type: 'integer' },
                            '2': { type: 'integer' },
                            '3': { type: 'integer' },
                            '4': { type: 'integer' },
                            '5': { type: 'integer' },
                            '6': { type: 'integer' },
                            '7': { type: 'integer' },
                            '8': { type: 'integer' },
                            '9': { type: 'integer' },
                            '10+': { type: 'integer' },
                          },
                          additionalProperties: true,
                        },
                      },
                      additionalProperties: true,
                    },
                    updateTime: { type: 'string' },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    },
  },
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(200).json(schema);
};
