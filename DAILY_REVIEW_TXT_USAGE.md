# DAILY_REVIEW_TEMPLATE.txt 使用说明

> 本文件说明如何使用仓库根目录的 `DAILY_REVIEW_TEMPLATE.txt`。  
> 目标：把每日复盘从“行情流水账”升级为“次日交易作战书”。

---

## 1. 文件定位

```text
DAILY_REVIEW_TEMPLATE.txt
```

用途：

```text
1. 每日盘后复盘
2. 次日盘前计划
3. 盘中节点回看
4. 交易自评
5. 主线/次主线/风险锚跟踪
```

核心逻辑：

```text
数据证据 → 结构判断 → 交易预案 → 次日验证
```

不要把它当成简单记录本，而要当成每天的交易作战书。

---

## 2. 每日推荐使用流程

### 第一步：先拉一键复盘包

```text
/api/daily-review-bundle
```

浏览器测试：

```text
https://astock-proxy.vercel.app/api/daily-review-bundle
```

这个接口提供：

```text
指数与成交额
市场情绪
涨停池
炸板池
跌停池
连板梯队
热门板块
观察池
消息催化
盘中时间线
增强信号
观察池自动标签
```

---

### 第二步：补板块证据

主线方向确认时，补两个接口：

```text
/api/sector-money-flow
/api/concept-members
```

示例：

```text
https://astock-proxy.vercel.app/api/sector-money-flow?kind=concept&top=30
https://astock-proxy.vercel.app/api/concept-members?keyword=机器人概念&limit=50
```

用途：

```text
sector-money-flow：判断板块是否有容量资金
concept-members：判断板块是否有前排、中军、后排、扩散和掉队
```

---

### 第三步：补核心票证据

对主线核心票、板块中军、可参与观察票，补这些接口：

```text
/api/stock-concepts
/api/stock-capital-flow
/api/stock-popularity
/api/stock-news
/api/stock-kline
```

示例：

```text
/api/stock-concepts?symbols=600584,002185
/api/stock-capital-flow?symbols=600584,002185&range=both
/api/stock-popularity?top=30&source=both&symbols=600584,002185
/api/stock-news?symbols=600584,002185&include=all&pageSize=5
/api/stock-kline?symbols=600584&frequency=15m&count=60
```

用途：

```text
stock-concepts：题材归属是否准确
stock-capital-flow：资金承接是否配合
stock-popularity：散户关注度、踏空资金、人气扩散
stock-news：消息/公告催化验证
stock-kline：趋势、分时、承接、破位验证
```

---

### 第四步：给观察池打标签

```text
/api/watchlist-auto-label
```

示例：

```text
/api/watchlist-auto-label?group=semiconductor
/api/watchlist-auto-label?symbols=600584,002185&context=pre
```

标签体系：

```text
盘前固定
盘中新增
确认用
可参与观察
风险锚
降级删除
```

规则：

```text
盘中新增不能事后包装成盘前核心。
可参与观察必须有触发条件。
风险锚不修复，相关方向降级。
```

---

## 3. 填写优先级

如果时间不够，不必每天填满所有内容。

最低限度必须填写：

```text
一、今日结论一句话
二、指数与成交额
三、市场情绪
四、涨停池与连板梯队
五、炸板池与跌停池
六、板块强度与主线确认
十二、明日作战计划
十三、次日验证清单
```

进阶完整复盘再填写：

```text
七、板块A / 总开关
八、可参与观察B
九、盘中时间线
十、消息、人气与对手盘
十一、今日交易复盘
十四、今日最终评分
```

---

## 4. 数据源对应模板位置

```text
指数与成交额
→ 二、指数与成交额
→ /api/market-overview

情绪、涨停、炸板、跌停、连板
→ 三、四、五
→ /api/sentiment
→ /api/limit-up
→ /api/broken-limit
→ /api/limit-down
→ /api/lianban-ladder

板块强度、资金流、成分股
→ 六、七、八
→ /api/sector-money-flow
→ /api/concept-members
→ /api/stock-concepts

个股承接、趋势、人气、消息
→ 七、八、十
→ /api/stock-capital-flow
→ /api/stock-kline
→ /api/stock-popularity
→ /api/stock-news

盘中节点
→ 九、盘中时间线
→ /api/intraday-timeline

观察池标签
→ 八、可参与观察B
→ 十二、明日作战计划
→ /api/watchlist-auto-label
```

---

## 5. 每日复盘输出标准

每天最终 TXT 至少要回答 7 个问题：

```text
1. 今天市场处于什么情绪阶段？
2. 今天主线是谁？是真强还是假强？
3. 哪个板块有梯队、资金、中军、人气共振？
4. 哪些方向已经退潮，需要回避？
5. 明天的板块A / 总开关是谁？
6. 明天的可参与观察B是谁？触发条件是什么？
7. 明天如果验证失败，什么条件下空仓？
```

不能只写：

```text
今天机器人很强
今天半导体回流
今天某某涨停
```

必须写成：

```text
机器人方向是否具备涨停梯队？
是否有中军配合？
是否有容量资金？
是否有后排扩散？
是否有风险锚？
明天谁会成为对手盘？
我能不能赚确认滞后资金的钱？
```

---

## 6. 明日作战计划必须有“条件”

错误写法：

```text
明天关注机器人、半导体、创新药。
```

正确写法：

```text
明天主线优先级：机器人 > 半导体 > 创新药。

机器人方向：
板块A：某中军
可参与B：某前排/换手核心
触发条件：
1. 竞价高标无核按钮
2. 二板继续晋级
3. 中军不低开破位
4. 板块资金流继续靠前
5. 可参与B分歧后重新转强

失效条件：
1. 高标核按钮
2. 中军放量下杀
3. 板块炸板扩散
4. 人气榜退潮
5. 风险锚继续走弱
```

---

## 7. 命名建议

每天复制一份模板，命名为：

```text
reviews/2026-07-09_daily_review.txt
reviews/2026-07-10_daily_review.txt
```

如果暂时不建目录，也可以放在本地 Obsidian 或电脑文件夹里。

建议后续仓库新增目录：

```text
reviews/
```

但实际每日复盘内容不一定要提交到公开仓库，避免暴露个人交易计划。

---

## 8. 核心原则

```text
1. 不赚随机波动的钱，只赚对手盘行为可预测的钱。
2. 最好的对手盘，是确认滞后、踏空焦虑、规则驱动、纠错回补、情绪扩散的资金。
3. 最差的交易，是在先手资金准备兑现时，误以为自己还在赚龙头的钱。
4. 确认优先，宁愿错过，也不在证据不足时提前预判。
5. 盘前没有计划，盘中新增必须打标签，不能事后包装成盘前核心。
```
