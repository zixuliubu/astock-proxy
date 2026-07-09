const handlers = {
  quote: () => require('./quote'),
  'limit-up': () => require('./limit-up'),
  'broken-limit': () => require('./broken-limit'),
  'limit-down': () => require('./limit-down'),
  'lianban-ladder': () => require('./lianban-ladder'),
  sector: () => require('./sector'),
  sentiment: () => require('./sentiment'),
  'market-overview': () => require('./market-overview'),
  watchlist: () => require('./watchlist'),
  'dragon-tiger': () => require('./dragon-tiger'),
  'dragon-tiger-detail': () => require('./dragon-tiger-detail'),
  'dragon-tiger-seat-radar': () => require('./dragon-tiger-seat-radar'),
  'news-catalysts': () => require('./news-catalysts'),
  'intraday-nodes': () => require('./intraday-nodes'),
  'capture-node': () => require('./capture-node'),
  'intraday-timeline': () => require('./intraday-timeline'),
  'daily-review-bundle': () => require('./daily-review-plus'),
  'daily-review-bundle-base': () => require('./daily-review-bundle'),
  'daily-review-plus': () => require('./daily-review-plus'),
  'stock-concepts': () => require('./stock-concepts'),
  'stock-popularity': () => require('./stock-popularity'),
  'stock-capital-flow': () => require('./stock-capital-flow'),
  'stock-news': () => require('./stock-news'),
  'stock-kline': () => require('./stock-kline'),
  'review-rules': () => require('./review-rules'),
  'concept-members': () => require('./concept-members'),
  'sector-money-flow': () => require('./sector-money-flow'),
  'limit-reason': () => require('./limit-reason'),
  'watchlist-auto-label': () => require('./watchlist-auto-label'),
  'orderbook-lite': () => require('./orderbook-lite'),
  'watchlist-orderbook': () => require('./watchlist-orderbook'),
  'health-check': () => require('./health-check'),
  openapi: () => require('./openapi'),
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-capture-token');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const endpoint = String(req.query.endpoint || '').replace(/^\/+|\/+$/g, '').replace(/\.js$/i, '');
  if (!endpoint || endpoint === 'router') {
    return json(res, 404, { success: false, error: 'Missing API endpoint' });
  }

  const loader = handlers[endpoint];
  if (!loader) {
    return json(res, 404, { success: false, error: `Unknown API endpoint: ${endpoint}` });
  }

  try {
    return await loader()(req, res);
  } catch (err) {
    return json(res, 500, { success: false, endpoint, error: String(err && err.message ? err.message : err) });
  }
};
