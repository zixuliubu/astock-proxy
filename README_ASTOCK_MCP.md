# A股行情 MCP 私密版使用说明（astock-proxy v1.7.1 稳定验收版）

> 本文档记录 `zixuliubu/astock-proxy` 当前稳定验收版的部署状态、接口清单、MCP 工具、验收方法和后续迭代规则。  
> 当前版本定位：**轻量 A 股复盘底座 / API 中转 / ChatGPT MCP 数据入口**。  
> 不定位为全量行情数据库、重型回测平台或多 Agent 投研系统。

---

## 1. 当前稳定版本

```text
稳定版本：v1.7.1
服务域名：https://astock-proxy.vercel.app
仓库：https://github.com/zixuliubu/astock-proxy
MCP 私密路径：/mcp-laoda-20260708-x7k29q
完整 MCP URL：https://astock-proxy.vercel.app/mcp-laoda-20260708-x7k29q
```

当前已完成：

```text
1. Vercel 部署可用
2. GitHub Actions 10分钟盘中采样可用
3. Upstash Redis 节点写入/读取可用
4. MCP 私密路径可用
5. daily-review-bundle 增强复盘包可用
6. stock-concepts / stock-news / stock-capital-flow / stock-popularity 可用
7. stock-kline 行情备源可用
8. review-rules 复盘规则模板可用
9. concept-members 板块成分股可用
10. sector-money-flow 板块资金流可用
11. limit-reason 涨停原因增强可用
12. watchlist-auto-label 观察池自动标签可用
13. health-check 健康检查可用
14. openapi.json 接口目录已更新
```

---

## 2. 环境变量与安全边界

Vercel Production 环境变量需要存在：

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
CAPTURE_SECRET
```

GitHub Actions Secret 需要存在：

```text
CAPTURE_SECRET
```

安全规则：

```text
1. 不要把 CAPTURE_SECRET、Upstash URL、Upstash Token 发到聊天窗口。
2. health-check 只返回环境变量是否存在，不返回任何 secret 值。
3. /api/capture-node 和 /api/intraday-timeline 需要 token 才能写入/读取真实采样数据。
4. 普通只读接口不写 Redis，不需要 secret。
```

---

## 3. 一键复盘主入口

### 3.1 增强复盘包

```text
GET /api/daily-review-bundle
```

示例：

```text
https://astock-proxy.vercel.app/api/daily-review-bundle
```

带指定观察池：

```text
https://astock-proxy.vercel.app/api/daily-review-bundle?group=semiconductor
```

带自定义观察票：

```text
https://astock-proxy.vercel.app/api/daily-review-bundle?symbols=600584,002185,002407
```

关闭增强信号，只要基础包：

```text
https://astock-proxy.vercel.app/api/daily-review-bundle?extra=false
```

返回重点字段：

```text
marketOverview          指数与成交额
marketSentiment         涨停/跌停/炸板/情绪
lianbanLadder           连板梯队
limitUpPool             涨停池
brokenLimitPool         炸板池
limitDownPool           跌停池
hotSectors              热门板块
coreWatchlist           核心观察池
newsCatalysts           消息催化
intradayTimeline        已保存盘中节点时间线
extraSignals            增强信号
reviewHints             复盘提示
```

`extraSignals` 当前包含：

```text
selectedSymbols         本次增强分析选择的核心票
stockConcepts           个股概念/板块归属
stockCapitalFlow        个股资金流
stockNews               个股新闻/公告催化
stockPopularity         市场人气榜/热榜
watchlistAutoLabel      观察池自动标签
```

容量控制：

```text
概念：最多 8 只核心票
资金流：最多 6 只核心票，只查 minute
新闻公告：最多 5 只核心票，每只 pageSize=5
人气榜：top=30
观察池自动标签：最多 8 只
Redis 写入：0
```

### 3.2 基础复盘包

```text
GET /api/daily-review-bundle-base
```

用于回退和性能对比。

---

## 4. 盘中 10 分钟节点采样链路

当前采样节点：

```text
09:35、09:45、09:55
10:05、10:15、10:25、10:35、10:45、10:55
11:05、11:15、11:25
13:05、13:15、13:25、13:35、13:45、13:55
14:05、14:15、14:25、14:35、14:45、14:55
15:00
```

链路：

```text
GitHub Actions 定时触发
→ Vercel /api/capture-node
→ Upstash Redis 保存节点
→ /api/intraday-timeline 读取时间线
→ /api/daily-review-bundle 汇总
→ ChatGPT MCP 复盘调用
```

手动写入节点：

```text
https://astock-proxy.vercel.app/api/capture-node?node=15:00&token=你的CAPTURE_SECRET
```

读取时间线：

```text
https://astock-proxy.vercel.app/api/intraday-timeline?token=你的CAPTURE_SECRET
```

---

## 5. API 总览

### 5.1 基础行情与市场状态

```text
/api/quote                  个股实时行情
/api/market-overview        指数与两市成交额
/api/sentiment              市场情绪
/api/sector                 热门板块
/api/stock-kline            A股K线行情备源，新浪/腾讯双源
```

示例：

```text
/api/quote?symbols=600519,300750
/api/stock-kline?symbols=600519&frequency=1d&count=30
/api/stock-kline?symbols=600519&frequency=15m&count=60
```

### 5.2 涨停、炸板、跌停、连板

```text
/api/limit-up               涨停池
/api/broken-limit           炸板池
/api/limit-down             跌停池
/api/lianban-ladder         标准化连板梯队
/api/limit-reason           涨停原因归因增强
```

示例：

```text
/api/limit-up
/api/lianban-ladder
/api/limit-reason?top=30
/api/limit-reason?top=30&includeNews=true
```

### 5.3 板块、资金流、成分股

```text
/api/concept-members        板块/概念成分股
/api/sector-money-flow      板块资金流
/api/stock-concepts         个股概念和板块归属
```

示例：

```text
/api/concept-members?keyword=机器人概念&limit=50
/api/concept-members?bk=BKxxxx&limit=50
/api/sector-money-flow?kind=concept&top=30
/api/sector-money-flow?kind=industry&top=30
/api/stock-concepts?symbols=600519,300750
```

说明：

```text
concept-members 会先尝试东方财富 searchapi 解析 BK 代码，
再查 b:BKxxxx 成分股。
如果关键词匹配不到，请优先使用 BK 代码。
```

### 5.4 个股增强信号

```text
/api/stock-popularity       同花顺热榜 / 东方财富人气榜
/api/stock-capital-flow     个股资金流摘要
/api/stock-news             个股新闻 / 巨潮公告催化
```

示例：

```text
/api/stock-popularity?top=20&source=both
/api/stock-capital-flow?symbols=600519&range=both
/api/stock-news?symbols=600519&include=all&pageSize=10
```

### 5.5 观察池与交易系统规则

```text
/api/watchlist              核心观察池
/api/watchlist-auto-label   观察池自动打标签
/api/review-rules           复盘规则模板
```

示例：

```text
/api/watchlist?group=semiconductor
/api/watchlist-auto-label?group=semiconductor
/api/watchlist-auto-label?symbols=600584,002185&context=pre
/api/review-rules
/api/review-rules?section=emotionCycle
/api/review-rules?section=strategyTemplates
```

观察池标签：

```text
盘前固定
盘中新增
确认用
可参与观察
风险锚
降级删除
```

### 5.6 消息、龙虎榜、健康检查、接口目录

```text
/api/news-catalysts         消息面催化线索
/api/dragon-tiger           龙虎榜列表
/api/health-check           服务健康检查
/openapi.json               OpenAPI 接口目录
```

示例：

```text
/api/health-check
/openapi.json
```

---

## 6. MCP 工具清单

当前 MCP 版本：

```text
SERVER_VERSION = 1.7.1
```

MCP 工具：

```text
get_health_check
get_daily_review_bundle
get_stock_quote
get_market_overview
get_limit_up_pool
get_broken_limit_pool
get_limit_down_pool
get_lianban_ladder
get_core_stock_watchlist
get_hot_sectors
get_market_sentiment
get_intraday_node_snapshot
get_intraday_timeline
get_news_catalysts
get_dragon_tiger_list
get_stock_concepts
get_stock_popularity
get_stock_capital_flow
get_stock_news
get_stock_kline
get_review_rules
get_concept_members
get_sector_money_flow
get_limit_reason
get_watchlist_auto_label
```

ChatGPT 连接器刷新后，应能看到以上工具。

---

## 7. 标准验收清单

Vercel 最新部署 Ready 后，按顺序验收：

```text
1. 健康检查
https://astock-proxy.vercel.app/api/health-check

2. 一键复盘增强包
https://astock-proxy.vercel.app/api/daily-review-bundle

3. 板块成分股
https://astock-proxy.vercel.app/api/concept-members?keyword=机器人概念&limit=50

4. 板块资金流
https://astock-proxy.vercel.app/api/sector-money-flow?kind=concept&top=30

5. K线备源
https://astock-proxy.vercel.app/api/stock-kline?symbols=600519&frequency=1d&count=30

6. 观察池自动标签
https://astock-proxy.vercel.app/api/watchlist-auto-label?group=semiconductor

7. OpenAPI 目录
https://astock-proxy.vercel.app/openapi.json
```

成功标准：

```text
HTTP 200
success: true
mode 字段符合对应接口
返回 data / extraSignals / diagnostics 等结构
不泄露 secret
```

注意：

```text
个别上游源失败时，接口可能返回 success:false 但 HTTP 仍为 200，
并在 diagnostics 中说明原因。
这属于可诊断失败，不等于 Vercel 部署失败。
```

---

## 8. 容量与调用边界

当前定位：轻量 API / MCP 工具入口。

允许放在 Vercel 的：

```text
轻量 HTTP 转发
东方财富 / 新浪 / 腾讯 / 同花顺公开接口封装
涨停/炸板/跌停/连板聚合
核心观察池
板块成分股
板块资金流榜单
个股概念、新闻、公告、资金流摘要
静态规则模板
健康检查
```

不直接放在 Vercel 的：

```text
全市场历史K线落库
大规模回测
TradingAgents-CN 整站
tickflow-stock-panel 整站
stock_datasource 整套 Agent 平台
MongoDB / Redis 双数据库应用
Docker 重服务
大模型自动分析批处理
```

调用控制原则：

```text
1. 10分钟自动采样只保留核心节点数据。
2. sector-money-flow / concept-members / limit-reason 默认按需调用，不进入高频自动采样。
3. daily-review-bundle 只自动调用轻量增强信号。
4. 大接口失败时返回 diagnostics，不拖死主复盘链路。
5. 新模块接入前必须先评估调用量、外部请求数、缓存、降级方案。
```

---

## 9. 用户复盘固定口径

复盘必须区分：

```text
主线
次主线
修复方向
退潮方向
风险锚
板块A / 总开关
可参与观察B
盘中新增
降级删除
```

复盘必须联动：

```text
指数状态
两市成交额
涨停池
炸板池
跌停池
连板梯队
首封时间
回封情况
板块强度
板块中军
容量核心
20cm弹性
后排扩散
风险锚
消息催化
人气热度
观察池标签
```

交易风格：

```text
确认优先，宁愿错过一部分，也不要在证据不足时提前预判。
不赚随机波动的钱，只赚对手盘行为可预测的钱。
```

---

## 10. 后续迭代规则

当前版本建议作为稳定基线：

```text
v1.7.1-stable
```

后续新增功能流程：

```text
1. 先做容量评估
2. 再做接口设计
3. 默认只读、缓存、限流、降级
4. 不直接进入 10分钟自动采样
5. 单独接口验收成功后，再考虑接入 daily-review-bundle
6. 重大改动前保留 base 版本或 fallback 路径
```

下一阶段建议：

```text
1. 板块别名表：机器人/人形机器人/算力/半导体/创新药等常用关键词 → BK代码
2. README 主文档补充快速入口
3. 给 GitHub 打稳定标签 v1.7.1-stable
4. 逐步把历史采样存储迁移到 Cloudflare/D1 或 VPS，Vercel 保持轻量入口
```
