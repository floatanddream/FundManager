# 核心风险指标 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@fundmanager/core` 内实现组合风险指标：年化波动率、最大回撤及回撤修复期、当前回撤、下行波动、滚动持有收益分布、相关性矩阵。全部为纯函数，全部由手算用例验证。

**Architecture:** `core` 是纯函数库：不 import 任何框架，不做任何 IO，不读时间（不调 `Date.now()`，当前日期由调用方以序列末点传入）。所有输入显式传入。风险计算的输入类型一律是 `NavConfirmed[]`（`@fundmanager/shared`），估算与场内价在编译期就传不进来——这是「三种价格隔离」机制（`CONSTRAINTS/04-hard-rules.md` §4 规则 1）在风险域的落地。

**Tech Stack:** TypeScript 7（strict，ESM）· Vitest 5 · Node 24 原生执行 `.ts`（无构建步骤）· pnpm workspace

**Spec:** `docs/CONSTRAINTS/README.md` §8（代码风格，本计划直接落实）· §4 规则 1（三种价格类型隔离）· §8.3（错误分类）· `AGENTS.md` · 计划 1（`docs/superpowers/plans/2026-11-17-core-contracts-and-returns.md`）

## Global Constraints

- TypeScript strict，ESM（`"type": "module"`）。**不使用装饰器**——Node 原生执行 `.ts` 会 `SyntaxError`
- **相对导入必须带 `.ts` 后缀**（如 `import { dailyReturns } from './series.ts'`）。**不能用 `.js`**——实测 Node 报 `ERR_MODULE_NOT_FOUND`。这与 TypeScript 官方推荐相反，但本项目无构建步骤、由 Node 直接执行，只能如此
- **不使用 `baseUrl`**（TypeScript 7 已移除，用了会 `TS5102`）
- **包的出口用显式列名导出，不用 `export *`**（`CONSTRAINTS/08-code-style.md` §8.4）
- `packages/core` **不 import 任何框架、不做任何 IO、不读时间**，全部为纯函数（§8.5）
- **风险计算的输入一律是 `NavConfirmed[]`**，估算值（`NavEstimate`）与场内价（`MarketPrice`）在编译期不得进入（§4 规则 1）。**不用 `number[]` 裸净值**
- **金额、净值、份额的比较一律用 `approxEqual`，禁止 `===`**（§8.1）
- **业务代码只许 `YYYY-MM-DD` 字符串**，带时间的日期字符串禁止进入业务逻辑（§8.2）
- **错误分类**（§8.3）：数学上无解 → 返回 `null`；参数非法 → 抛异常（`TypeError`）；数据缺失 → 返回 `null`
- **导出的公共函数用 JSDoc；会抛异常的必须写 `@throws`**，说明何种情况抛（§8.7）
- 代码注释与用户可见文案用中文；标识符用英文
- 测试文件与被测文件同目录，命名 `*.test.ts`，**测试名用中文**
- **每个任务以「测试全绿 → 提交」为完成标志**。提交边界与任务边界一致
- **提交信息不得包含任何工具署名行**（指向 AI 工具的署名行、自动生成标注、机器人 emoji 一律不加），只写改动本身
- **提交只 `git add` 本任务文件，禁止 `git add -A`**——同一工作目录可能有其他 agent 的在途改动，`-A` 会把它们一起卷进本次提交
- **执行方式：subagent 驱动**——每个任务派全新 subagent 实现，再由全新 reviewer 审查（依据 `superpowers:requesting-code-review`，需 git SHA），通过后才进下一个任务
- 计划 1 已建立并可直接消费：`packages/shared` 导出 `approxEqual`、`assertDate`、`daysBetween`、`NavConfirmed`、`navConfirmed`、`isConfirmed`；`packages/core/src/index.ts` 已导出收益计算

### 术语与符号约定

`docs/CONSTRAINTS/README.md` 未涵盖，由本计划确立，**后续计划沿用**：

| 量 | 符号 | 说明 |
|---|---|---|
| 收益率（日收益、区间收益、XIRR/TWR） | **有符号** | 亏损为负 |
| 年化波动率、下行波动 | **非负** | 波动是幅度，没有方向 |
| **最大回撤、当前回撤** | **非负幅度** | `0.5` 即跌 50%。「回撤」一词本身已表明方向，展示层不必再加负号 |
| 回撤修复期 | **非负天数**（单位：天） | 谷底 → 收复前高。从未回撤时返回 `null` |
| 相关性 | **`[-1, 1]`** | 基于简单收益，与波动率、下行波动同口径 |

**为什么要把这条写死：** 同一张风险表里会并排出现「年化波动率 41%」「最大回撤 58%」「近 1 年收益 −10%」。若各函数对符号各取所需，展示层就要在每处判断该不该加负号——那正是出错的地方。统一一次，之后全省。

## Review Focus

以下五类输入或失败模式，规格未逐一写明，但最可能在实际使用中咬人。每条都在所属任务里配了测试。

1. **净值序列日期乱序或重复**——相邻日收益按输入顺序相除，乱序会把不相邻的两天收益算在一起，结果静默错误。必须抛 `TypeError`，不能默默排序或照算
2. **收益观测不足**（净值点少于 3 个，即收益观测少于 2 个）——样本标准差的分母是 `n − 1`，此时为 0；下行波动的「分布」也无意义。必须返回 `null`，**不能返回 0**（0 会被误读为「无风险」）
3. **恒定净值序列（波动率为 0）**——相关性公式的分母含标准差之积，为 0 时相关系数无定义。必须返回 `null`，**不能返回 `NaN` 或 0**
4. **回撤尚未修复**——序列结束时净值仍低于前高，修复期无解。必须返回 `null`，**不能用序列末日期顶替**（那会把「还在亏」谎报成「已修复」）
5. **滚动窗口落在非连续交易日上**（停牌、节假日造成日期跳空）——窗口终点必须取「日期 ≥ 起点 + N 日历天」的**第一个观测**，不能按固定索引取第 N 个点

**未覆盖（已知，记为遗留项）：** 方差/回撤在极短序列上数值本就不稳，本计划只保证 2 个收益观测起不返回 `NaN`，不对「多少观测才有统计意义」设阈值——那是展示层策略（计划 5/6）。

## 已裁决项（2026-11-18 控制方裁定，全部采纳下列推荐）

> 原为「待定项」。控制方逐条复核后**全部采纳推荐值**——每条都有依据，且无一条与既有约定冲突。
> 本表从「待确认」转为「已生效」，实现者按此执行，不再等待确认。
>
> **三处用户可影响的量已做成参数**，将来想改不必重写代码：
> 滚动档位由调用方传入；相关性窗口与年化因子是函数选项。

| # | 问题 | 推荐 | 理由 | 备选 |
|---|---|---|---|---|
| 1 | 滚动持有收益分布取哪几档时间窗 | **30 / 90 / 180 / 365 天** | 分别对应约 1 月 / 1 季 / 半年 / 1 年，覆盖短中长期持有视角，且与「持有满一年」的用户直觉对齐。函数本身不限档位，档位由调用方传入 | 7 / 30 / 365（更粗）；以交易日计数（`20/60/120/250`）——与「持有 N 天」的日历语义不符，不推荐 |
| 2 | 相关性矩阵用什么窗口 | **可配，默认 250 交易日**（≈ 1 年） | 全历史会把早年风格漂移混进来，60 日噪声又太大；250 是稳定性与时效性的平衡点。函数保留 `window` 选项 | 全历史；固定 60 日；120 日 |
| 3 | 波动率频率与年化因子 | **日频 × √252** | 净值本身是日频；252 是 A 股年均交易日惯例，与券商口径一致。年化因子做成可配（`periodsPerYear`） | 周频 × √52（降噪但样本骤减）；×√250 |
| 4a | 回撤修复期的起算点 | **谷底 → 收复** | 「多久收复」问的是从最低点爬回前高用了多久，谷底起算最贴合语义 | 峰值 → 收复（整段水下时长） |
| 4b | 回撤/当前回撤的符号 | **非负幅度**（`0.5` = 跌 50%） | 与「最大回撤 50%」的口头表述一致，出负号易在展示层二次出错 | 负值（`-0.5`） |
| 4c | 下行波动的目标收益率与分母 | **target 默认 0；分母用全部观测数 `n`** | 这是标准下行偏差 / Sortino 口径；分母改为「仅下跌观测数」会随目标值敏感跳变 | target 取无风险利率；分母用下跌观测数 |
| 4d | 波动率用样本还是总体标准差 | **样本（÷ `n − 1`）** | 日收益是总体的一段样本，金融惯例用样本标准差 | 总体（÷ `n`） |
| 4e | 「从未发生回撤」时修复期返回值 | **`null`**（无回撤 → 无修复期这一说） | 符合 §8.3「数学上无解返回 `null`」；返回 0 会被误读为「立刻修复」 | 返回 0 |
| 4f | 滚动持有窗口按日历天还是交易日 | **日历天** | 「持有 365 天 = 一年」是日历语义；交易日计数会让「365 天」变成约 1.45 年 | 交易日计数 |
| 4g | 相关性用简单收益还是对数收益 | **简单收益**（与波动率、下行波动一致） | 全库统一一种收益口径，避免混用 | 对数收益 |

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/core/src/risk/series.ts` | 净值序列校验（升序、正数）与日收益序列（新增） |
| `packages/core/src/risk/series.test.ts` | 上述的测试（新增） |
| `packages/core/src/risk/volatility.ts` | 年化波动率、下行波动（新增） |
| `packages/core/src/risk/volatility.test.ts` | 上述的测试（新增） |
| `packages/core/src/risk/drawdown.ts` | 最大回撤、回撤修复期、当前回撤（新增） |
| `packages/core/src/risk/drawdown.test.ts` | 上述的测试（新增） |
| `packages/core/src/risk/rolling.ts` | 滚动持有收益分布（新增） |
| `packages/core/src/risk/rolling.test.ts` | 上述的测试（新增） |
| `packages/core/src/risk/correlation.ts` | 相关性矩阵（新增） |
| `packages/core/src/risk/correlation.test.ts` | 上述的测试（新增） |
| `packages/core/src/index.ts` | 包出口，追加风险指标导出（修改） |

---

### Task 1: 净值序列校验与日收益序列

**Files:**
- Create: `packages/core/src/risk/series.ts`
- Test: `packages/core/src/risk/series.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `assertDate`（`@fundmanager/shared`）· 类型 `NavConfirmed`（`@fundmanager/shared`）
- Produces:
  - `assertNavSeries(series: readonly NavConfirmed[], label?: string): void`
  - `dailyReturns(series: readonly NavConfirmed[]): number[]`

**定义（按此写）：**

- `assertNavSeries`：逐点校验——`date` 合法（经 `assertDate`）、`value` 有限且 `> 0`；且相邻点**日期严格递增**（`series[i].date > series[i-1].date`，`'YYYY-MM-DD'` 可直接字符串比较）。任一违反抛 `TypeError`
- `dailyReturns`：先调 `assertNavSeries`，再对 `i >= 1` 求 `r_i = value_i / value_{i-1} - 1`。序列不足 2 点返回 `[]`
- `assertNavSeries` **不导出到包出口**（它是内部不变式），但按模块级 `export` 供同包其它文件 `./series.ts` 直接引用

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/src/risk/series.test.ts`：

```ts
import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { assertNavSeries, dailyReturns } from './series.ts'

/** 用数值数组与等距日期快速搭一条确认净值序列，日期从 2024-01-01 起逐日递增 */
const series = (values: readonly number[]): ReturnType<typeof navConfirmed>[] =>
  values.map((v, i) => navConfirmed(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

it('按 value_i / value_{i-1} - 1 计算日收益', () => {
  // 1 → 2 → 1 → 3：收益分别为 +100%、-50%、+200%
  expect(dailyReturns(series([1, 2, 1, 3]))).toEqual([1, -0.5, 2])
})

it('不足两点返回空数组', () => {
  expect(dailyReturns([])).toEqual([])
  expect(dailyReturns(series([1.5]))).toEqual([])
})

it('日期乱序或重复抛异常（Review Focus #1）', () => {
  // 乱序：第二点 01-01 早于第一点 01-02；重复：两点同日
  expect(() => dailyReturns([navConfirmed(1, '2024-01-02'), navConfirmed(2, '2024-01-01')])).toThrow(TypeError)
  expect(() => dailyReturns([navConfirmed(1, '2024-01-01'), navConfirmed(2, '2024-01-01')])).toThrow(TypeError)
})

it('净值非正或非有限数抛异常', () => {
  expect(() => dailyReturns(series([1, 0]))).toThrow(TypeError)
  expect(() => dailyReturns(series([1, -0.5]))).toThrow(TypeError)
  expect(() => dailyReturns(series([1, Number.NaN]))).toThrow(TypeError)
  expect(() => dailyReturns(series([1, Number.POSITIVE_INFINITY]))).toThrow(TypeError)
})

it('assertNavSeries 接受合法序列、拒绝非法日期', () => {
  expect(() => assertNavSeries(series([1, 1.5, 1.25]), 'test')).not.toThrow()
  // 绕过 navConfirmed 直接构造，模拟未走构造函数的数据
  expect(() => assertNavSeries([{ kind: 'nav', value: 1, date: '2024/01/01' }])).toThrow(TypeError)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/risk/series.test.ts`
Expected: FAIL —— `Failed to resolve import "./series.ts"`

- [ ] **Step 3: 实现 `series.ts`**

```ts
import { assertDate } from '@fundmanager/shared'
import type { NavConfirmed } from '@fundmanager/shared'

/**
 * 校验确认净值序列：日期合法且严格升序、净值有限且为正。
 *
 * 风险指标全部建立在这一前提上——乱序会让相邻日收益算错，
 * 非正净值会让回撤、相关性失去意义。与其让坏数据算出个像模像样的错数，
 * 不如在入口就拦住。
 *
 * @param series 待校验的序列
 * @param label 出错时用于定位的字段名，默认 `series`
 * @throws {TypeError} 任一 date 非法、净值非有限数或 <= 0，或日期未严格升序
 */
export function assertNavSeries(series: readonly NavConfirmed[], label = 'series'): void {
  for (let i = 0; i < series.length; i++) {
    const point = series[i]!
    assertDate(point.date, `${label}[${i}].date`)
    if (!Number.isFinite(point.value) || point.value <= 0) {
      throw new TypeError(`${label}[${i}] 的净值必须是有限正数，收到：${point.value}`)
    }
    // 'YYYY-MM-DD' 定长零填充，字符串比较即日期比较
    if (i > 0 && point.date <= series[i - 1]!.date) {
      throw new TypeError(
        `${label} 必须按日期严格升序，第 ${i} 点 ${point.date} 未晚于前一点 ${series[i - 1]!.date}`,
      )
    }
  }
}

/**
 * 由确认净值序列求相邻日简单收益率：r_i = value_i / value_{i-1} - 1。
 *
 * 波动率、下行波动、相关性都以它为基。序列不足 2 点时没有收益可言，返回空数组。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @returns 收益率数组，长度 = 序列长度 - 1；不足 2 点返回 `[]`
 * @throws {TypeError} 序列非法（见 assertNavSeries）
 */
export function dailyReturns(series: readonly NavConfirmed[]): number[] {
  assertNavSeries(series)
  const returns: number[] = []
  for (let i = 1; i < series.length; i++) {
    returns.push(series[i]!.value / series[i - 1]!.value - 1)
  }
  return returns
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/risk/series.test.ts`
Expected: PASS，5 个测试通过

- [ ] **Step 5: 更新包出口**

在 `packages/core/src/index.ts` 末尾追加（`assertNavSeries` 是内部不变式，不导出）：

```ts
export { dailyReturns } from './risk/series.ts'
```

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 计划 1 的 45 个 + 本任务 5 个 = 50 个测试通过，类型检查无错误

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/risk/series.ts packages/core/src/risk/series.test.ts packages/core/src/index.ts
git commit -F - <<'EOF'
feat(core): 净值序列校验与日收益序列

风险指标的前置：日期严格升序、净值有限且为正，否则入口即拦。
乱序会让相邻日收益算错，非正净值让回撤与相关性失去意义。

dailyReturns 求相邻日简单收益，供波动率、下行波动、相关性复用。

EOF
```

---

### Task 2: 年化波动率与下行波动

**Files:**
- Create: `packages/core/src/risk/volatility.ts`
- Test: `packages/core/src/risk/volatility.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `dailyReturns`（`./series.ts`）· 类型 `NavConfirmed`（`@fundmanager/shared`）
- Produces:
  - `annualizedVolatility(series: readonly NavConfirmed[], options?: { periodsPerYear?: number }): number | null`
  - `downsideDeviation(series: readonly NavConfirmed[], options?: { target?: number; periodsPerYear?: number }): number | null`

**定义（按此写）：**

- 年化因子常量 `TRADING_DAYS_PER_YEAR = 252`；选项 `periodsPerYear` 默认取它
- `annualizedVolatility`：`returns = dailyReturns(series)`；若 `returns.length < 2` 返回 `null`；均值 `μ = Σr / n`；**样本方差** `σ² = Σ(r − μ)² / (n − 1)`；返回 `√σ² × √periodsPerYear`
- `downsideDeviation`：`target` 默认 `0`；若 `returns.length < 2` 返回 `null`；`D = √( Σ min(r_i − target, 0)² / n )`（**分母为全部观测数 `n`**，不是下跌观测数）；返回 `D × √periodsPerYear`
- 非法参数（`periodsPerYear <= 0`、`target` 非有限数）抛 `TypeError`

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/src/risk/volatility.test.ts`：

```ts
import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { annualizedVolatility, downsideDeviation } from './volatility.ts'

/** 从 2024-01-01 起逐日递增地搭一条确认净值序列 */
const series = (values: readonly number[]): ReturnType<typeof navConfirmed>[] =>
  values.map((v, i) => navConfirmed(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

// 日收益恰为 [0.5, 0, -0.5]，全是二进制精确值，可手算
const sample = series([1, 1.5, 1.5, 0.75])
const rising = series([1, 1.5, 2.25])

it('年化波动率 = 日收益样本标准差 × √年化因子', () => {
  // 均值 0；样本方差 = (0.25 + 0 + 0.25) / (3-1) = 0.25 → 标准差 0.5
  expect(annualizedVolatility(sample)).toBeCloseTo(0.5 * Math.sqrt(252), 10)
  // 因子 1 时不再放大，就是日标准差 0.5
  expect(annualizedVolatility(sample, { periodsPerYear: 1 })).toBeCloseTo(0.5, 10)
})

it('恒定收益率序列波动率为 0', () => {
  // 1 → 1.5 → 2.25：日收益恒为 0.5，样本方差为 0
  expect(annualizedVolatility(rising)).toBe(0)
})

it('收益观测不足 2 个 → null，不返回 0（Review Focus #2）', () => {
  expect(annualizedVolatility([])).toBeNull()
  expect(annualizedVolatility(series([1]))).toBeNull()
  // 两点只有 1 个收益观测，样本标准差分母 n-1 = 0
  expect(annualizedVolatility(series([1, 2]))).toBeNull()
  expect(downsideDeviation([])).toBeNull()
  expect(downsideDeviation(series([1]))).toBeNull()
  expect(downsideDeviation(series([1, 1.5]))).toBeNull()
})

it('下行波动只惩罚低于目标的收益', () => {
  // target 0：min(0.5,0)²=0、min(0,0)²=0、min(-0.5,0)²=0.25 → /3 ×252 = 21
  expect(downsideDeviation(sample)).toBeCloseTo(Math.sqrt(21), 10)
  // target 0.5：min(0,0)²=0、min(-0.5,0)²=0.25、min(-1.0,0)²=1.0 → 和 1.25，/3 ×252 = 105
  expect(downsideDeviation(sample, { target: 0.5 })).toBeCloseTo(Math.sqrt(105), 10)
  // 全程收益不低于目标 → 无下行偏差
  expect(downsideDeviation(rising)).toBe(0)
})

it('非法选项参数抛异常', () => {
  expect(() => annualizedVolatility(sample, { periodsPerYear: 0 })).toThrow(TypeError)
  expect(() => annualizedVolatility(sample, { periodsPerYear: -1 })).toThrow(TypeError)
  expect(() => downsideDeviation(sample, { target: Number.NaN })).toThrow(TypeError)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/risk/volatility.test.ts`
Expected: FAIL —— `Failed to resolve import "./volatility.ts"`

- [ ] **Step 3: 实现 `volatility.ts`**

```ts
import type { NavConfirmed } from '@fundmanager/shared'
import { dailyReturns } from './series.ts'

/** A 股年均交易日。年化按 √252 放大，与券商口径一致。 */
const TRADING_DAYS_PER_YEAR = 252

/** 选项里年化因子必须为正，否则年化不成立 */
function assertPeriodsPerYear(periodsPerYear: number): void {
  if (!(periodsPerYear > 0)) {
    throw new TypeError(`periodsPerYear 必须是正数，收到：${periodsPerYear}`)
  }
}

/**
 * 年化波动率：日收益的样本标准差（÷ n−1）× √periodsPerYear。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @param options.periodsPerYear 年化因子，默认 252（A 股年均交易日）
 * @returns 年化波动率；收益观测不足 2 个（净值点不足 3 个）时返回 null
 * @throws {TypeError} 序列非法（透传 assertNavSeries），或 periodsPerYear 非正
 */
export function annualizedVolatility(
  series: readonly NavConfirmed[],
  options: { periodsPerYear?: number } = {},
): number | null {
  const periodsPerYear = options.periodsPerYear ?? TRADING_DAYS_PER_YEAR
  assertPeriodsPerYear(periodsPerYear)
  const returns = dailyReturns(series)
  // 样本方差分母 n−1；不足 2 个观测时无定义——返回 0 会被误读为「无风险」
  if (returns.length < 2) return null
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear)
}

/**
 * 下行波动：只惩罚低于目标收益的偏差，再年化。
 *
 * 分母用全部观测数 n（标准下行偏差 / Sortino 口径）——改成「仅下跌观测数」
 * 会随目标值敏感跳变。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @param options.target 目标收益率（MAR），默认 0
 * @param options.periodsPerYear 年化因子，默认 252
 * @returns 年化下行波动；收益观测不足 2 个时返回 null
 * @throws {TypeError} 序列非法、target 非有限数，或 periodsPerYear 非正
 */
export function downsideDeviation(
  series: readonly NavConfirmed[],
  options: { target?: number; periodsPerYear?: number } = {},
): number | null {
  const target = options.target ?? 0
  const periodsPerYear = options.periodsPerYear ?? TRADING_DAYS_PER_YEAR
  if (!Number.isFinite(target)) {
    throw new TypeError(`target 必须是有限数，收到：${target}`)
  }
  assertPeriodsPerYear(periodsPerYear)
  const returns = dailyReturns(series)
  if (returns.length < 2) return null
  // 高于目标的部分记 0：下行波动只关心「没达到目标」的幅度
  const sumSquares = returns.reduce((sum, r) => sum + Math.min(r - target, 0) ** 2, 0)
  return Math.sqrt(sumSquares / returns.length) * Math.sqrt(periodsPerYear)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/risk/volatility.test.ts`
Expected: PASS，5 个测试通过

- [ ] **Step 5: 更新包出口**

在 `packages/core/src/index.ts` 末尾追加：

```ts
export { annualizedVolatility, downsideDeviation } from './risk/volatility.ts'
```

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 55 个测试通过（50 + 5），类型检查无错误

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/risk/volatility.ts packages/core/src/risk/volatility.test.ts packages/core/src/index.ts
git commit -F - <<'EOF'
feat(core): 年化波动率与下行波动

年化波动率用日收益样本标准差（÷ n-1）× √252。
下行波动只惩罚低于目标的部分，分母用全部观测数——标准 Sortino 口径。

收益观测不足 2 个时返回 null 而非 0：0 会被误读成「无风险」。

EOF
```

---

### Task 3: 最大回撤、回撤修复期、当前回撤

**Files:**
- Create: `packages/core/src/risk/drawdown.ts`
- Test: `packages/core/src/risk/drawdown.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `assertNavSeries`（`./series.ts`）· `daysBetween`、类型 `NavConfirmed`（`@fundmanager/shared`）
- Produces:
  - `maxDrawdown(series: readonly NavConfirmed[]): number | null`
  - `drawdownRecoveryDays(series: readonly NavConfirmed[]): number | null`
  - `currentDrawdown(series: readonly NavConfirmed[]): number | null`

**定义（按此写）：**

- 所有返回值是**非负幅度**（`0.5` 表示跌 50%）
- `maxDrawdown`：滑动峰值 `peak = max(截至当前的净值)`，逐点算 `(peak − value) / peak`，取最大。序列不足 2 点返回 `null`
- `drawdownRecoveryDays`：先定位**首次**出现最大回撤的峰值索引 `p` 与谷底索引 `t`（逐点用 `>` 比较，等值时不覆盖，保证取首次）。若最大回撤为 0（从未回撤）返回 `null`。从 `t + 1` 起找第一个 `value >= series[p].value` 的索引 `r`，返回 `daysBetween(series[t].date, series[r].date)`；找不到（未修复）返回 `null`。序列不足 2 点返回 `null`
- `currentDrawdown`：历史峰值与**序列末点**的差，`(peak − last) / peak`。序列不足 2 点返回 `null`
- 三者的非法序列（乱序/重复/非正净值）均透传 `assertNavSeries` 的 `TypeError`

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/src/risk/drawdown.test.ts`：

```ts
import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { currentDrawdown, drawdownRecoveryDays, maxDrawdown } from './drawdown.ts'

/** 从 2024-01-01 起逐日递增地搭一条序列 */
const series = (values: readonly number[]): ReturnType<typeof navConfirmed>[] =>
  values.map((v, i) => navConfirmed(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

it('最大回撤取峰值到谷底的最大跌幅', () => {
  // [1, 2, 1, 3]：峰值 2 → 谷底 1，跌幅 (2-1)/2 = 0.5
  expect(maxDrawdown(series([1, 2, 1, 3]))).toBe(0.5)
  expect(maxDrawdown(series([1, 2, 3]))).toBe(0) // 单调上升无回撤
})

it('序列不足两点 → null', () => {
  expect(maxDrawdown([])).toBeNull()
  expect(maxDrawdown(series([1]))).toBeNull()
  expect(drawdownRecoveryDays(series([1]))).toBeNull()
  expect(currentDrawdown([])).toBeNull()
  expect(currentDrawdown(series([1]))).toBeNull()
})

it('日期乱序抛异常（Review Focus #1）', () => {
  expect(() => maxDrawdown([navConfirmed(1, '2024-01-02'), navConfirmed(2, '2024-01-01')])).toThrow(TypeError)
})

it('[1, 2, 1, 1, 1, 2] 的回撤修复期是 3 天', () => {
  // 峰值 01-02（值 2）→ 谷底 01-03（值 1）→ 01-06 回到 2，daysBetween 为 3
  expect(drawdownRecoveryDays(series([1, 2, 1, 1, 1, 2]))).toBe(3)
})

it('修复期无解时返回 null（从未回撤或结束时仍未修复）', () => {
  expect(drawdownRecoveryDays(series([1, 2, 3]))).toBeNull() // 从未回撤
  // 峰值 2 在 01-02，谷底 1 在 01-03，此后一直没回到 2（Review Focus #4）
  expect(drawdownRecoveryDays(series([1, 2, 1, 1]))).toBeNull()
})

it('当前回撤 = (历史峰值 − 末点) / 峰值', () => {
  expect(currentDrawdown(series([1, 2, 1, 1.5]))).toBe(0.25) // 峰值 2，末点 1.5
  expect(currentDrawdown(series([1, 2, 1, 3]))).toBe(0) // 末点即历史峰值
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/risk/drawdown.test.ts`
Expected: FAIL —— `Failed to resolve import "./drawdown.ts"`

- [ ] **Step 3: 实现 `drawdown.ts`**

```ts
import { daysBetween } from '@fundmanager/shared'
import type { NavConfirmed } from '@fundmanager/shared'
import { assertNavSeries } from './series.ts'

/**
 * 最大回撤：历史峰值到后续谷底的最大跌幅。返回非负幅度（0.5 表示跌 50%）。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @returns 最大回撤；不足 2 点返回 null
 * @throws {TypeError} 序列非法（透传 assertNavSeries）
 */
export function maxDrawdown(series: readonly NavConfirmed[]): number | null {
  assertNavSeries(series)
  if (series.length < 2) return null
  let peak = series[0]!.value
  let worst = 0
  for (const point of series) {
    if (point.value > peak) peak = point.value
    const drawdown = (peak - point.value) / peak
    if (drawdown > worst) worst = drawdown
  }
  return worst
}

/**
 * 最大回撤的修复期：从回撤谷底回到前一个峰值所花的日历天数。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @returns 修复所需天数；从未回撤或结束时仍未修复均返回 null
 * @throws {TypeError} 序列非法（透传 assertNavSeries）
 */
export function drawdownRecoveryDays(series: readonly NavConfirmed[]): number | null {
  assertNavSeries(series)
  if (series.length < 2) return null

  // 定位首次出现最大回撤的峰值索引与谷底索引。用严格 >，
  // 等值时保留先出现的那个，保证「首次」
  let peak = series[0]!.value
  let peakIndex = 0
  let worst = 0
  let troughIndex = -1
  let troughPeakIndex = -1
  for (let i = 0; i < series.length; i++) {
    const value = series[i]!.value
    if (value > peak) {
      peak = value
      peakIndex = i
    }
    const drawdown = (peak - value) / peak
    if (drawdown > worst) {
      worst = drawdown
      troughIndex = i
      troughPeakIndex = peakIndex
    }
  }
  // 从未回撤 → 没有「修复期」这一说
  if (worst <= 0) return null

  const peakValue = series[troughPeakIndex]!.value
  // 从谷底之后找第一个回到峰值水平的点
  for (let i = troughIndex + 1; i < series.length; i++) {
    if (series[i]!.value >= peakValue) {
      return daysBetween(series[troughIndex]!.date, series[i]!.date)
    }
  }
  // 结束时仍在水下 → 答案不存在，不能用末日期顶替（会把「还在亏」谎报成「已修复」）
  return null
}

/**
 * 当前回撤：序列末点相对历史峰值的跌幅。返回非负幅度。
 *
 * 当前日期由调用方以序列末点给出——core 不读时间。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @returns 当前回撤；不足 2 点返回 null
 * @throws {TypeError} 序列非法（透传 assertNavSeries）
 */
export function currentDrawdown(series: readonly NavConfirmed[]): number | null {
  assertNavSeries(series)
  if (series.length < 2) return null
  let peak = series[0]!.value
  for (const point of series) {
    if (point.value > peak) peak = point.value
  }
  return (peak - series[series.length - 1]!.value) / peak
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/risk/drawdown.test.ts`
Expected: PASS，6 个测试通过

- [ ] **Step 5: 更新包出口**

在 `packages/core/src/index.ts` 末尾追加：

```ts
export { currentDrawdown, drawdownRecoveryDays, maxDrawdown } from './risk/drawdown.ts'
```

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 61 个测试通过（55 + 6），类型检查无错误

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/risk/drawdown.ts packages/core/src/risk/drawdown.test.ts packages/core/src/index.ts
git commit -F - <<'EOF'
feat(core): 最大回撤、回撤修复期、当前回撤

回撤一律返回非负幅度。修复期从谷底算到收复前高——「多久收复」问的
就是从最低点爬回前高用了多久；结束时仍在水下则返回 null，
不用末日期顶替，避免把「还在亏」谎报成「已修复」。

EOF
```

---

### Task 4: 滚动持有收益分布

**Files:**
- Create: `packages/core/src/risk/rolling.ts`
- Test: `packages/core/src/risk/rolling.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `assertNavSeries`（`./series.ts`）· `daysBetween`、类型 `NavConfirmed`（`@fundmanager/shared`）
- Produces:
  - `type RollingReturnStats = { readonly holdingDays: number; readonly windows: number; readonly lossProbability: number; readonly meanReturn: number; readonly medianReturn: number; readonly minReturn: number; readonly maxReturn: number; readonly p05: number; readonly p25: number; readonly p75: number; readonly p95: number }`
  - `rollingReturnDistribution(series: readonly NavConfirmed[], holdingDays: number): RollingReturnStats | null`

**定义（按此写）：**

- 对每个起点索引 `i`，找 `j > i` 中**第一个**满足 `daysBetween(date_i, date_j) >= holdingDays` 的观测（日期严格升序，故该搜索必然命中首个足够远的点），窗口收益 = `value_j / value_i − 1`；找不到则跳过该起点
- `holdingDays` 必须是正整数，否则抛 `TypeError`
- 无任何可用窗口 → 返回 `null`
- `lossProbability = 计数(收益 < 0) / windows`（恰好 0 不算亏损）
- 分位数用线性插值（numpy 默认的 type-7）：对升序数组 `sorted`、概率 `p`，`h = (n−1)×p`，`lo = ⌊h⌋`，`hi = ⌈h⌉`，返回 `sorted[lo] + (h − lo)×(sorted[hi] − sorted[lo])`
- 私有辅助 `quantile(sorted: readonly number[], p: number): number`，不导出

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/src/risk/rolling.test.ts`：

```ts
import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { rollingReturnDistribution } from './rolling.ts'

/** 从 2024-01-01 起逐日递增地搭一条序列 */
const series = (values: readonly number[]): ReturnType<typeof navConfirmed>[] =>
  values.map((v, i) => navConfirmed(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

it('[1, 2, 1, 1, 1, 2] 持有 2 天的窗口、亏损概率与分位数', () => {
  // 起点 01-01..01-04 各有一个 2 天后的窗口：收益 0, -0.5, 0, 1；01-05、01-06 之后无 ≥2 天观测 → 4 个窗口
  const stats = rollingReturnDistribution(series([1, 2, 1, 1, 1, 2]), 2)
  expect(stats).not.toBeNull()
  expect(stats!.holdingDays).toBe(2)
  expect(stats!.windows).toBe(4)
  expect(stats!.lossProbability).toBeCloseTo(0.25, 10) // 仅 -0.5 一个亏损
  expect(stats!.meanReturn).toBeCloseTo(0.125, 10) // (0 - 0.5 + 0 + 1) / 4
  expect(stats!.medianReturn).toBeCloseTo(0, 10)
  expect(stats!.minReturn).toBeCloseTo(-0.5, 10)
  expect(stats!.maxReturn).toBeCloseTo(1, 10)
  // 升序 [-0.5, 0, 0, 1]，type-7 插值 h=(4-1)*p
  expect(stats!.p05).toBeCloseTo(-0.425, 10) // -0.5 + 0.15 × 0.5
  expect(stats!.p25).toBeCloseTo(-0.125, 10) // -0.5 + 0.75 × 0.5
  expect(stats!.p75).toBeCloseTo(0.25, 10) // 0 + 0.25 × 1
  expect(stats!.p95).toBeCloseTo(0.85, 10) // 0 + 0.85 × 1
})

it('跨缺失交易日按日期取首个足够远的观测（Review Focus #5）', () => {
  // 日期 01-01、01-05、01-06（缺 01-02..01-04）。持有 2 天：
  // 起点 01-01 的首个「≥ 2 天后」观测是 01-05（距 4 天）→ 收益 2/1-1 = +100%
  // 起点 01-05 只差 01-06（1 天），不足 2 天 → 无窗口
  // 若误按索引取第 2 个点，起点 01-01 会落在 01-06（值 4）→ 收益 +300%，与预期不符
  const dates = ['2024-01-01', '2024-01-05', '2024-01-06']
  const s = [1, 2, 4].map((v, i) => navConfirmed(v, dates[i]!))
  const stats = rollingReturnDistribution(s, 2)!
  expect(stats.windows).toBe(1)
  expect(stats.maxReturn).toBeCloseTo(1, 10) // 起点 01-01 → 01-05
})

it('无可用窗口 → null', () => {
  expect(rollingReturnDistribution(series([1, 2, 3]), 30)).toBeNull()
})

it('holdingDays 非正整数抛异常', () => {
  expect(() => rollingReturnDistribution(series([1, 2, 3]), 0)).toThrow(TypeError)
  expect(() => rollingReturnDistribution(series([1, 2, 3]), -5)).toThrow(TypeError)
  expect(() => rollingReturnDistribution(series([1, 2, 3]), 1.5)).toThrow(TypeError)
})

it('日期乱序抛异常（Review Focus #1）', () => {
  const s = [navConfirmed(1, '2024-01-02'), navConfirmed(2, '2024-01-01')]
  expect(() => rollingReturnDistribution(s, 1)).toThrow(TypeError)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/risk/rolling.test.ts`
Expected: FAIL —— `Failed to resolve import "./rolling.ts"`

- [ ] **Step 3: 实现 `rolling.ts`**

```ts
import { daysBetween } from '@fundmanager/shared'
import type { NavConfirmed } from '@fundmanager/shared'
import { assertNavSeries } from './series.ts'

/** 滚动持有收益的分布统计量。所有收益率是简单收益。 */
export type RollingReturnStats = {
  /** 持有天数（日历天），原样回显 */
  readonly holdingDays: number
  /** 参与统计的窗口数 */
  readonly windows: number
  /** 亏损概率 [0, 1]：窗口收益 < 0 的比例（恰好 0 不算亏损） */
  readonly lossProbability: number
  readonly meanReturn: number
  readonly medianReturn: number
  readonly minReturn: number
  readonly maxReturn: number
  readonly p05: number
  readonly p25: number
  readonly p75: number
  readonly p95: number
}

/**
 * 分位数（type-7 线性插值，numpy 默认口径）。
 *
 * @param sorted 已升序排列的数组
 * @param p 概率 [0, 1]
 */
function quantile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!)
}

/**
 * 滚动持有收益分布：历史上任意时点买入、持有 holdingDays 日历天后卖出，
 * 这批收益的分布统计——回答「亏损概率多少」。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @param holdingDays 持有天数（日历天），必须是正整数
 * @returns 分布统计量；没有任何可用窗口时返回 null
 * @throws {TypeError} holdingDays 非正整数，或序列非法（透传 assertNavSeries）
 */
export function rollingReturnDistribution(
  series: readonly NavConfirmed[],
  holdingDays: number,
): RollingReturnStats | null {
  if (!Number.isInteger(holdingDays) || holdingDays <= 0) {
    throw new TypeError(`holdingDays 必须是正整数，收到：${holdingDays}`)
  }
  assertNavSeries(series)

  const returns: number[] = []
  for (let i = 0; i < series.length; i++) {
    const start = series[i]!
    // 找第一个「日期 >= 起点 + holdingDays 天」的观测；按索引取第 N 个点
    // 会在停牌、节假日处取错日期。日期严格升序，故首个命中即正确
    for (let j = i + 1; j < series.length; j++) {
      const end = series[j]!
      if (daysBetween(start.date, end.date) >= holdingDays) {
        returns.push(end.value / start.value - 1)
        break
      }
    }
  }
  if (returns.length === 0) return null

  const sorted = [...returns].sort((a, b) => a - b)
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
  return {
    holdingDays,
    windows: returns.length,
    lossProbability: returns.filter((r) => r < 0).length / returns.length,
    meanReturn: mean,
    medianReturn: quantile(sorted, 0.5),
    minReturn: sorted[0]!,
    maxReturn: sorted[sorted.length - 1]!,
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/risk/rolling.test.ts`
Expected: PASS，5 个测试通过

- [ ] **Step 5: 更新包出口**

在 `packages/core/src/index.ts` 末尾追加：

```ts
export { rollingReturnDistribution } from './risk/rolling.ts'
export type { RollingReturnStats } from './risk/rolling.ts'
```

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 66 个测试通过（61 + 5），类型检查无错误

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/risk/rolling.ts packages/core/src/risk/rolling.test.ts packages/core/src/index.ts
git commit -F - <<'EOF'
feat(core): 滚动持有收益分布

历史上任意时点买入、持有 N 天后的收益分布，回答「亏损概率多少」。
窗口终点按「日期 >= 起点 + N 日历天」的首个观测取，不按固定索引——
停牌与节假日会让两者错位。分位数用 type-7 线性插值。

EOF
```

---

### Task 5: 相关性矩阵

**Files:**
- Create: `packages/core/src/risk/correlation.ts`
- Test: `packages/core/src/risk/correlation.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `assertNavSeries`、`dailyReturns`（`./series.ts`）· 类型 `NavConfirmed`（`@fundmanager/shared`）
- Produces:
  - `type CorrelationResult = { readonly matrix: readonly (readonly number[])[]; readonly observations: number }`
  - `correlationMatrix(seriesList: readonly (readonly NavConfirmed[])[], options?: { window?: number }): CorrelationResult | null`

**定义（按此写）：**

- 默认窗口常量 `DEFAULT_WINDOW = 250`；`window` 选项若提供必须是不小于 2 的整数，否则抛 `TypeError`
- 序列条数 `< 2` → 返回 `null`
- 对每条序列先 `assertNavSeries`（乱序/重复/非正净值抛 `TypeError`）
- **日期对齐**：取所有序列日期的**交集**，升序排列得 `commonDates`；`commonDates.length < 3`（不足 2 个收益观测）→ 返回 `null`
- 每条序列按 `commonDates` 取子序列，求日收益 → 各得 `commonDates.length − 1` 个对齐收益
- 取**最近** `window` 个观测：`start = max(0, (commonDates.length − 1) − window)`，每条取 `slice(start)`
- `matrix[i][j]`：`i === j` 时为 `1`，否则为两序列对齐收益的**皮尔逊相关系数**
- 任一相关系数非有限（某序列在该窗口方差为 0，分母为 0）→ 整体返回 `null`
- 私有辅助：`intersectDates`、`alignReturns`、`pearson`，均不导出

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/src/risk/correlation.test.ts`：

```ts
import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { correlationMatrix } from './correlation.ts'

/** 按给定日期与数值搭一条序列 */
const series = (dates: readonly string[], values: readonly number[]): ReturnType<typeof navConfirmed>[] =>
  values.map((v, i) => navConfirmed(v, dates[i]!))

const D = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']

// A 的日收益：+50%, -50%, +50%, -50%
const A = series(D, [1, 1.5, 0.75, 1.125, 0.5625])
// B 的日收益恰为 A 的相反数：-50%, +50%, -50%, +50%
const B = series(D, [1, 0.5, 0.75, 0.375, 0.5625])

it('相同序列相关系数为 1，相反序列为 -1', () => {
  const same = correlationMatrix([A, series(D, A.map((p) => p.value))])!
  expect(same).not.toBeNull()
  expect(same.matrix[0]![0]).toBe(1)
  expect(same.matrix[1]![1]).toBe(1)
  expect(same.matrix[0]![1]).toBeCloseTo(1, 10)
  expect(same.observations).toBe(4)

  const opposite = correlationMatrix([A, B])!
  expect(opposite.matrix[0]![1]).toBeCloseTo(-1, 10)
  expect(opposite.matrix[1]![0]).toBeCloseTo(-1, 10)
})

it('只取共同日期，非重叠部分被丢弃', () => {
  // C 的日期整体后移一天：01-02..01-06。与 A 的共同日期是 01-02..01-05（4 天）
  const C = series(
    ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06'],
    [1, 1.5, 0.75, 1.125, 0.5625],
  )
  const result = correlationMatrix([A, C])!
  // 共同 4 个日期 → 3 个对齐收益；在重叠段里 C 的收益恰是 A 的相反数，相关系数为 -1
  expect(result.observations).toBe(3)
  expect(result.matrix[0]!.length).toBe(2) // 2×2 矩阵
  expect(result.matrix[0]![1]).toBeCloseTo(-1, 10)
})

it('window 限制只取最近若干个观测', () => {
  const result = correlationMatrix([A, B], { window: 2 })!
  expect(result.observations).toBe(2) // 只保留最近 2 个收益观测
})

it('无法计算时返回 null（序列不足、共同日期不足、零方差）', () => {
  const flat = series(D, [1, 1, 1, 1, 1])
  expect(correlationMatrix([A, flat])).toBeNull() // 零方差，不返回 NaN（Review Focus #3）
  expect(correlationMatrix([A])).toBeNull()
  expect(correlationMatrix([])).toBeNull()
  // 共同日期只有 01-01、02-01 两点 → 不足 2 个收益观测
  expect(correlationMatrix([A, series(['2024-01-01', '2024-02-01'], [1, 2])])).toBeNull()
})

it('序列日期乱序抛异常（Review Focus #1）', () => {
  const bad = [navConfirmed(1, '2024-01-02'), navConfirmed(2, '2024-01-01')]
  expect(() => correlationMatrix([A, bad])).toThrow(TypeError)
})

it('window 非法抛异常', () => {
  expect(() => correlationMatrix([A, B], { window: 1 })).toThrow(TypeError)
  expect(() => correlationMatrix([A, B], { window: 2.5 })).toThrow(TypeError)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/risk/correlation.test.ts`
Expected: FAIL —— `Failed to resolve import "./correlation.ts"`

- [ ] **Step 3: 实现 `correlation.ts`**

```ts
import type { NavConfirmed } from '@fundmanager/shared'
import { assertNavSeries, dailyReturns } from './series.ts'

/** 默认相关性窗口：约一个 A 股交易年。 */
const DEFAULT_WINDOW = 250

/** 相关性矩阵结果。matrix 是对称方阵，对角线为 1。 */
export type CorrelationResult = {
  /** 行列顺序与入参 seriesList 一致 */
  readonly matrix: readonly (readonly number[])[]
  /** 参与计算的共同交易日收益观测数 */
  readonly observations: number
}

/**
 * 所有序列共同拥有的日期，升序。
 * 数据源各只基金的历史长度与停牌日不同，必须先在共同日期上对齐。
 */
function intersectDates(seriesList: readonly (readonly NavConfirmed[])[]): string[] {
  const counts = new Map<string, number>()
  for (const s of seriesList) {
    for (const p of s) counts.set(p.date, (counts.get(p.date) ?? 0) + 1)
  }
  const result: string[] = []
  for (const [date, count] of counts) {
    if (count === seriesList.length) result.push(date)
  }
  return result.sort()
}

/** 把一条序列按共同日期取子序列后再求日收益，得到与其他序列对齐的收益数组。 */
function alignReturns(series: readonly NavConfirmed[], commonDates: readonly string[]): number[] {
  const byDate = new Map(series.map((p) => [p.date, p.value]))
  const aligned = commonDates.map((date) => navConfirmed(byDate.get(date)!, date))
  return dailyReturns(aligned)
}

/**
 * 皮尔逊相关系数。任一侧方差为 0（净值恒定）时分母为 0，返回 NaN，
 * 由上层统一转成 null。
 */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  const meanA = a.reduce((sum, x) => sum + x, 0) / n
  const meanB = b.reduce((sum, x) => sum + x, 0) / n
  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA
    const db = b[i]! - meanB
    covariance += da * db
    varianceA += da * da
    varianceB += db * db
  }
  return covariance / Math.sqrt(varianceA * varianceB)
}

/**
 * 组合内基金两两的日收益相关性矩阵。
 *
 * 先前在共同日期上对齐，再取最近 window 个收益观测。某序列方差为 0
 * （净值恒定）时相关系数无定义，整体返回 null，不返回 NaN。
 *
 * @param seriesList 各基金的确认净值序列，倒序即矩阵行列顺序
 * @param options.window 使用的最近收益观测数，默认 250
 * @returns 相关性矩阵；无法计算时返回 null
 * @throws {TypeError} window 不是不小于 2 的整数，或任一序列非法（透传 assertNavSeries）
 */
export function correlationMatrix(
  seriesList: readonly (readonly NavConfirmed[])[],
  options: { window?: number } = {},
): CorrelationResult | null {
  const window = options.window ?? DEFAULT_WINDOW
  if (!Number.isInteger(window) || window < 2) {
    throw new TypeError(`window 必须是不小于 2 的整数，收到：${window}`)
  }
  if (seriesList.length < 2) return null
  for (const s of seriesList) assertNavSeries(s)

  const commonDates = intersectDates(seriesList)
  // 至少要有 2 个共同日期才能产生 1 个收益观测，故要求 >= 3 个日期
  if (commonDates.length < 3) return null

  const start = Math.max(0, commonDates.length - 1 - window)
  const aligned = seriesList.map((s) => alignReturns(s, commonDates).slice(start))
  const observations = aligned[0]!.length
  if (observations < 2) return null

  const matrix: number[][] = []
  for (let i = 0; i < aligned.length; i++) {
    const row: number[] = []
    for (let j = 0; j < aligned.length; j++) {
      row.push(i === j ? 1 : pearson(aligned[i]!, aligned[j]!))
    }
    matrix.push(row)
  }
  // 任一相关系数非有限（某序列在该窗口方差为 0）→ 整个矩阵不可信，返回 null
  for (const row of matrix) {
    for (const value of row) {
      if (!Number.isFinite(value)) return null
    }
  }
  return { matrix, observations }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/risk/correlation.test.ts`
Expected: PASS，6 个测试通过

- [ ] **Step 5: 更新包出口**

在 `packages/core/src/index.ts` 末尾追加：

```ts
export { correlationMatrix } from './risk/correlation.ts'
export type { CorrelationResult } from './risk/correlation.ts'
```

- [ ] **Step 6: 跑全量测试、类型检查与格式化**

Run: `pnpm test && pnpm typecheck && pnpm format`
Expected: 72 个测试通过（66 + 6），类型检查无错误，格式化无改动或仅有格式化改动

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/risk/correlation.ts packages/core/src/risk/correlation.test.ts packages/core/src/index.ts
git commit -F - <<'EOF'
feat(core): 相关性矩阵

组合内基金两两日收益的皮尔逊相关。各基金历史长度与停牌日不同，
先在共同日期上对齐再取最近 window 个观测。

某序列方差为 0（净值恒定）时相关系数无定义——整矩阵返回 null，
不把 NaN 漏给调用方。

EOF
```

---

## 自审记录

**规格覆盖：** 本计划落实 `CONSTRAINTS/README.md` 与本计划相关的规则。§4 规则 1（三种价格隔离）→ 全部指标输入为 `NavConfirmed[]`，裸 `number[]` 与 `NavEstimate`/`MarketPrice` 编译期进不来（Task 1-5 的每个 `Consumes`）；§8.1（比较用 `approxEqual`）→ 本计划的比较集中在 `Number.isFinite`、`> 0`、字符串日期比较，未使用 `===` 比较金额/净值，故无需 `approxEqual`——**注意：这是有意的，不是遗漏**；§8.2（`YYYY-MM-DD`）→ 序列校验走 `assertDate`，滚动窗口用 `daysBetween`；§8.3（错误分类）→ 无解返 `null`（观测不足、未修复、零方差、无窗口），参数非法抛 `TypeError`（乱序、非正净值、非法 `holdingDays`/`window`/`periodsPerYear`/`target`）；§8.4（显式列名导出）→ 每个 Task 的包出口步与 `series.ts` 内的模块级导出；§8.5（纯函数）→ 无 class、无 IO、无 `Date.now()`，当前日期经序列末点传入；§8.7（注释）→ 所有导出函数用 JSDoc，**会抛异常的均带 `@throws`**，函数体内的滑窗、分位数插值、回撤扫描、皮尔逊均值扣除均有只解释「为什么」的行内注释。

**步骤扫描：** 每个 Step 只做一件事——写测试 / 跑测试确认失败 / 实现 / 跑测试确认通过 / 更新出口 / 全量验证 / 提交。无「处理边界情况」这类无法执行的措辞；边界情况全部落到具体断言（乱序、重复、非正、NaN、观测不足、未修复、零方差、无窗口、非法参数）。

**类型一致性核对：** `assertNavSeries` / `dailyReturns` 在 Task 1 定义，Task 2、3、5 消费，名字与签名逐字一致（`assertNavSeries(series, label?)`、`dailyReturns(series): number[]`）；Task 4 也消费 `assertNavSeries`。`NavConfirmed` 全程来自 `@fundmanager/shared`，无本地重复定义。`RollingReturnStats`（Task 4）、`CorrelationResult`（Task 5）仅在各自任务定义与导出。包出口 `index.ts` 的导出名与各 Task 的 `Produces` 逐字对上。计划 1 已导出的 `daysBetween` / `assertDate` 被本计划消费，拼写一致。

**Review Focus 落点：** 五条全部有直接测试 —— #1 乱序/重复 → Task 1（`dailyReturns`、`assertNavSeries`）、Task 3、4、5；#2 观测不足 → Task 2（波动率、下行波动）；#3 零方差 → Task 5（恒定序列）；#4 未修复回撤 → Task 3（`drawdownRecoveryDays`）；#5 跨非连续交易日 → Task 4（缺失日期的窗口）。无遗漏。

**篇幅比例：** 实现代码块给的是**签名 + 关键逻辑**（滑窗取向、分位数插值式、回撤扫描、皮尔逊均值扣除的都是精要部分），测试代码块给全（测试是执行依据，含糊即失败）；私有辅助只在三行以内的给全文，其余给签名与职责。计划长度与它描述的代码量相称，未把完整实现逐字抄一遍。

**遗留项（须在后续计划中解决）：**
- 展示层对「多少观测才有统计意义」设阈值（本计划只保证 2 个观测起不返回 `NaN`）——计划 5/6
- 相关性窗口、滚动档位的默认值需按「待定项」表确认后固化
- 本计划用合成序列验证；数据集就绪后（计划 3）应补一个基于真实净值的回归测试

## 后续计划（不在本计划范围）

| 计划 | 内容 | 依赖 |
|---|---|---|
| 3 | `datasource`：数据源适配、解析（含 GBK 与 JS 文件）、缓存、降级 | 计划 1 |
| 4 | 账本与持久化：流水表、持仓推导、份额折算、一致性检查 | 计划 1 |
| 5 | `core` 估值与归因 + **压力测试** + 服务端 API + 预警规则与通知 | 2, 3, 4 |
| 6 | 前端界面与图表（ECharts） | 5 |

**压力测试排在计划 5，不在本计划**——它需要持仓结构（账本）与历史情景数据，依赖计划 3、4 的产出。
