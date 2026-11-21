# 服务端 API 手册

> **示例响应抓取于 2026-11-20**，样本账本 5 笔流水（申购 ×2、现金分红、份额折算、赎回各一），
> 基金代码 `000001` / `011609`（公开代码，非任何人的真实持仓）。
> 抓取方式：起真实服务、用 `curl` 打每个端点、把响应原文贴进来。
> **为控制篇幅，长数组（净值序列、分类清单）与 `provenance` 的内层信封做了省略**，
> 省略处用 `…` 标出；部分对象为便于阅读调整了**键顺序**（JSON 键顺序无语义），
> **字段名与值都来自真实响应，一个字没改**。

这份手册是给人查的，不是给编译器看的。类型定义看 `apps/server/src/services/*.ts` 与
`apps/server/src/envelope.ts`，这里只讲**怎么用、看到什么、别踩什么**。

---

## 一、总则

### 地址与端口

| 项 | 值 | 怎么改 |
|---|---|---|
| Base URL | `http://localhost:3000` | 环境变量 `PORT`（默认 3000，避开 Vite 的 3001） |
| 前端来源（CORS） | `http://localhost:3001` | 环境变量 `CORS_ORIGIN` |
| 数据库文件 | `apps/server/data/fundmanager.db` | 环境变量 `DB_PATH` |

**启动**：

```bash
pnpm --filter @fundmanager/server start
```

`start` 就是 `node src/server.ts`（Node 24 直接跑 TypeScript，没有构建步骤），
工作目录是 `apps/server`，所以 `DB_PATH` 的**相对路径按 `apps/server` 解析**。
目录不存在会自动建，首次运行不用手工 `mkdir`。

### CORS

开发时只允许 `http://localhost:3001`（Vite dev server）。生产由前端静态服务同源代理，
**不开宽 CORS**。非白名单来源的预检请求不报错，但响应里 `Access-Control-Allow-Origin`
仍是白名单的值，浏览器会自己拦下。

### `ledgerId` 是什么

**是「一本账」，不是「一个用户」。** 这个项目没有多用户、没有账号体系，也就没有鉴权：

- 系统里可以有 N 本账（现在 1 本，将来可能是「实盘」「模拟盘」「家人的」）
- 流水、持仓、XIRR、对账、组合风险都挂在某本账下
- **本机谁都能读**——它没有鉴权，也不打算有。自己部署、数据留在本地是前提

账本 ID 是 `POST /api/ledgers` 生成的 UUID，没有任何含义，别去解析它。

### 路由按「资源归属」分两组

判据：**这个数是因为我持有才存在，还是市场本来就有？**

- **因为持有才存在** → 挂 `/api/ledgers/:ledgerId`：持仓、盈亏、XIRR、组合风险、流水、对账
- **市场本来就有** → 挂 `/api/funds`：净值、基金档案、单基金风险、搜索

所以「查一只基金的净值」**不需要账本 ID**。用账本去查全市场净值语义不通。

### 两个约定

- 所有请求/响应都是 **UTF-8 JSON**。`Content-Type: application/json` 必须带
- 日期一律 `YYYY-MM-DD`（业务日期），时刻一律带时区 `+08:00`（抓取时刻）

---

## 二、返回信封说明

每个**可能来自外部数据**的数字都套一层 `Sourced<T>`。这是这一层唯一不能省的复杂度：
前端拿到的每个数都自带出处与时点，拿不到时明确拿到「算不出来」，而不是一个 `null` 被当成 0。

```ts
type Sourced<T> = {
  value: T | null
  reason: string | null
  source: string
  dataAsOf: string
  capturedAt: string
  stale: boolean
  loss: string | null
  provenance: readonly Sourced<unknown>[]
}
```

| 字段 | 含义 | 为什么存在 |
|---|---|---|
| `value` | 值。**`null` 表示「算不出来」，不是 0** | `null` 和 0 长得像，含义天差地别：成本未知时 `value: null` 而不是 0，否则盈亏会算成一笔看着合理的假数 |
| `reason` | `value` 为 null 时的**可读原因**（中文，可直接显示）；有值时为 `null` | 用户看到「—」时得知道为什么，而不是猜 |
| `source` | 数据来自哪个端点（如 `'f10/lsjz'`、`'repository/transaction'`）；派生值是各输入来源用 `；` 拼起来 | 排障与换源要看 |
| `dataAsOf` | **数据本身的时点**：净值日 / 报告期 / 台账日期 | 和抓取时刻不是一回事：今天抓到的可能是昨天的净值 |
| `capturedAt` | 抓取时刻，带 `+08:00` | 判断缓存活了多久 |
| `stale` | `true` = 这数来自**缓存降级**（外部源全挂了，只能用旧值） | 数据旧。不标出来，用户会把三天前的净值当今天看 |
| `loss` | 非 null = 来自**更弱的数据源**，字符串说明**失去了什么口径** | 口径弱。典型：备源没有分红事件字段，复权结果可能仍含假回撤 |
| `provenance` | 派生值的**各输入信封**（数组）；直接来自外部数据时为空数组 | 组合回撤由哪几条序列、哪些时点合成，出问题时能倒查 |

### `stale` 与 `loss` 必须分开

两者都不是「有值就当没事」：

- `stale: true` 是**绝对时点**问题——「你看到的是 3 天前的」；
- `loss` 非 null 是**覆盖/口径**问题——「这是净值，但没了分红事件，复权可能不干净」。

一条 `stale: false, loss: null` 的可信度，和 `stale: true, loss: '…'` 的，不是一回事。
**两者都要显示出来**，不能只显示数字。

### 粒度：一个响应一个信封，多行数据逐行带

- 单值（一个持仓、一个收益率、一组风险指标）→ 一个信封
- **多行**（持仓表、净值序列）→ 响应整体一个信封，**行内每个依赖外部数据的字段各自带一个小信封**
- 净值序列**不逐行套信封**：4000 行的序列不可能每个数带八个字段。改用「一行一个 `dataAsOf`」（见 `/api/funds/:code/nav`）

### 派生值的时点取**最早**的输入

持仓的 `dataAsOf` 取参与计算的输入里**最旧**的那个，`stale` 取「任一输入 stale」，
`loss` 取各输入拼接。理由：派生值只和它最旧的那部分一样可靠，取最新会让人误以为整体都是新的。

### 不需要信封的字段

纯账本内生的数——`shares`、`asOf`、`realizedGain`、`cashFlows`、`members`——**不套信封**。
它们的可信度由账本本身保证，账本的正确性由对账守（见 `POST /reconcile`）。

---

## 三、口径警告：净值有两种，不能混用

`GET /api/funds/:code/nav` **同时**返回两份序列：

| 字段 | 口径 | 用途 |
|---|---|---|
| `nav` | **未复权**单位净值（`Sourced<NavHistory>`） | 市值、XIRR 期末市值 |
| `adjusted` | **复权**净值（`Sourced<AdjustedNav[]>`，分红再投口径） | 波动率、回撤、相关性 |

**同一只基金、同一段日期，两个数不一样。** 实测 `000001` 在 2021-12-17 除息
（每 10 份派 0.5 元）：

| 日期 | `nav`（未复权） | `adjusted`（复权） |
|---|---|---|
| 2021-12-16 | 1.273 | 1.273 |
| 2021-12-17 | **1.208**（除息日机械下跌 -5.1%） | **1.258** |

未复权序列上那个 -5.1% **不是亏损**，是分红除息。拿它算最大回撤会得到一条**假回撤**。

### 用反了会怎样

| 错误用法 | 后果 |
|---|---|
| 用 `adjusted` 当期末市值算 XIRR | 现金分红已经在 `cashFlows` 里算过一次，期末市值再用复权口径 → **同一笔分红算两次**，收益率虚高 |
| 用 `nav` 算风险指标 | 每个分红除息日都是一次假回撤 → 最大回撤、波动率全部虚高 |
| 前端自己把 `nav` 当 `adjusted` 传给风险接口 | 服务端已经把复权做完了（`navService.ts` 是全仓唯一调 `toAdjustedSeries` 的地方），前端**不该再算一次**，也不该自己判断哪个是哪个 |

### 各端点用的哪个口径

| 端点 | 用的口径 |
|---|---|
| `GET /api/funds/:code/nav` | **两个都给**：`nav` 未复权（降序）、`adjusted` 复权（**升序**） |
| `GET /api/funds/:code/risk` | 只用 `adjusted` |
| `GET /api/ledgers/:id/portfolio/risk` | 只用 `adjusted` |
| `GET /api/ledgers/:id/positions`（`marketValue` / `unrealizedGain`） | 只用 `nav`（未复权 × 份额） |
| `GET /api/ledgers/:id/funds/:code/return`（`endNav` / `endValue` / `xirr`） | 只用 `nav`（未复权） |

**排序方向也不同**：`nav.value.rows` 是**降序**（最新在前，数据源原样）；`adjusted.value`
是**升序**（复权函数的输出）。画图前注意。

---

## 四、每个端点

> 下面所有 `$B` 都指 `http://localhost:3000`，`$LID` 指账本 ID。

### 4.1 账本内的数据

| 方法 | 路径 |
|---|---|
| GET | `/api/ledgers` |
| POST | `/api/ledgers` |
| POST | `/api/ledgers/:ledgerId/transactions` |
| GET | `/api/ledgers/:ledgerId/positions` |
| GET | `/api/ledgers/:ledgerId/overview` |
| GET | `/api/ledgers/:ledgerId/positions/:fundCode` |
| GET | `/api/ledgers/:ledgerId/funds/:fundCode/return` |
| GET | `/api/ledgers/:ledgerId/portfolio/risk` |
| POST | `/api/ledgers/:ledgerId/reconcile` |
| GET | `/api/ledgers/:ledgerId/reconcile/last` |

---

#### GET `/api/ledgers` — 账本列表

无参数。

```bash
curl -s "$B/api/ledgers"
```

```json
{
  "value": [
    { "id": "74754860-5dd3-44e3-9fd5-008fa27b20b4", "name": "演示账本" },
    { "id": "253d6c83-af38-4eb9-be17-8be42ea8c40c", "name": "空账本" }
  ],
  "reason": null,
  "source": "repository/ledger",
  "dataAsOf": "2026-11-20",
  "capturedAt": "2026-11-20T16:47:26+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

没有账本时 `value: []`，**200 而不是 404**。

**错误**：无（账本数据是本地的，不会失败）。

---

#### POST `/api/ledgers` — 新建账本

首次运行必须能建，否则后面全用不了。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 首尾空格会被去掉；空白名被拒 |

```bash
curl -s -X POST "$B/api/ledgers" \
  -H 'Content-Type: application/json' \
  -d '{"name":"演示账本"}'
```

**响应 201**

```json
{
  "value": { "id": "74754860-5dd3-44e3-9fd5-008fa27b20b4", "name": "演示账本" },
  "reason": null,
  "source": "repository/ledger",
  "dataAsOf": "2026-11-20",
  "capturedAt": "2026-11-20T16:43:56+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

`currency`（默认 CNY）与 `createdAt` 不在对外契约里，不随响应返回。

**错误**：400 `{"error":"账本名称不能为空"}`

---

#### POST `/api/ledgers/:ledgerId/transactions` — 录入一笔流水

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fundCode` | string | 是 | 6 位数字 |
| `date` | string | 是 | `YYYY-MM-DD`，业务日期 |
| `kind` | string | 是 | `subscribe` / `redeem` / `dividend_cash` / `dividend_reinvest` / `split` |
| `amount` | number | 是 | **流向账本为正**：申购为负、赎回/现金分红/红利再投为正；申购额**含申购费**，赎回额是**已扣费后的到账额** |
| `sharesDelta` | number | 视 kind | `subscribe` / `redeem` / `dividend_reinvest` **必填**（赎回为负数）；`split` / `dividend_cash` 为 null |
| `splitRatio` | number | 视 kind | `split` **必填**，是**比例**不是增减量：`1:0.3709` 存 `0.37094933` |
| `sequence` | integer | 同日多笔时必填 | 同一天内的先后序号，从 0 起，**同一天内不能重复**；不同日期无需连续 |
| `note` | string | 否 | 备注 |

录入前会先用 `derivePosition` **把整段历史重推一遍**试算：超赎、同日缺/重 `sequence`、
缺必填份额一律拒绝，**不写库**。所以库里的流水始终是可推导的。

```bash
curl -s -X POST "$B/api/ledgers/$LID/transactions" \
  -H 'Content-Type: application/json' \
  -d '{"fundCode":"000001","date":"2025-08-15","kind":"subscribe",
       "sharesDelta":2000,"amount":-2400,"note":"申购华夏成长"}'
```

**响应 201**

```json
{
  "value": {
    "fundCode": "000001",
    "date": "2025-08-15",
    "kind": "subscribe",
    "sharesDelta": 2000,
    "splitRatio": null,
    "amount": -2400,
    "sequence": null,
    "note": "申购华夏成长",
    "id": "515ebf26-6427-4bb0-9458-b7871b89617d",
    "ledgerId": "74754860-5dd3-44e3-9fd5-008fa27b20b4",
    "status": "confirmed"
  },
  "reason": null,
  "source": "repository/transaction",
  "dataAsOf": "2025-08-15",
  "capturedAt": "2026-11-20T16:43:56+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

手工录入的流水一律是 `status: "confirmed"`。`pending` 留给「数据源拉到、待用户确认」的
分红/折算，那条流程不在本版。

另外三种 kind 的请求体（同一端点）：

```jsonc
// 现金分红：份额和成本都不动，只进已实现收益
{ "fundCode": "000001", "date": "2025-09-19", "kind": "dividend_cash", "amount": 36.5 }

// 份额折算：比例是 1.2（不是增减量），成本不变、单位成本按反比例变化
{ "fundCode": "000001", "date": "2025-10-16", "kind": "split", "splitRatio": 1.2, "amount": 0 }

// 赎回：sharesDelta 为负；amount 是到账额
{ "fundCode": "011609", "date": "2025-11-04", "kind": "redeem", "sharesDelta": -200, "amount": 214.4 }
```

**错误**（全部 400，`{"error": "…"}`）

| 情形 | 实际返回的 `error` |
|---|---|
| 超赎 | `这笔赎回超过了账面份额，请先补录买入` |
| 缺份额 | `这笔记账缺少份额` |
| 同日多笔却没给 sequence | `同一天有多笔流水，需要指定先后顺序` |
| 同日 sequence 重复 | `同一天的顺序号重复了` |
| 缺金额 | `这笔记账缺少金额` |
| 金额不是数字 | `amount 必须是数字，收到「10」` |
| 日期格式错 | `date 必须是 YYYY-MM-DD 格式，收到：2025/12/10` |
| 代码不是 6 位 | `基金代码必须是 6 位数字，收到「12345」` |
| 未知 kind | `这笔记账的流水类型无法识别，应为 subscribe / redeem / dividend_cash / dividend_reinvest / split` |
| 请求体不是对象 | `请求体必须是一个 JSON 对象` |

---

#### GET `/api/ledgers/:ledgerId/overview` — 基金资产与当日收益

返回信封覆盖账本内的基金资产与收益。`value` 包含：

| 字段 | 含义 |
| --- | --- |
| `valuationDate`、`previousDate` | 本次统一采用的两个确认净值日，缺少日期时为 `null` |
| `marketValue`、`dailyGain` | 总市值、当日收益，单位为人民币元，各自携带来源与异常状态 |
| `marketValueCoverage`、`dailyGainCoverage` | 对应指标的 `included`（已计入只数）与 `total`（应计入只数） |
| `positions` | 持仓记录，沿用持仓接口的字段结构，增加 `dailyGain` 和 `holdingGainRate`。收益率为小数 |

所有基金的当日收益都使用同一个净值区间。计算时扣除申购等外部资金变动的影响，区间内全赎的基金也参与汇总。缺少对应日期的确认净值、分红或折算仍待核对时，该基金的收益为空。部分基金不可计算时，总额仅含已覆盖部分。查询使用当前月及上月的净值，全清仓时以最近赎回日期为准。

空账本的市值为 `0`，当日收益为 `null`。不存在的 `ledgerId` 返回 HTTP 404。

#### GET `/api/ledgers/:ledgerId/positions` — 全部持仓

无参数（**不认 `asOf` 查询参数，按今天推**）。

账本里**出现过的每只基金一行**，包括已全部赎回（`shares: 0`）的——它的已实现收益仍要看。
一笔流水都没有时 `value: []`。

```bash
curl -s "$B/api/ledgers/$LID/positions"
```

```json
{
  "value": [
    {
      "fundCode": "011609",
      "asOf": "2026-11-20",
      "shares": 800,
      "realizedGain": 14.400000000000006,
      "cost": {
        "value": 800, "reason": null, "source": "repository/transaction",
        "dataAsOf": "2026-11-20", "capturedAt": "2026-11-20T16:44:18+08:00",
        "stale": false, "loss": null, "provenance": []
      },
      "costPerShare": {
        "value": 1, "reason": null, "source": "repository/transaction",
        "dataAsOf": "2026-11-20", "capturedAt": "2026-11-20T16:44:18+08:00",
        "stale": false, "loss": null, "provenance": []
      },
      "marketValue": {
        "value": 795.12, "reason": null, "source": "f10/lsjz",
        "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
        "stale": false, "loss": null,
        "provenance": ["…（省略 1 个输入信封：这只基金的整段净值历史）"]
      },
      "unrealizedGain": {
        "value": -4.8799999999999955, "reason": null,
        "source": "repository/transaction；f10/lsjz",
        "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:44:18+08:00",
        "stale": false, "loss": null,
        "provenance": ["…（省略 2 个输入信封：成本 + 市值）"]
      }
    },
    {
      "fundCode": "000001",
      "asOf": "2026-11-20",
      "shares": 2400,
      "realizedGain": 36.5,
      "cost": {
        "value": 2400, "reason": null, "source": "repository/transaction",
        "dataAsOf": "2026-11-20", "capturedAt": "2026-11-20T16:44:59+08:00",
        "stale": false, "loss": null, "provenance": []
      },
      "costPerShare": {
        "value": 1, "reason": null, "source": "repository/transaction",
        "dataAsOf": "2026-11-20", "capturedAt": "2026-11-20T16:44:59+08:00",
        "stale": false, "loss": null, "provenance": []
      },
      "marketValue": {
        "value": 2320.7999999999997, "reason": null,
        "source": "pingzhongdata/Data_netWorthTrend",
        "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
        "stale": false,
        "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
        "provenance": ["…（省略 1 个输入信封）"]
      },
      "unrealizedGain": {
        "value": -79.20000000000027, "reason": null,
        "source": "repository/transaction；pingzhongdata/Data_netWorthTrend",
        "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:44:59+08:00",
        "stale": false,
        "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
        "provenance": ["…（省略 2 个输入信封）"]
      }
    }
  ],
  "reason": null,
  "source": "f10/lsjz；repository/transaction；pingzhongdata/Data_netWorthTrend",
  "dataAsOf": "2026-11-19",
  "capturedAt": "2026-11-20T16:44:59+08:00",
  "stale": false,
  "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
  "provenance": ["…（省略 4 个输入信封）"]
}
```

字段口径：

- `shares` / `realizedGain`：**账本内生**，不带信封
- `cost` / `costPerShare`：移动加权平均成本；没有买入记录时为 `null` + 原因
- `marketValue`：**份额 × 最新未复权确认净值**。若净值日之后还有持仓变动，返回 `null` 并说明在等新净值。已清仓时直接返回零。
- `unrealizedGain`：`marketValue − cost`；两者任一 unknown 时为 `null`

**错误**：无（未知的 `ledgerId` 返回空列表，不报错——见「常见坑」）。

---

#### GET `/api/ledgers/:ledgerId/positions/:fundCode` — 单只基金持仓

```bash
curl -s "$B/api/ledgers/$LID/positions/000001"
```

```json
{
  "value": {
    "fundCode": "000001",
    "asOf": "2026-11-20",
    "shares": 2400,
    "realizedGain": 36.5,
    "cost": {
      "value": 2400, "reason": null, "source": "repository/transaction",
      "dataAsOf": "2026-11-20", "capturedAt": "2026-11-20T16:44:59+08:00",
      "stale": false, "loss": null, "provenance": []
    },
    "costPerShare": {
      "value": 1, "reason": null, "source": "repository/transaction",
      "dataAsOf": "2026-11-20", "capturedAt": "2026-11-20T16:44:59+08:00",
      "stale": false, "loss": null, "provenance": []
    },
    "marketValue": {
      "value": 2320.7999999999997, "reason": null,
      "source": "pingzhongdata/Data_netWorthTrend",
      "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
      "stale": false,
      "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
      "provenance": ["…（省略 1 个输入信封）"]
    },
    "unrealizedGain": {
      "value": -79.20000000000027, "reason": null,
      "source": "repository/transaction；pingzhongdata/Data_netWorthTrend",
      "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:44:59+08:00",
      "stale": false,
      "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
      "provenance": ["…（省略 2 个输入信封）"]
    }
  },
  "reason": null,
  "source": "pingzhongdata/Data_netWorthTrend；repository/transaction",
  "dataAsOf": "2026-11-19",
  "capturedAt": "2026-11-20T16:44:59+08:00",
  "stale": false,
  "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
  "provenance": ["…（省略 2 个输入信封）"]
}
```

份额为 0 也照常返回（已全部赎回，`realizedGain` 仍可看）。

**错误**

| 状态 | 情形 | 响应 |
|---|---|---|
| 400 | 代码不是 6 位数字 | `{"error":"基金代码必须是 6 位数字，收到「abc」"}` |
| 404 | 该基金在这本账里**一笔流水都没有** | `{"error":"该账本没有这只基金的流水"}` |

404 的含义是「查错了对象」，**不是**「0 份额持仓」——后者返回 200 + `shares: 0`。

---

#### GET `/api/ledgers/:ledgerId/funds/:fundCode/return` — XIRR

这只基金在这本账里的**资金加权年化收益率**。无参数。

```bash
curl -s "$B/api/ledgers/$LID/funds/000001/return"
```

```json
{
  "value": {
    "fundCode": "000001",
    "asOf": "2026-11-19",
    "shares": 2400,
    "endNav": {
      "value": 0.967, "reason": null,
      "source": "pingzhongdata/Data_netWorthTrend",
      "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
      "stale": false,
      "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
      "provenance": ["…（省略 1 个输入信封）"]
    },
    "endValue": {
      "value": 2320.7999999999997, "reason": null,
      "source": "pingzhongdata/Data_netWorthTrend",
      "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
      "stale": false,
      "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
      "provenance": ["…（省略 1 个输入信封）"]
    },
    "xirr": {
      "value": -0.014314651886761178, "reason": null,
      "source": "pingzhongdata/Data_netWorthTrend",
      "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
      "stale": false,
      "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
      "provenance": ["…（省略 1 个输入信封）"]
    },
    "cashFlows": [
      { "date": "2025-08-15", "amount": -2400 },
      { "date": "2025-09-19", "amount": 36.5 },
      { "date": "2026-11-19", "amount": 2320.7999999999997 }
    ]
  },
  "reason": null,
  "source": "pingzhongdata/Data_netWorthTrend",
  "dataAsOf": "2026-11-19",
  "capturedAt": "2026-11-20T16:43:56+08:00",
  "stale": false,
  "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
  "provenance": ["…（省略 1 个输入信封）"]
}
```

口径：

- `endNav` / `endValue`：**未复权**单位净值、净值 × 份额（真能赎回拿到的钱）
- `xirr`：小数（`-0.0142` = -1.42%），**不是百分数**
- `cashFlows`：纳入求解的现金流，流水部分按日合并。有持仓市值时，在末尾追加净值日的期末市值。流向账本的金额为正。
- `asOf` 是实际计算截止日。有持仓时使用今天（中国时区）及以前最近的确认净值日，份额与流水也截到同一天。已清仓时只使用截至今天的确认流水，期末市值为零。

`xirr.value` 为 null 是正常形态，`reason` 会说明：

| `reason` | 含义 |
|---|---|
| `现金流不足：至少需要一笔投入与一笔收回才能算年化收益率` | 只有分红/只有申购，方程无意义 |
| `该基金在账本里没有已确认的流水，无法计算收益率` | 流水全是 `pending`（手工录入恒为 `confirmed`，正常用不到这条） |
| `XIRR 存在多个解（2 个：-1.42%、3.01%），收益率不唯一，不能挑一个当答案` | **多解是正常的数据形态**（现金流多次改变方向），此时不给单一数字；`reason` 原文来自 `MultipleRootsError`，括号里会列出全部根 |
| `净值历史里没有截止日当天及以前的净值，无法确定期末市值` | 净值取不到，现金流不完整 |

**错误**：400 代码格式错；404 `{"error":"该账本没有这只基金的流水"}`。

---

#### GET `/api/ledgers/:ledgerId/portfolio/risk` — 组合风险

无参数。返回基金两两相关性，以及按截止日市值权重计算的组合回撤。

```bash
curl -s "$B/api/ledgers/$LID/portfolio/risk"
```

```json
{
  "value": {
    "correlation": {
      "value": [
        [1, 0.9629440008959759],
        [0.9629440008959759, 1]
      ],
      "reason": null,
      "source": "f10/lsjz；pingzhongdata/Data_netWorthTrend",
      "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
      "stale": false,
      "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
      "provenance": ["…（省略 2 个输入信封）"]
    },
    "correlationFundCodes": ["011609", "000001"],
    "maxDrawdown": {
      "value": 0.5363169746785923,
      "reason": null,
      "source": "f10/lsjz；pingzhongdata/Data_netWorthTrend",
      "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
      "stale": false,
      "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
      "provenance": ["…（省略 1 个输入信封）"]
    },
    "currentDrawdown": {
      "value": 0.4074868394176437,
      "reason": null,
      "source": "f10/lsjz；pingzhongdata/Data_netWorthTrend",
      "dataAsOf": "2026-11-19", "capturedAt": "2026-11-20T16:43:56+08:00",
      "stale": false,
      "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
      "provenance": ["…（省略 1 个输入信封）"]
    },
    "members": [
      { "fundCode": "011609", "marketValue": 795.12,  "weight": 0.25517985057382736, "observations": 1362 },
      { "fundCode": "000001", "marketValue": 2320.7999999999997, "weight": 0.7448201494261727, "observations": 6048 }
    ]
  },
  "reason": null,
  "source": "repository/transaction；f10/lsjz；pingzhongdata/Data_netWorthTrend",
  "dataAsOf": "2026-11-19",
  "capturedAt": "2026-11-20T16:45:00+08:00",
  "stale": false,
  "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
  "provenance": ["…（省略 3 个输入信封）"]
}
```

- `correlation.value` 的行列以 `correlationFundCodes` 为准；矩阵不可用时为 `null` 并带原因，基金代码顺序为空。
- `maxDrawdown` / `currentDrawdown`：非负幅度，`0.536` 表示跌 53.6%
- `weight`：市值占比 `[0, 1]`，`null` 表示该基金取不到最新净值、无法加权
- `observations: 0` 表示该基金未参与组合指标。排除原因体现在 `loss`，例如缺净值、持仓变动后仍在等新净值，或复权历史不足。

**每一期都用截止日的市值权重加权收益，再对组合收益复利。** 缺权重或缺复权历史的基金不参与计算，其余基金的权重在计算时重新归一化，受影响指标和外层信封都显示覆盖损失。组合回撤按当前配置回看历史。

**空账本 / 没有份额 > 0 的持仓**时返回：

```json
{
  "value": null,
  "reason": "该账本没有持仓",
  "source": "repository/transaction",
  "dataAsOf": "2026-11-20",
  "capturedAt": "2026-11-20T16:47:26+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

**错误**：无。

---

#### POST `/api/ledgers/:ledgerId/reconcile` — 对账

用户声称的平台份额 vs 账本全量重推出来的份额。**只回报结论，绝不自动修正**：不插入调整流水、
不改任何已有记录。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fundCode` | string | 是 | 6 位数字 |
| `claimedShares` | number | 是 | 平台上显示的实际份额 |
| `asOf` | string | 否 | 对账截止日 `YYYY-MM-DD`，缺省今天 |

```bash
curl -s -X POST "$B/api/ledgers/$LID/reconcile" \
  -H 'Content-Type: application/json' \
  -d '{"fundCode":"000001","claimedShares":2400,"asOf":"2025-11-10"}'
```

**响应 200（对上了）**

```json
{
  "value": {
    "matched": true,
    "derivedShares": 2400,
    "claimedShares": 2400,
    "difference": 0,
    "lastMatchedOn": null,
    "fundCode": "000001",
    "asOf": "2025-11-10"
  },
  "reason": null,
  "source": "repository/reconcile",
  "dataAsOf": "2025-11-10",
  "capturedAt": "2026-11-20T16:45:00+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

**响应 200（对不上）**

```json
{
  "value": {
    "matched": false,
    "derivedShares": 800,
    "claimedShares": 900,
    "difference": -100,
    "lastMatchedOn": null,
    "fundCode": "011609",
    "asOf": "2025-11-10"
  },
  "reason": null,
  "source": "repository/reconcile",
  "dataAsOf": "2025-11-10",
  "capturedAt": "2026-11-20T16:45:00+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

- `difference = derivedShares − claimedShares`；为正说明**流水推出来的份额多于平台**
- `lastMatchedOn` 是本次对账之前已记录、且不晚于本次截止日的最后一个匹配日期。没有符合条件的记录时为 `null`。
- 比较用容差而非 `===`（浮点累计与平台四舍五入）
- 账本里没有这只基金的流水**也照常对账**：`derivedShares` 为 0、通常对不上。那是有效结论

**错误**：400 `对账缺少你实际持有的份额` / `对账缺少基金代码` / 代码格式错 / 日期格式错。

---

#### GET `/api/ledgers/:ledgerId/reconcile/last` — 上次对得上的日期

| 查询参数 | 必填 | 说明 |
|---|---|---|
| `fundCode` | 是 | 对账按基金进行，必须指明是哪只 |

```bash
curl -s "$B/api/ledgers/$LID/reconcile/last?fundCode=000001"
```

```json
{
  "value": { "fundCode": "000001", "lastMatchedOn": "2025-11-10" },
  "reason": null,
  "source": "repository/reconcile",
  "dataAsOf": "2025-11-10",
  "capturedAt": "2026-11-20T16:45:00+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

`lastMatchedOn: null` 表示**从未对得上**——这是事实而非失败，所以 `value` 不为 null、
`reason` 为空。前端应显示「尚未对平」，别当错误。

**错误**

| 状态 | 情形 | 响应 |
|---|---|---|
| 400 | 没给 `fundCode` | `{"error":"查询上次对账日期需要 fundCode（对账按基金进行）"}` |
| 400 | 代码格式错 | `{"error":"基金代码必须是 6 位数字，收到「abc」"}` |

---

### 4.2 市场数据（与账本无关）

| 方法 | 路径 |
|---|---|
| GET | `/api/funds?q=&category=&limit=` |
| GET | `/api/funds/categories` |
| GET | `/api/funds/:fundCode` |
| GET | `/api/funds/:fundCode/nav?startDate=&endDate=` |
| GET | `/api/funds/:fundCode/risk` |
| GET | `/api/funds/:fundCode/directions` |

> 路由注册顺序有讲究：静态段 `/api/funds/categories` 在参数段 `/api/funds/:fundCode` 之前，
> 否则 `categories` 会被当成基金代码。

---

#### GET `/api/funds` — 搜基金

| 查询参数 | 默认 | 说明 |
|---|---|---|
| `q` | 空（全部） | 同时匹配**代码 / 名称 / 拼音简写 / 拼音全拼**，大小写不敏感 |
| `category` | 无 | **精确匹配**数据源原值（如 `混合型-灵活`），不做归一化 |
| `limit` | 50 | 上限 200（超过按 200）；`0` 返回空列表；**负数或非整数是 400**，不会被静默当成 0 |

```bash
curl -s -G "$B/api/funds" --data-urlencode "q=华夏" --data-urlencode "limit=3"
```

```json
{
  "value": [
    { "code": "000001", "abbrev": "HXCZHH", "name": "华夏成长混合", "category": "混合型-灵活", "pinyin": "HUAXIACHENGZHANGHUNHE" },
    { "code": "000002", "abbrev": "HXCZHH", "name": "华夏成长混合(后端)", "category": "混合型-灵活", "pinyin": "HUAXIACHENGZHANGHUNHE" },
    { "code": "000011", "abbrev": "HXDPJXHHA", "name": "华夏大盘精选混合A", "category": "混合型-灵活", "pinyin": "HUAXIADAPANJINGXUANHUNHEA" }
  ],
  "reason": null,
  "source": "fundcode_search",
  "dataAsOf": "2026-11-20",
  "capturedAt": "2026-11-20T16:45:00+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

`category` 精确筛选（`--data-urlencode "category=混合型-灵活"`）返回同一形状的子集。
未知类型返回**空列表**，不是全部。

**错误**：400 `{"error":"limit 必须是非负整数，收到「abc」"}`

---

#### GET `/api/funds/categories` — 可选类型清单

**从实际数据聚合**出来的类型（数据源增删类型，这里自动跟上），按类型名排序。

```bash
curl -s "$B/api/funds/categories"
```

```json
{
  "value": [
    { "category": "", "count": 24 },
    { "category": "股票型", "count": 1157 },
    { "category": "混合型-绝对收益", "count": 38 },
    { "category": "混合型-灵活", "count": 2386 },
    { "category": "混合型-偏股", "count": 5856 },
    { "category": "混合型-偏债", "count": 1486 },
    "…（其余 27 个类型省略，含 债券型-* / 指数型-* / QDII-* / FOF-* / Reits 等）"
  ],
  "reason": null,
  "source": "fundcode_search",
  "dataAsOf": "2026-11-20",
  "capturedAt": "2026-11-20T16:45:00+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

注意**有一条 `category: ""`**（数据源里有 24 条没填类型），原样返回，让用户知道有这么一撮。

**错误**：无（除数据源全挂 → 500）。

---

#### GET `/api/funds/:fundCode` — 基金档案

```bash
curl -s "$B/api/funds/000001"
```

```json
{
  "value": {
    "benchmark": "中证800成长指数收益率*70%+中债-综合全价(总值)指数收益率*30%",
    "trackingTarget": "该基金无跟踪标的",
    "fields": {
      "基金全称": "华夏成长证券投资基金",
      "基金简称": "华夏成长混合",
      "基金代码": "000001（前端）、000002（后端）",
      "基金类型": "混合型-灵活",
      "发行日期": "2001年11月28日",
      "成立日期/规模": "2001年12月18日 / 32.368亿份",
      "净资产规模": "29.19亿元（截止至：2026年09月30日）",
      "份额规模": "23.8905亿份（截止至：2026年09月30日）",
      "基金管理人": "华夏基金",
      "基金托管人": "建设银行",
      "基金经理人": "郑晓辉、刘睿聪",
      "成立来分红": "每份累计2.57元（25次）",
      "管理费率": "1.20%（每年）",
      "托管费率": "0.20%（每年）",
      "销售服务费率": "---（每年）",
      "最高认购费率": "1.00%（前端）",
      "最高申购费率": "1.50%（前端）天天基金优惠费率：0.15%（前端）",
      "最高赎回费率": "1.50%（前端）",
      "业绩比较基准": "中证800成长指数收益率*70%+中债-综合全价(总值)指数收益率*30%",
      "跟踪标的": "该基金无跟踪标的"
    }
  },
  "reason": null,
  "source": "jbgk",
  "dataAsOf": "2026-11-20",
  "capturedAt": "2026-11-20T16:45:01+08:00",
  "stale": false,
  "loss": null,
  "provenance": []
}
```

- `benchmark` / `trackingTarget`：**原文**，服务端**不解析**权重（拆分口径未核实）
- `fields`：概况表其余字段的原文，数字与中文混排（「29.19亿元（截止至：…）」），**不拆**
- 「该基金无跟踪标的」是有效信息，**不是 null**——与「这页没抓到」必须分得开
- 概况没有天然时点，`dataAsOf` 取抓取日

**错误**

| 状态 | 情形 | 响应 |
|---|---|---|
| 400 | 代码不是 6 位数字 | `{"error":"基金代码必须是 6 位数字，收到「abc」"}` |
| 500 | 代码是 6 位但数据源全都失败（**包括代码根本不存在**） | `{"error":"服务器内部错误，请稍后重试"}` |

最后一行是当前的已知局限：**「基金不存在」与「数据源挂了」在这一层不可区分**，都表现为
500。详见「常见坑」。

---

#### GET `/api/funds/:fundCode/directions` — 基金投资方向

信封的 `value` 为标签数组。每个标签包含 `label`、`kind`、`reportDate` 和 `reference`。主题指数及宽基标签使用基金档案中的明确跟踪标的，产品类别使用档案分类，披露行业标签取最近一期公开行业配置，附实际报告期。无可核验方向时返回空数组，取数失败时返回 `null` 与原因。使用缓存时按信封的 `stale` 字段提示。

首批跟踪标的映射参考 [中证半导体行业精选指数编制方案](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/932066_Index_Methodology_cn.pdf)、[中证人工智能主题指数编制方案](https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/20231208175424-930713_Index_Methodology_cn.pdf) 和 [上证科创板50成份指数基本信息](https://www.sse.com.cn/market/sseindex/indexlist/basic/index.shtml?COMPANY_CODE=000688&INDEX_Code=000688&type=1)。

#### GET `/api/funds/:fundCode/nav` — 净值历史（两个口径）

| 查询参数 | 必填 | 说明 |
|---|---|---|
| `startDate` | 否 | `YYYY-MM-DD`，含 |
| `endDate` | 否 | `YYYY-MM-DD`，含；不得早于 `startDate` |

缺省取**全量**历史。注意：主源 `f10/lsjz` 的分页上限是 4000 条（约 16 年），
**老基金的全量历史会超出**，此时自动降级到 `pingzhongdata`——`source` 会变成
`pingzhongdata/Data_netWorthTrend`、`loss` 会说明丢失了分红/拆分事件字段。
窄区间查询不会触顶，优先用它拿事件。

```bash
curl -s "$B/api/funds/000001/nav?startDate=2021-12-13&endDate=2021-12-22"
```

这条区间特意选在一段分红记录附近（2021-12-17，每 10 份派 0.5 元），用来看两个口径的差别。

```json
{
  "nav": {
    "reason": null,
    "source": "f10/lsjz",
    "dataAsOf": "2021-12-22",
    "capturedAt": "2026-11-20T16:45:15+08:00",
    "stale": false,
    "loss": null,
    "provenance": [],
    "value": {
      "fundCode": "000001",
      "rows": [
        {
          "nav": { "kind": "nav", "value": 1.204, "date": "2021-12-22" },
          "accNav": 3.765,
          "growthRate": 0.58,
          "event": null
        },
        {
          "nav": { "kind": "nav", "value": 1.197, "date": "2021-12-21" },
          "accNav": 3.758,
          "growthRate": 0.67,
          "event": null
        },
        {
          "nav": { "kind": "nav", "value": 1.189, "date": "2021-12-20" },
          "accNav": 3.75,
          "growthRate": -1.57,
          "event": null
        },
        {
          "nav": { "kind": "nav", "value": 1.208, "date": "2021-12-17" },
          "accNav": 3.769,
          "growthRate": -1.18,
          "event": {
            "kind": "dividend",
            "perUnit": 0.05,
            "per10Unit": 0.5,
            "description": "每10份派现金0.5000元"
          }
        },
        {
          "nav": { "kind": "nav", "value": 1.273, "date": "2021-12-16" },
          "accNav": 3.784,
          "growthRate": 0.08,
          "event": null
        },
        "…（更早的日期省略）"
      ]
    }
  },
  "adjusted": {
    "reason": null,
    "source": "f10/lsjz",
    "dataAsOf": "2021-12-22",
    "capturedAt": "2026-11-20T16:45:15+08:00",
    "stale": false,
    "loss": null,
    "value": [
      { "kind": "nav", "value": 1.295, "date": "2021-12-13" },
      { "kind": "nav", "value": 1.291, "date": "2021-12-14" },
      { "kind": "nav", "value": 1.272, "date": "2021-12-15" },
      { "kind": "nav", "value": 1.273, "date": "2021-12-16" },
      { "kind": "nav", "value": 1.258, "date": "2021-12-17" },
      "…（更晚的日期省略）"
    ],
    "provenance": ["…（省略 1 个输入信封，即上面的 nav 历史）"]
  }
}
```

读法：

- `nav.value.rows`：**降序**（最新在前）。`nav.nav` 是带品牌的 `{ kind, value, date }`
- `adjusted.value`：**升序**，只有 `{ kind, value, date }`
- `event` 只在**主源** `f10/lsjz` 上可能出现；降级到备源后一律 `null`，同时 `loss` 会说明
- 复权失败（如分红口径矛盾）时 `adjusted.value: null` + `reason: "无法复权：…"`，
  但**原始净值照常返回**——数据问题不应表现为整条接口失败

**错误**

| 状态 | 情形 | 响应 |
|---|---|---|
| 400 | 代码不是 6 位数字 | `{"error":"基金代码必须是 6 位数字，收到「abc」"}` |
| 400 | `startDate` 晚于 `endDate` | `{"error":"startDate 不能晚于 endDate"}` |
| 400 | 日期格式错 | `{"error":"startDate 必须是 YYYY-MM-DD 格式，收到：2025/1/1"}` |
| 500 | 数据源全部失败 | `{"error":"服务器内部错误，请稍后重试"}` |

**必须校验日期**：数据源只把区间拼进上游 URL，非法格式可能被上游忽略而返回整段历史，
前端会拿到一个「静默超出请求区间」的序列。

---

#### GET `/api/funds/:fundCode/risk` — 单基金风险

描述**这只基金本身**的波动/回撤特征，与是否持有无关，所以路径不带 `ledgerId`。

```bash
curl -s "$B/api/funds/000001/risk"
```

```json
{
  "fundCode": "000001",
  "annualizedVolatility": {
    "value": 0.20957368720929767,
    "reason": null,
    "source": "pingzhongdata/Data_netWorthTrend",
    "dataAsOf": "2026-11-19",
    "capturedAt": "2026-11-20T16:43:56+08:00",
    "stale": false,
    "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
    "provenance": ["…（省略 1 个输入信封）"]
  },
  "downsideDeviation": {
    "value": 0.14832567960723803,
    "reason": null,
    "source": "pingzhongdata/Data_netWorthTrend",
    "dataAsOf": "2026-11-19",
    "capturedAt": "2026-11-20T16:43:56+08:00",
    "stale": false,
    "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
    "provenance": ["…（省略 1 个输入信封）"]
  },
  "maxDrawdown": {
    "value": 0.5907984827778675,
    "reason": null,
    "source": "pingzhongdata/Data_netWorthTrend",
    "dataAsOf": "2026-11-19",
    "capturedAt": "2026-11-20T16:43:56+08:00",
    "stale": false,
    "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
    "provenance": ["…（省略 1 个输入信封）"]
  },
  "drawdownRecoveryDays": {
    "value": 876,
    "reason": null,
    "source": "pingzhongdata/Data_netWorthTrend",
    "dataAsOf": "2026-11-19",
    "capturedAt": "2026-11-20T16:43:56+08:00",
    "stale": false,
    "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
    "provenance": ["…（省略 1 个输入信封）"]
  },
  "currentDrawdown": {
    "value": 0.4092852779474637,
    "reason": null,
    "source": "pingzhongdata/Data_netWorthTrend",
    "dataAsOf": "2026-11-19",
    "capturedAt": "2026-11-20T16:43:56+08:00",
    "stale": false,
    "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤",
    "provenance": ["…（省略 1 个输入信封）"]
  }
}
```

**注意：这个响应最外层没有信封**——它是一组指标，每项自己带信封（`Sourced<number|null>`）。
`fundCode` 是纯标识。

| 指标 | 含义 | 单位 |
|---|---|---|
| `annualizedVolatility` | 年化波动率（样本标准差 × √252） | 小数，`0.21` = 21% |
| `downsideDeviation` | 年化下行波动（目标收益 0） | 小数 |
| `maxDrawdown` | 最大回撤 | 非负幅度，`0.59` = 跌 59% |
| `drawdownRecoveryDays` | 最大回撤的修复天数；从未回撤或至今未修复为 `null` | 天 |
| `currentDrawdown` | 序列末点相对历史峰值的跌幅 | 非负幅度 |

**全部基于复权序列。** 复权取不到时五项一起 `value: null` + 同一条 `reason`
（`无法取得复权净值，风险指标不可计算`）；观测不足时 `reason` 是
`复权净值观测不足，样本方差无定义`。

**错误**：400 代码格式错；500 数据源全挂。

---

## 五、错误码表

响应形状有**两种**，前端要都能处理：

- **业务错误**（路由自己抛的、`core` 抛的）：`{"error": "可读中文"}`
- **框架错误**（404 路由不存在、请求体不是合法 JSON）：`{"statusCode": 404, "error": "Not Found", "message": "Route GET:/api/nope not found"}`

### `core` 的 `TypeError` 如何变成 HTTP

`core` 的报错是写给开发者的（「赎回 120 份但账面只有 100 份」），原样吐给用户看起来像
系统故障而不是录入错误。映射表只在 `apps/server/src/errors.ts` 一处，路由里不各写一遍。

| `core` 抛的原文 | HTTP | 用户看到的 |
|---|---|---|
| `赎回 120 份但账面只有 100 份，流水不完整：…` | 400 | 这笔赎回超过了账面份额，请先补录买入 |
| `必须给 sequence…` | 400 | 同一天有多笔流水，需要指定先后顺序 |
| `有重复的 sequence…` | 400 | 同一天的顺序号重复了 |
| `流水缺 sharesDelta…` / `流水缺 splitRatio…` | 400 | 这笔记账缺少份额 |
| **其他** `TypeError` | 400 | **原文**（不吞掉，否则排障只剩「内部错误」） |
| 非 `TypeError`（数据源故障等） | 500 | 服务器内部错误，请稍后重试 |

### 完整对照

| 状态 | 含义 | 例子 |
|---|---|---|
| 200 | 成功（对账「对不上」也是 200） | `matched: false` |
| 201 | 已创建 | 建账本、录流水 |
| 400 | 入参/调用方写错 | 日期格式错、缺份额、同日缺 sequence、超赎、`limit=abc` |
| 404 | 查错了对象 | `该账本没有这只基金的流水`；路由不存在（框架形状） |
| 500 | 服务端或数据源故障 | 外部接口全挂了；**6 位但不存在的基金代码也走这里** |

**500 时服务端不会把内部细节漏给前端**，但会打日志（`request.log.error`）——出事时看服务端日志，
不要指望从响应里读出原因。

---

## 六、常见坑

### 1. 成本未知时 `value: null`，不是 0

流水中没有买入记录（比如只录了一笔现金分红）时，`cost` / `costPerShare` / `unrealizedGain`
都是 `null` 并带原因，**绝不编 0**。0 会被当成真实成本去算盈亏，给出一个看着合理的假数。

```json
{
  "fundCode": "000011",
  "asOf": "2026-11-20",
  "shares": 0,
  "realizedGain": 1,
  "cost": {
    "value": null,
    "reason": "成本未知（流水中没有买入记录），只能做风险跟踪，不显示个人盈亏",
    "source": "repository/transaction",
    "dataAsOf": "2026-11-20",
    "capturedAt": "2026-11-20T16:49:22+08:00",
    "stale": false,
    "loss": null,
    "provenance": []
  },
  "costPerShare": {
    "value": null,
    "reason": "成本未知（流水中没有买入记录），只能做风险跟踪，不显示个人盈亏",
    "source": "repository/transaction",
    "dataAsOf": "2026-11-20",
    "capturedAt": "2026-11-20T16:49:22+08:00",
    "stale": false,
    "loss": null,
    "provenance": []
  },
  "marketValue": {
    "value": 0,
    "reason": null,
    "source": "pingzhongdata/Data_netWorthTrend",
    "dataAsOf": "2026-11-19",
    "capturedAt": "2026-11-20T16:48:20+08:00",
    "stale": false,
    "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
    "provenance": ["…（省略 1 个输入信封）"]
  },
  "unrealizedGain": {
    "value": null,
    "reason": "成本未知（流水中没有买入记录），只能做风险跟踪，不显示个人盈亏，无法计算浮动盈亏",
    "source": "repository/transaction；pingzhongdata/Data_netWorthTrend",
    "dataAsOf": "2026-11-19",
    "capturedAt": "2026-11-20T16:49:22+08:00",
    "stale": false,
    "loss": "净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）",
    "provenance": ["…（省略 2 个输入信封）"]
  }
}
```

顺带看这里：`marketValue.value` 是 **`0`**（份额真是 0，市值真是 0），而 `cost` 是 **`null`**
（不知道）。**0 和 null 是两个不同的答案**，前端不能一律 `?? 0`。

### 2. `provenance` 是什么，为什么响应会很大

`provenance` 是派生值的**各输入信封**，用来倒查「这个数是由哪几条序列、哪个时点算出来的」。
直接来自外部数据的值（如 `nav`）它是空数组。

**它会把整段输入原样带上。** 实测两个持仓的 `/positions` 响应 **2.3 MB**，因为 `marketValue`
的 `provenance` 里塞了 1362 行和 6048 行的净值历史；`/api/funds/000001/risk` 更是 **5 MB**
（5 个指标各带一份完整复权序列）。

当前实现的下限是：前端**不要**把整个响应塞进状态树，也不要逐行渲染 `provenance`；
只需要 `value` / `reason` / `stale` / `loss` / `dataAsOf`。这条也记在实现侧的待办里。

### 3. `loss` 非 null 意味着什么

意味着这个数来自**更弱的数据源**，字符串说明**失去了什么口径**。常见两种：

| `loss` 内容 | 场景 |
|---|---|
| `净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）` | 主源 `f10/lsjz` 挂了，降级到备源 |
| `…；复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤` | 上一条的后果：复权结果可能不干净 |

**这时数字仍然可用，但「复权」这个标签不能无条件相信。** 以 `stale: false` 的样子
呈现一条可能未真正复权的序列，正是要避免的事——所以 `loss` 必须显示。

### 4. `stale: true` 与 `loss` 不是一回事

- `stale: true`：外部源全挂了，响应来自**缓存里的旧值**。`dataAsOf` 会停在旧日期
- `loss` 非 null：数据是新的，但**口径弱**

缓存 TTL 内的正常命中**不算 stale**（数据本来就该是这个时点）。

### 5. 组合为空时返回 `value: null`，不是空对象

账本没有持仓（无流水，或份额全为 0）：

```json
{ "value": null, "reason": "该账本没有持仓", "source": "repository/transaction", … }
```

而**持仓列表**为空时是 `value: []`——列表的「没有」就是空列表，组合的「没有」是「算不出来」，
两者形状不同是有意的。

### 6. 不同账本接口对未知 `ledgerId` 的处理

`GET /api/ledgers/不存在/overview` → 404；
`GET /api/ledgers/不存在/positions` → 200 + `value: []`；
`POST /api/ledgers/不存在/transactions` → **201，并真的写进库**（`ledgerId` 没有外键约束）。

这是当前的实现形态，不是设计承诺。**前端必须先用 `GET /api/ledgers` 拿到真实存在的 ID**，
不要拼一个 ID 去写。这条记在实现侧的待办里。

### 7. 6 位但**不存在**的基金代码返回 500，不是 404

`/api/funds/123456` 与「数据源临时挂掉」在服务端不可区分（都表现为
`profile:123456 的全部数据源都失败了`），所以统一 500。

- 前端对 500 的文案不要写成「服务器错误」了事，应提示「查不到这只基金，或数据源暂时不可用」
- 这属于已知局限，见实现侧待办

`/api/funds/abc` 这种**格式错**的代码是 400，与前一条不同。

### 8. 组合风险的 `maxDrawdown` / `currentDrawdown` 可能出现 `value` 与 `reason` 同时非 null

按契约 `reason` 只在 `value: null` 时有值。抓取时发现组合风险这两个指标会同时给出
`value: 0.536…` 和 `reason: "复权净值不足两点，回撤无定义"`——实现里 `reason` 写死为该文案，
没有跟着 `value` 走。**以 `value` 为准**：`value` 非 null 时忽略 `reason`，把它当成空缺文案
（不是错误）。已记为实现侧待办，修之前别据此把数丢掉。

### 9. 同一天多笔流水必须给 `sequence`

```jsonc
// 第一笔（同日只有一笔时可省 sequence）
{ "fundCode": "011609", "date": "2025-12-05", "kind": "subscribe", "sharesDelta": 10, "amount": -10 }
// 第二笔同一天 → 400「同一天有多笔流水，需要指定先后顺序」
```

如果第一笔是唯一未编号的旧流水，补录第二笔时填 `1` 或更大，试算通过后会在同一个事务里把旧流水编号为 `0` 并保存新流水。**同日顺序不能靠请求到达顺序**：同样的「申购 + 折算」换序会算出不同份额
（100 与 200），而数据库取出来的顺序本就不保证。`sequence` 从 0 起、同日不重复、跨日无需连续。

### 10. 浮点数没有四舍五入

`2320.7999999999997`、`14.400000000000006` 都是真实返回值。服务端只做计算、不做显示格式化，
**前端负责保留小数位数**。不要对它们做 `===` 比较（对账用的是容差）。

### 11. `amount` 的符号：流向账本为正

| kind | `amount` 符号 | 举例 |
|---|---|---|
| `subscribe` | **负**（钱离开你） | 花 2400 元买入 → `-2400` |
| `redeem` | 正（到账额，已扣赎回费） | `214.4` |
| `dividend_cash` | 正 | `36.5` |
| `dividend_reinvest` | 正 | 再投金额 |
| `split` | 一般给 `0`（不改金额） | `0` |

填反了不会报错，但成本、已实现收益、XIRR 全部反向——这是**不会报错的错账**，只能靠对账发现。

### 12. 净值序列的方向不同

`nav.value.rows` 降序（最新在前），`adjusted.value` 升序。拼图时别假设同向。

### 13. 持仓 / XIRR **不接受** `asOf` 查询参数

按**今天（中国时区）**推。传了 `?asOf=2025-01-01` 会被静默忽略，返回的仍是今天的数（响应里的
`asOf` 字段会告诉你实际用的是哪天）。想回看历史持仓目前没有接口——这条记在实现侧待办里。

### 14. 「数据取不到」与「你没有这类数据」必须分开

- 该基金在账本里一笔流水都没有 → **404**（查错了对象）
- 该基金有流水但已全部赎回 → **200** + `shares: 0`，`realizedGain` 照常给
- 该基金有流水但净值取不到 → **200** + `marketValue.value: null` + `reason`

前端不要把这三种情况都渲染成「—」。

---

## 附：完整端点清单

| # | 方法 | 路径 | 归属 |
|---|---|---|---|
| 1 | GET | `/api/ledgers` | 账本 |
| 2 | POST | `/api/ledgers` | 账本 |
| 3 | POST | `/api/ledgers/:ledgerId/transactions` | 账本 |
| 4 | GET | `/api/ledgers/:ledgerId/positions` | 账本 |
| 5 | GET | `/api/ledgers/:ledgerId/positions/:fundCode` | 账本 |
| 6 | GET | `/api/ledgers/:ledgerId/funds/:fundCode/return` | 账本 |
| 7 | GET | `/api/ledgers/:ledgerId/portfolio/risk` | 账本 |
| 8 | POST | `/api/ledgers/:ledgerId/reconcile` | 账本 |
| 9 | GET | `/api/ledgers/:ledgerId/reconcile/last` | 账本 |
| 10 | GET | `/api/funds` | 市场 |
| 11 | GET | `/api/funds/categories` | 市场 |
| 12 | GET | `/api/funds/:fundCode` | 市场 |
| 13 | GET | `/api/funds/:fundCode/nav` | 市场 |
| 14 | GET | `/api/funds/:fundCode/risk` | 市场 |
| 15 | GET | `/api/ledgers/:ledgerId/overview` | 账本 |
| 16 | GET | `/api/funds/:fundCode/directions` | 市场 |
