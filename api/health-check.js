const { json, setCors, okBase } = require('./_stock-utils');

const SERVER_VERSION = '1.7.5';
const ENDPOINTS = [
  'quote', 'market-overview', 'sentiment', 'sector',
  'limit-up', 'broken-limit', 'limit-down', 'lianban-ladder',
  'watchlist', 'dragon-tiger', 'dragon-tiger-detail', 'dragon-tiger-seat-radar', 'dragon-tiger-debug', 'news-catalysts',
  'intraday-nodes', 'capture-node', 'intraday-timeline',
  'daily-review-bundle', 'daily-review-bundle-base', 'daily-review-plus',
  'stock-concepts', 'stock-popularity', 'stock-capital-flow', 'stock-news', 'stock-kline',
  'review-rules', 'concept-members', 'sector-money-flow', 'limit-reason', 'watchlist-auto-label',
  'orderbook-lite', 'watchlist-orderbook',
  'openapi', 'health-check',
];

function publicChecks() {
  return {
    server: 'astock-proxy',
    serverVersion: SERVER_VERSION,
    mcpPath: '/mcp-laoda-20260708-x7k29q',
    endpoints: ENDPOINTS,
    endpointCount: ENDPOINTS.length,
    deploymentModel: 'vercel-router-single-function',
    redisWrites: {
      captureNode: 'yes, only when capture-node is called with CAPTURE_SECRET',
      normalReadApis: 'no',
      orderbookLite: 'no, in-memory short cache only',
      watchlistOrderbook: 'no, delegates to orderbook-lite and uses in-memory short cache only',
      dragonTigerSeat: 'no, on-demand only with short cache',
      dragonTigerDebug: 'no, diagnostic read-only endpoint with short cache',
    },
    capacityPolicy: {
      defaultSampling: '10-minute intraday nodes via GitHub Actions',
      heavyModules: 'not deployed on Vercel; keep for Cloudflare/VPS later',
      fourthBatchDefault: 'only watchlist-auto-label enters daily-review-bundle; concept-members/sector-money-flow/limit-reason are on-demand',
      orderbookLite: 'on-demand only; max 8 symbols; default 5s cache; not Level-2; not all-market scan',
      watchlistOrderbook: 'on-demand observation-pool aggregation; max 8 symbols; not included in daily-review-bundle by default',
      dragonTigerSeat: 'on-demand after-hours analysis; seat tags are rules-based and not official identity confirmation',
      dragonTigerDebug: 'on-demand diagnostic endpoint; separates not_on_list, summary_candidate_only, seat_candidate_found, listed_detail_missing, fetch_error; v3 adds TRADE_ID drill-down filters',
    },
    envPresence: {
      CAPTURE_SECRET: Boolean(process.env.CAPTURE_SECRET),
      UPSTASH_REDIS_REST_URL: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      UPSTASH_REDIS_REST_TOKEN: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
      ASTOCK_BASE_URL: Boolean(process.env.ASTOCK_BASE_URL),
    },
    secretSafety: 'secret values are never returned',
  };
}

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });
  return json(res, 200, okBase({ mode: 'health_check_v1', ...publicChecks() }));
};
