# 保存新闻的来源失败与合法空结果

基于 main `ab39135f4708e1ec3ec05052fc003b1728591868`。

10月15日已保存15:00节点的 newsCatalysts：count=0，eastmoney=ok，cls为HTML导致JSON解析失败，但外层仍success=true。故障属于代理采集/状态表达，悟道导入原样保留，并非导入丢行。未取得东方财富原始响应，不能断言它确实是合法空列表。

两个新闻入口共享既有两次请求，不增加重试、fallback、定时器或改变鉴权。HTTP失败、HTML、无效JSON、未知形状/坏行均是来源失败，安全诊断不复制原始异常或响应正文。

复审补充：即使HTTP200且有可识别的空数组，正文success=false也必须先判UPSTREAM_BUSINESS_FAILURE。
不从未确认合同的数字code猜测成功含义。两个入口各覆盖直接数组、来源容器内数组；两源业务失败保留FAILED/count=null，
单源业务失败保留PARTIAL/confirmedEmpty=false。首批新增5项回归在原HEAD全部失败，修复后通过；另覆盖失败响应带条目、显式成功的合法空结果。不保留业务错误正文或失败条目。

- 两来源均可用且有条目：OK。
- 两来源均返回已识别的空数组：EMPTY，confirmedEmpty=true。
- 部分来源失败：PARTIAL，confirmedEmpty=false；即使count=0也不代表市场无消息。
- 两来源失败：FAILED，success=false，count=null，data=[]。

sourceStatus保留兼容字段，sourceDiagnostics增加每个来源状态、确认空标记、数量与安全错误码/HTTP状态。新闻条目排序和截取范围保留，不伪造新闻。

纯模拟响应回归覆盖已保存故障组合，真实网络请求为0。VPS astock-capture正式Node环境缺少iconv-lite，新闻专项可运行，现有全量适配器/盘口测试因此不可加载；不安装或替换生产依赖，全量由PR CI验证。

本PR未部署；测试通过不代表财联社或东方财富真实采集恢复。禁止为验收重新采集或改写旧节点。

## 10 月 18 日请求合同修复

后续基于最新 main `c9c836893ebdb91e1d692accfec47b4c333e8a7f`，逐文件 Git blob 核对一致后修改。
旧生产接口的错误表达已修正，但 02:09 新闻查询仍 FAILED：东方财富 SHAPE_INVALID，财联社 HTTP 404。

直接只读检查原始响应和官网当前脚本，得到可复现的请求差异：

- 东方财富旧请求 HTTP 200，正文 `code:0`、`data:null`，明确缺少 `sortEnd`；只补 `sortEnd` 后明确缺少 `req_trace`。
  官网 `https://kuaixun.eastmoney.com/emresource/main/js/kuaixun.js` 使用这两个字段。
  修复带空 `sortEnd` 和随机 UUID `req_trace`，保留原主机、栏目 102、pageSize 30。
  实际成功响应 `code:"1"`、`data.fastNewsList` 30 条。
- 财联社旧 `/nodeapi/telegraphList` 返回 HTTP 404。
  官网 `https://www.cls.cn/telegraph` 的公开页面脚本使用 `/api/cache?name=telegraph` 初始化电报列表。
  换用该同源公开路径，保持原有 roll_data 解析，不加入登录、签名或私有接口。
  不能额外带 `rn=30&lastTime=0`：本次该组合返回空列表，官网初始化请求返回非空。
- 已核实的成功码是东方财富 `1`/`"1"`、财联社数字 `errno:0`。
  相应字段存在且不匹配时，业务失败优先于可识别数组；无代码的既有兼容响应仍按原有形状规则处理。

开发环境直接运行候选 newsCatalysts（不是生产验收），北京时间 2026-10-18 02:14:06：
两源均 OK，东方财富 30 条、财联社 20 条，总计/返回 50 条。只读查询、没有写 Redis、采集节点或历史产物。
单次调用仍仅两次源站 GET，无重试、fallback、分页或新增 timer。

新增请求和业务码回归在旧实现先复现 10 项失败，修复后新闻专项 26 项、全量 72 项通过。
测试使用模拟响应，真实源站检查与离线测试分列。仅在开发工作目录安装 package-lock 声明依赖，未安装生产依赖。

上线后仍需固定合并 SHA、验证 Vercel Production、在实际 Node 环境运行专项测试，
再做一次有预算的生产 MCP 新闻查询并分列两源状态、数量和时间。开发环境成功不能替代这一步。
本修复不修改 VPS，不解除 #261 的全局 OOM 部署门禁。
