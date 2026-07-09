// 龙虎榜席位标签库
// 注意：除“机构专用、沪股通/深股通”等官方可见名称外，游资识别均为基于营业部历史活跃特征的“疑似标签”，不是官方身份确认。

const RULES = [
  {
    id: 'institution',
    pattern: /机构专用/,
    tags: ['机构席位'],
    style: '机构',
    confidence: 0.95,
    official: true,
  },
  {
    id: 'northbound',
    pattern: /沪股通|深股通|港股通/,
    tags: ['陆股通', '外资通道'],
    style: '外资通道',
    confidence: 0.9,
    official: true,
  },
  {
    id: 'lhasa',
    pattern: /东方财富证券.*拉萨|拉萨.*团结路|拉萨.*东环路|拉萨.*金融城|拉萨.*江苏大道|拉萨/,
    tags: ['拉萨系', '散户集中席位'],
    style: '散户合力',
    confidence: 0.85,
    official: false,
  },
  {
    id: 'quant_headquarter',
    pattern: /量化|总部|金融科技|程序化|算法|上海分公司|深圳分公司|北京分公司/,
    tags: ['疑似量化或总部席位'],
    style: '量化/总部席位',
    confidence: 0.45,
    official: false,
  },
  {
    id: 'active_hot_money_generic',
    pattern: /营业部|证券股份有限公司|证券有限公司/,
    tags: ['营业部席位'],
    style: '营业部资金',
    confidence: 0.35,
    official: false,
  },
  {
    id: 'shaoxing_active',
    pattern: /中国银河证券.*绍兴|绍兴/,
    tags: ['疑似活跃游资席位', '历史活跃席位'],
    style: '疑似游资',
    confidence: 0.55,
    official: false,
  },
  {
    id: 'jiangsu_road_active',
    pattern: /国泰君安证券.*上海江苏路|上海江苏路/,
    tags: ['疑似活跃游资席位', '历史活跃席位'],
    style: '疑似游资',
    confidence: 0.5,
    official: false,
  },
  {
    id: 'taiping_south_active',
    pattern: /南京太平南路|太平南路/,
    tags: ['疑似活跃游资席位', '历史活跃席位'],
    style: '疑似游资',
    confidence: 0.5,
    official: false,
  },
  {
    id: 'liyuan_road_active',
    pattern: /上海溧阳路|溧阳路/,
    tags: ['疑似活跃游资席位', '历史活跃席位'],
    style: '疑似游资',
    confidence: 0.5,
    official: false,
  },
  {
    id: 'wanping_south_active',
    pattern: /上海宛平南路|宛平南路/,
    tags: ['疑似活跃游资席位', '历史活跃席位'],
    style: '疑似游资',
    confidence: 0.45,
    official: false,
  },
];

function tagSeat(seatName) {
  const name = String(seatName || '').trim();
  const hits = [];
  for (const rule of RULES) {
    if (rule.pattern.test(name)) hits.push({
      id: rule.id,
      tags: rule.tags,
      style: rule.style,
      confidence: rule.confidence,
      official: rule.official,
    });
  }
  const mergedTags = [...new Set(hits.flatMap(x => x.tags))];
  const top = hits.sort((a, b) => b.confidence - a.confidence)[0] || null;
  return {
    seatName: name,
    style: top ? top.style : '未识别营业部',
    tags: mergedTags.length ? mergedTags : ['未识别'],
    confidence: top ? top.confidence : 0.2,
    official: Boolean(top && top.official),
    matches: hits,
    note: top && !top.official ? '非官方身份确认，仅基于营业部名称规则的疑似标签。' : undefined,
  };
}

function sum(rows, predicate, field = 'netAmount') {
  return rows.filter(predicate).reduce((s, x) => s + (Number(x[field]) || 0), 0);
}

function summarizeSeats(rows) {
  const valid = Array.isArray(rows) ? rows : [];
  const buyTotal = valid.reduce((s, x) => s + Math.max(Number(x.buyAmount) || 0, 0), 0);
  const sellTotal = valid.reduce((s, x) => s + Math.max(Number(x.sellAmount) || 0, 0), 0);
  const netTotal = valid.reduce((s, x) => s + (Number(x.netAmount) || 0), 0);
  const topBuy = [...valid].sort((a, b) => (b.buyAmount || 0) - (a.buyAmount || 0))[0] || null;
  const topSell = [...valid].sort((a, b) => (b.sellAmount || 0) - (a.sellAmount || 0))[0] || null;
  const institutionNet = sum(valid, x => (x.tags || []).includes('机构席位'));
  const northboundNet = sum(valid, x => (x.tags || []).includes('陆股通'));
  const lhasaNet = sum(valid, x => (x.tags || []).includes('拉萨系'));
  const suspectedHotMoneyNet = sum(valid, x => (x.tags || []).includes('疑似活跃游资席位'));
  const salesDeptNet = sum(valid, x => (x.tags || []).includes('营业部席位') || (x.tags || []).includes('疑似活跃游资席位'));
  const topBuyConcentration = buyTotal && topBuy ? Number(((topBuy.buyAmount || 0) / buyTotal).toFixed(3)) : null;

  const qualityTags = [];
  const riskFlags = [];
  if (institutionNet > 0) qualityTags.push('机构净买入');
  if (northboundNet > 0) qualityTags.push('陆股通净买入');
  if (suspectedHotMoneyNet > 0) qualityTags.push('疑似游资净买入');
  if (salesDeptNet > 0) qualityTags.push('营业部资金净买入');
  if (lhasaNet > 0) riskFlags.push('拉萨系净买入，次日分歧波动可能加大');
  if (netTotal < 0) riskFlags.push('龙虎榜整体净卖出');
  if (topBuyConcentration !== null && topBuyConcentration >= 0.45) riskFlags.push('买一集中度较高，存在一家独大风险');
  if (institutionNet < 0) riskFlags.push('机构净卖出');

  return {
    buyTotal,
    sellTotal,
    netTotal,
    institutionNet,
    northboundNet,
    lhasaNet,
    suspectedHotMoneyNet,
    salesDeptNet,
    topBuy,
    topSell,
    topBuyConcentration,
    qualityTags,
    riskFlags,
  };
}

module.exports = {
  RULES,
  tagSeat,
  summarizeSeats,
};
