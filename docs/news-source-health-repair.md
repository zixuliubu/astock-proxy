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
