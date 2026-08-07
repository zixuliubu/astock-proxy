# 涨停原因链路修复验收报告：push2ex 20260806

## 1. 分支与范围

- 仓库：`zixuliubu/astock-proxy`
- 分支：`fix/limit-reason-push2ex-20260806`
- PR：#14
- 修复范围：`/api/limit-up`、`/api/limit-reason`、相关单元测试
- 未触碰范围：不修改主仓库交易策略、不新增交易逻辑、不把行业标签升级为交易原因

## 2. 已复现问题

生产链路在修复前可复现：

```json
{
  "tool": "get_limit_reason",
  "date": "20260806",
  "symbols": "002428,600206,688549,600584",
  "count": 0,
  "data": [],
  "sourceStatus": {
    "limitUp": false,
    "concepts": true,
    "news": true
  }
}
```

这与用户报告的“2026-08-06 涨停池非空但涨停原因结果为 0”一致，属于数据链路异常，不能被当作正常无原因。

## 3. 根因定位

### 3.1 push2ex 字段标准化错误

`getTopicZTPool` 的股票代码字段为 `c`，名称字段为 `n`，连板字段常见为 `lbc`，但旧代码只读取：

```js
code: it.code
name: it.n
continuousBoards: it.lb
```

结果：历史日降级到 push2ex 时，股票代码被标准化为空，后续 `limit-reason` 过滤掉全部股票。

### 3.2 空数组阻断降级

旧 `limit-reason` 使用：

```js
p?.xuangubao?.data || p?.push2ex?.data || ...
```

JavaScript 中空数组 `[]` 为 truthy。若 XGB 返回空数组，系统不会继续使用非空 push2ex，导致非空备用源被跳过。

### 3.3 行业/概念被混入 theme

旧逻辑使用：

```js
theme = reason || conceptTags || industry || '待确认'
```

这会把行业标签或概念标签包装成当天涨停原因，不符合“行业标签不得冒充当天涨停原因”的要求。

## 4. 修复内容

### 4.1 `/api/limit-up`

新增 `normalizePush2exLimitUp()`：

- 兼容 `c` / `code` / `SECURITY_CODE` / `symbol`；
- 兼容 `n` / `name`；
- 优先使用 `lbc` 作为连板字段；
- 保留 `hybk` 为行业上下文；
- 历史日期不再使用不支持 date 的 XGB 当前池，避免历史回归被今日池污染；
- 支持 `top/max` 返回更多 push2ex 行，便于指定股票回归。

### 4.2 `/api/limit-reason`

新增或调整：

- `selectPoolItems()`：选择第一个非空来源；XGB 空数组不会阻断 push2ex；
- `buildReasonRows()`：无直接原因也保留股票；
- `reasonStatus`：`confirmed` / `pending_confirmation`；
- `reason=原因待确认`：无直接原因时明确标记；
- `evidence.kind=context_only`：行业、概念、新闻公告只作上下文证据；
- `detectDataAnomaly()`：涨停池非空但结果为 0 时输出：

```json
{
  "code": "LIMIT_REASON_EMPTY_WITH_NONEMPTY_POOL",
  "level": "DATA_ANOMALY"
}
```

## 5. 测试与 CI

新增测试文件：

```text
test/limit-reason-push2ex.test.js
```

覆盖点：

1. push2ex `c` 字段能正确保留股票代码；
2. XGB 空数组时能降级到非空 push2ex；
3. 行业/概念只能作为 `context_only`，不得冒充原因；
4. 涨停池非空但结果为 0 时必须报 `DATA_ANOMALY`。

本会话中已执行隔离单元验证：

```text
node --test test/limit-reason-patch.test.js

1..4
# tests 4
# pass 4
# fail 0
```

GitHub Actions 已执行：

```text
Data interface tests / test
npm ci: success
npm test: success
workflow conclusion: success
```

## 6. 20260806 指定股票回归口径

回归股票：

| 代码 | 名称 | 预期 |
|---|---|---|
| 002428 | 云南锗业 | 若在 push2ex 涨停池中，必须返回股票行；无直接原因时 `reasonStatus=pending_confirmation` |
| 600206 | 有研新材 | 若在 push2ex 涨停池中，必须返回股票行；无直接原因时 `reasonStatus=pending_confirmation` |
| 688549 | 中巨芯 | 若在 push2ex 涨停池中，必须返回股票行；无直接原因时 `reasonStatus=pending_confirmation` |
| 600584 | 长电科技 | 若在 push2ex 涨停池中，必须返回股票行；无直接原因时 `reasonStatus=pending_confirmation` |

注意：push2ex 涨停池本身通常提供行业、连板、封板时间、封单金额等盘口字段，不稳定提供逐股“当天涨停原因”。因此本次修复的正确行为不是伪造原因，而是：

```text
保留股票 + 标记原因待确认 + 行业/概念仅作上下文
```

## 7. 部署后验收命令

部署该分支后执行：

```bash
curl "https://astock-proxy.vercel.app/api/router?endpoint=limit-up&date=20260806&top=100"

curl "https://astock-proxy.vercel.app/api/router?endpoint=limit-reason&date=20260806&symbols=002428,600206,688549,600584&top=50&includeNews=false&ttlMs=1"
```

验收条件：

1. `/api/limit-up` 的 `push2ex.count` 应大于 0，且目标股票代码不得为空；
2. `/api/limit-reason` 不得返回 `count=0`；
3. 目标股票如无直接原因，必须显示 `reasonStatus=pending_confirmation`；
4. 行业/概念/新闻证据必须为 `context_only`；
5. 若涨停池大于 0 但原因结果仍为 0，必须返回 `status=DATA_ANOMALY` 和 `LIMIT_REASON_EMPTY_WITH_NONEMPTY_POOL`。

## 8. 当前边界

当前分支已完成源码修复、测试补充、PR 提交和 GitHub Actions 验收。由于本会话无法直接部署 Vercel 分支预览，生产域名的真实接口回归需要在 PR 部署或合并后执行第 7 节命令。
