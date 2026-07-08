const { json, setCors, okBase } = require('./_stock-utils');

const RULES = {
  version: 'review_rules_v1',
  principles: [
    '确认优先：宁愿错过，不为提前参与承担预判风险。',
    '先证明，再交易：涨停/炸板/跌停/连板/中军/成交额/消息催化必须互相验证。',
    '看A做B：风向标A用于确认板块强度，可参与观察B必须有明确触发条件。',
    '盘前必须有预案，盘中新增必须打标签，不把涨起来的票包装成盘前核心。',
    '不赚随机波动的钱，只赚对手盘行为可预测的钱。',
  ],
  dailyReviewTemplate: [
    '1. 今日情绪阶段：冰点/修复/启动/主升/高潮/分歧/退潮。',
    '2. 指数与成交额：上证、深成指、创业板、两市成交额、涨跌家数。',
    '3. 涨停结构：涨停数、首封时间、连板高度、题材归因、板块涨停家数。',
    '4. 炸板结构：炸板数、炸板率、炸板集中方向、核心是否炸板回封。',
    '5. 跌停/大面结构：跌停数、高标负反馈、断板A杀、风险锚。',
    '6. 连板梯队：最高板、三板、二板、首板，是否断层。',
    '7. 主线/次主线/修复方向/退潮方向。',
    '8. 板块中军与容量核心：成交额、承接、趋势、是否破位。',
    '9. 盘中时间线：竞价→早盘→午盘→午后→尾盘→收盘结论。',
    '10. 明日预案：固定观察池、风向标A、可参与观察B、风险锚、触发/失效条件。',
  ],
  intradayTimelineTemplate: [
    '盘前预判：明确主线候选、风向标A、可参与B、风险锚。',
    '竞价验证：看核心票高开/低开、封单、抢筹、负反馈。',
    '早盘主攻：看资金第一个主动进攻方向和板块批量性。',
    '分歧切换：看冲高失败方向、炸板方向、卡位方向。',
    '午盘定性：判断主线、次主线、修复、退潮。',
    '午后回流：看核心是否回封、中军是否承接。',
    '尾盘确认：看资金留给明天的预期与风险锚。',
  ],
  watchlistLabels: {
    preMarketFixed: '盘前固定：昨晚预案必须给出，盘中不能马后炮新增为核心。',
    intradayNew: '盘中新增：必须说明新增原因、数据来源和用途。',
    confirmOnly: '确认用：看板块成色，不等于买入票。',
    tradableWatch: '可参与观察：必须满足触发条件才考虑。',
    riskAnchor: '风险锚：一旦走弱，用于确认退潮/负反馈。',
    downgrade: '降级删除：方向走弱或验证失败，必须移出主攻池。',
  },
  emotionCycle: {
    ice: { name: '冰点', evidence: ['涨停少', '跌停多', '高标核按钮', '昨日强股无溢价'], action: '空仓或极小仓试错' },
    repair: { name: '修复', evidence: ['跌停减少', '强股止跌', '新方向试探'], action: '轻仓首板试错、弱转强观察' },
    launch: { name: '启动', evidence: ['板块批量涨停', '前排晋级', '中军放量配合'], action: '主线前排、二板确认、中军低吸' },
    mainRise: { name: '主升', evidence: ['龙头打开高度', '梯队完整', '分歧能回封', '次日溢价好'], action: '聚焦核心，龙头分歧回封/中军趋势' },
    climax: { name: '高潮', evidence: ['后排乱涨', '龙头加速', '全市场一致看多'], action: '持核心看卖点，不追后排' },
    divergence: { name: '分歧', evidence: ['核心承接决定性质', '后排淘汰', '中军是否破位'], action: '只做核心，不做杂毛' },
    ebb: { name: '退潮', evidence: ['龙头断板无修复', '中军破位', '亏钱扩散'], action: '保命、空仓、防守' },
  },
  strategyTemplates: [
    { name: '主线前排首板', phase: ['启动'], trigger: ['板块批量涨停', '中军放量', '首封靠前', '封单稳定'], invalid: ['无板块跟随', '尾盘偷袭', '炸板无法回封'] },
    { name: '二板确认', phase: ['启动', '主升'], trigger: ['昨日主线前排', '竞价超预期', '快速上板', '板块继续强'], invalid: ['孤立二板', '板块弱化', '核心中军不跟'] },
    { name: '龙头分歧回封', phase: ['主升', '良性分歧'], trigger: ['市场地位明确', '炸板后承接强', '板块回流', '回封带动性强'], invalid: ['高位末端一致加速后爆量', '中军破位', '后排大面积大面'] },
    { name: '趋势中军低吸/半路', phase: ['启动', '主升', '分歧修复'], trigger: ['板块主线确认', '成交额前列', '回踩不破趋势', '放量重新转强'], invalid: ['放量滞涨', '跌破5/10日线', '板块退潮'] },
    { name: '冰点转折小仓试错', phase: ['冰点', '修复'], trigger: ['全市场弱但新方向逆势批量', '二板强势晋级', '中军抗跌'], invalid: ['次日无溢价', '高标继续核', '新方向一日游'] },
  ],
  monitorTemplates: [
    { name: '主线加强监控', conditions: ['主线涨停家数增加', '前排晋级', '中军成交额放大', '炸板率可控'] },
    { name: '良性分歧监控', conditions: ['核心炸板能回封', '中军不破趋势', '后排掉队但跌停少'] },
    { name: '退潮预警', conditions: ['高标断板无修复', '跌停增加', '炸板率飙升', '中军放量破位'] },
    { name: '盘中新增观察池触发', conditions: ['板块进入涨幅前列', '同方向多个涨停/大阳', '核心成交额放大', '能带动而非单票乱拉'] },
    { name: '降级删除触发', conditions: ['风向标A走弱', '核心中军破位', '板块无新增涨停', '后排大面积回落'] },
  ],
  ladderDisplay: {
    order: ['最高板', '五板以上', '四板', '三板', '二板', '首板'],
    requiredFields: ['代码', '名称', '连板数', '首封时间', '回封情况', '题材归因', '所属板块', '封板质量'],
    interpretation: [
      '梯队完整：高度、宽度、低位补涨都有，偏主升。',
      '高度孤立：最高板有但二三板断层，谨慎接力。',
      '二板增多：新周期/补涨扩散的重要观察点。',
      '首板批量：看是否有中军配合，否则可能一日游。',
    ],
  },
  capacityPolicy: {
    vercelFit: true,
    redisWrites: 0,
    externalRequests: 0,
    note: '本接口为静态规则模板，不调用外部行情源，不写 Redis，几乎不消耗流量。',
  },
};

module.exports = async (req, res) => {
  if (setCors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'Method not allowed' });
  const section = String(req.query.section || 'all');
  const data = section === 'all' ? RULES : (RULES[section] || null);
  if (!data) return json(res, 404, { success: false, error: `Unknown rules section: ${section}`, availableSections: Object.keys(RULES) });
  return json(res, 200, okBase({ mode: 'review_rules_v1', section, data }));
};
