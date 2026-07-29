const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRADING_NODES,
  normalizeNode,
  summarizeCumulativeFlow,
  selectDragonTigerSeats,
  summarizeDragonTigerSeats,
  compactReviewSector,
  timelineCoverage,
  validateDragonTigerRows,
  validateMarketOverview,
  validateReviewMinimum,
  validateSectorRows,
} = require('../api/_data-contracts');

const wan = value => value === null || value === undefined ? null : Number((value / 10000).toFixed(2));
const yi = value => value === null || value === undefined ? null : Number((value / 100000000).toFixed(3));

test('minute capital-flow summary uses the final cumulative point exactly once', () => {
  const rows = [
    { time: '09:31', mainNetYuan: 100000000, largeNetYuan: 40000000, superNetYuan: 60000000 },
    { time: '09:32', mainNetYuan: 120000000, largeNetYuan: 50000000, superNetYuan: 70000000 },
  ];
  const summary = summarizeCumulativeFlow(rows, wan, yi);
  assert.equal(summary.aggregation, 'latest_cumulative_point');
  assert.equal(summary.totalMainYi, 1.2);
  assert.equal(summary.totalLargeWan, 5000);
  assert.equal(summary.totalSuperWan, 7000);
});

test('market overview rejects empty indices and zero turnover', () => {
  assert.equal(validateMarketOverview([], 0).status, 'DATA_INSUFFICIENT');
  const indices = [
    { code: '000001', name: '上证指数', price: 3800, changePct: 0.5 },
    { code: '399001', name: '深证成指', price: 13000, changePct: 0.6 },
    { code: '399006', name: '创业板指', price: 3200, changePct: 0.7 },
  ];
  assert.equal(validateMarketOverview(indices, 15000).success, true);
});

test('sector rows cannot masquerade as success when market fields are absent', () => {
  const bad = [{ bk: 'BK0001', name: '半导体', changePct: 0, amountYi: null, mainNetYi: null }];
  assert.equal(validateSectorRows(bad).status, 'DATA_INSUFFICIENT');
  const good = [{ bk: 'BK0001', name: '半导体', changePct: 1.2, amountYi: 830, mainNetYi: 12.3 }];
  assert.equal(validateSectorRows(good).success, true);
});

test('timeline ignores invalid UTC labels, reports missing scheduled nodes, and de-duplicates', () => {
  assert.equal(normalizeNode('04:42'), null);
  assert.ok(TRADING_NODES.includes('09:15'));
  const now = new Date('2026-07-28T03:30:00Z'); // 11:30 China
  const coverage = timelineCoverage([
    { node: '04:42' },
    { node: '09:15', capturedAt: 'a' },
    { node: '09:15', capturedAt: 'b' },
    { node: '09:35' },
  ], '20260728', now);
  assert.deepEqual(coverage.invalidStoredNodes, ['04:42']);
  assert.deepEqual(coverage.overwrittenNodes, ['09:15']);
  assert.ok(coverage.missingNodes.includes('09:20'));
  assert.equal(coverage.sorted.find(x => x.node === '09:15').capturedAt, 'b');
});

test('dragon-tiger list rejects missing deal amounts but accepts verified one-sided rows', () => {
  assert.equal(validateDragonTigerRows([
    { code: '001258', name: '立新能源', buyAmount: 0, sellAmount: 0, amount: 0 },
  ]).status, 'DATA_INSUFFICIENT');
  assert.equal(validateDragonTigerRows([
    { code: '603297', name: '永新光学', buyAmount: 99230326, sellAmount: 0, amount: 99230326 },
  ]).success, true);
});

test('daily review bundle propagates a critical component failure', () => {
  const bundle = {
    marketOverview: {
      success: true,
      overview: { turnoverYi: 10000 },
      indices: [
        { code: '000001', name: '上证指数', price: 3500, changePct: 0.2 },
        { code: '399001', name: '深证成指', price: 11000, changePct: -0.1 },
        { code: '399006', name: '创业板指', price: 2300, changePct: 0.3 },
      ],
    },
    marketSentiment: { success: true },
    lianbanLadder: { success: true },
    limitUpPool: { success: true },
    brokenLimitPool: { success: true },
    limitDownPool: { success: true },
    hotSectors: { success: false, top: [] },
    dragonTiger: { success: true },
    intradayTimeline: { success: true },
  };
  assert.deepEqual(validateReviewMinimum(bundle), {
    success: false,
    status: 'DATA_INSUFFICIENT',
    criticalFailures: ['hotSectors'],
  });
});

test('dragon-tiger detail selects one trade id and does not double count buy/sell reports', () => {
  const selected = selectDragonTigerSeats(
    [
      { tradeId: 'A', buyAmount: 100 },
      { tradeId: 'B', buyAmount: 200 },
    ],
    [
      { tradeId: 'A', sellAmount: 60 },
      { tradeId: 'B', sellAmount: 80 },
    ],
    'A',
  );
  const summary = summarizeDragonTigerSeats(selected.buySeats, selected.sellSeats, yi, {
    buyAmount: 120,
    sellAmount: 75,
    netAmount: 45,
  });
  assert.equal(summary.buyTotal, 120);
  assert.equal(summary.sellTotal, 75);
  assert.equal(summary.netTotal, 45);
  assert.equal(summary.seatTop5BuyTotal, 100);
  assert.equal(summary.seatTop5SellTotal, 60);
  assert.equal(summary.buySeatCount, 1);
  assert.equal(summary.sellSeatCount, 1);
  assert.equal(summary.reconciliationStatus, 'PARTIAL');
  assert.equal(summary.aggregation, 'authoritative_list_row_totals_with_selected_trade_id_top5_breakdown');
});

test('daily review sector compaction uses normalized fields without undefined identifiers', () => {
  const compact = compactReviewSector({
    name: '食品饮料',
    changePct: 2.5,
    amountYi: 85.2,
    mainNetYi: 4.2,
  });
  assert.equal(compact.name, '食品饮料');
  assert.equal(compact.changePct, 2.5);
  assert.equal(compact.amount, 85.2);
  assert.equal(compact.mainNetYi, 4.2);
});
