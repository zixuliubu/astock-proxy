const test = require('node:test');
const assert = require('node:assert/strict');
const limitUp = require('../api/limit-up');
const limitReason = require('../api/limit-reason');

test('push2ex limit-up normalizer preserves Eastmoney c stock code', () => {
  const row = limitUp.normalizePush2exLimitUp({ c: '002428', n: '云南锗业', p: 26920, zdp: 10, lbc: 1, fbt: 93000, hybk: '小金属', zttj: { days: 1, ct: 1 } });
  assert.equal(row.code, '002428');
  assert.equal(row.name, '云南锗业');
  assert.equal(row.price, 26.92);
  assert.equal(row.continuousBoards, 1);
  assert.equal(row.industry, '小金属');
});

test('limit reason selector falls back to non-empty push2ex rows when XGB is empty', () => {
  const selected = limitReason.selectPoolItems({ xuangubao: { count: 0, data: [] }, push2ex: { count: 79, data: [{ code: '600206', name: '有研新材' }] } });
  assert.equal(selected.source, 'push2ex');
  assert.equal(selected.items.length, 1);
  assert.equal(selected.sourceCounts.push2ex, 1);
});

test('industry and concept labels are context only, not daily limit-up reasons', () => {
  const [row] = limitReason.buildReasonRows([{ code: '688549', name: '中巨芯', industry: '电子化学品', reason: '' }], { '688549': { conceptTags: ['光刻胶', '半导体材料'] } });
  assert.equal(row.reason, '原因待确认');
  assert.equal(row.reasonStatus, 'pending_confirmation');
  assert.equal(row.theme, '原因待确认');
  assert.deepEqual(row.evidence.map(item => item.kind), ['context_only', 'context_only']);
});

test('non-empty limit pool with zero reason rows reports data anomaly', () => {
  const anomaly = limitReason.detectDataAnomaly(79, 0);
  assert.equal(anomaly.level, 'DATA_ANOMALY');
  assert.equal(anomaly.code, 'LIMIT_REASON_EMPTY_WITH_NONEMPTY_POOL');
});
