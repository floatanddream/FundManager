# 契约基础与收益计算引擎 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `@fundmanager/shared` 的基础工具（数值容差比较、日期处理）与类型契约（三种价格的类型隔离），以及 `@fundmanager/core` 的收益计算（XIRR 资金加权 / TWR 时间加权），全部由测试验证。

**Architecture:** `shared` 只放工具函数与类型，无运行时依赖（零第三方包）。`core` 是纯函数库：不 import 任何框架，不做 IO，全部输入显式传入。XIRR 用牛顿法求根、二分法兜底；TWR 用子区间链式相乘。

**Tech Stack:** TypeScript 7（strict，ESM）· Vitest 5 · Prettier · Node 24 原生执行 `.ts`（无构建步骤）· pnpm workspace

**Spec:** `docs/CONSTRAINTS.md` §8（代码风格，本计划直接落实）· `AGENTS.md` · `README.md`

## Global Constraints

- TypeScript strict，ESM（`"type": "module"`）。**不使用装饰器**——Node 原生执行 `.ts` 会 `SyntaxError`
- **相对导入必须带 `.ts` 后缀**（如 `import { x } from './price.ts'`）。**不能用 `.js`**——实测 Node 报 `ERR_MODULE_NOT_FOUND`。这与 TypeScript 官方推荐相反，但本项目无构建步骤、由 Node 直接执行，只能如此
- **不使用 `baseUrl`**（TypeScript 7 已移除，用了会 `TS5102`）
- **包的出口用显式列名导出，不用 `export *`**（`CONSTRAINTS.md` §8.4）
- `packages/core` **不 import 任何框架、不做任何 IO**，全部为纯函数
- **金额、净值、份额的比较一律用 `approxEqual`，禁止 `===`**（§8.1）
- **业务代码只许 `YYYY-MM-DD` 字符串**，带时间的日期字符串禁止进入业务逻辑（§8.2）
- **错误分类**（§8.3）：数学上无解 → 返回 `null`；参数非法 → 抛异常；数据缺失 → 返回 `null`
- 代码注释与用户可见文案用中文；标识符用英文
- 测试文件与被测文件同目录，命名 `*.test.ts`，**测试名用中文**
- **每个任务以「测试全绿 → 提交」为完成标志**。提交边界与任务边界一致。仓库已初始化，基线提交 `5621435`
- **提交信息不得包含任何工具署名行**（`Co-Authored-By:` 指向 AI 工具、`Generated with ...`、`🤖 ...` 一律不加），只写改动本身
- **执行方式：subagent 驱动**——每个任务派全新 subagent 实现，再由全新 reviewer 审查（依据 `superpowers:requesting-code-review`，需 git SHA），通过后才进下一个任务

## Review Focus

以下六类输入或失败模式，规格未逐一写明，但最可能在实际使用中咬人。每条都在所属任务里配了测试。

1. **全部现金流同号**（只买入、从未赎回）——XIRR 无解。必须返回 `null`，不能死循环
2. **带时间的日期字符串混入业务逻辑**——实测会让日期静默错位一天。必须抛异常拦住
3. **不存在的日期**（`2024-02-31`）——正则挡不住，会被 JavaScript 悄悄滚到 3 月 2 日。必须抛异常
4. **现金流日期乱序或重复**——必须归一排序，不能按输入顺序直接算
5. **分母为零**（初始市值为 0 或负）——子区间收益无定义，必须返回 `null`
6. **只有一笔现金流**——XIRR 无解

**未覆盖（已知，记为遗留项）：** 极短持有区间（如 3 天赚 1%）的年化数字会荒谬（可算出 200%+）。本计划只保证算法不撒谎，展示策略属计划 5。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `tsconfig.base.json` | 各包共用编译选项（新增） |
| `vitest.config.ts` | 根测试配置（新增） |
| `.prettierrc` | 格式化配置（新增） |
| `.prettierignore` | 格式化排除范围（新增） |
| `packages/shared/tsconfig.json` | shared 编译配置（新增） |
| `packages/shared/src/number.ts` | 数值容差比较（新增） |
| `packages/shared/src/date.ts` | 日期断言与运算（新增） |
| `packages/shared/src/price.ts` | 三种价格类型与构造函数（新增） |
| `packages/shared/src/index.ts` | 包出口（新增） |
| `packages/core/tsconfig.json` | core 编译配置（新增） |
| `packages/core/src/returns/cashflow.ts` | 现金流类型与归一化（新增） |
| `packages/core/src/returns/xirr.ts` | 资金加权收益（新增） |
| `packages/core/src/returns/twr.ts` | 时间加权收益（新增） |
| `packages/core/src/index.ts` | 包出口（新增） |

---

### Task 1: 工具链配置与数值、日期基础工具

**Files:**
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.prettierrc`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/number.ts`
- Create: `packages/shared/src/number.test.ts`
- Create: `packages/shared/src/date.ts`
- Create: `packages/shared/src/date.test.ts`
- Create: `packages/shared/src/index.ts`
- Modify: `package.json`（根，加 `test` / `test:watch` / `typecheck` / `format` 脚本）

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `approxEqual(a: number, b: number, eps?: number): boolean`
  - `assertDate(value: string, label?: string): string`
  - `daysBetween(from: string, to: string): number`

- [ ] **Step 1: 装 Prettier**

Run: `pnpm add -w -D prettier`
Expected: 成功加入根 devDependencies

- [ ] **Step 2: 写失败的测试（数值比较）**

创建 `packages/shared/src/number.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { approxEqual } from './number.ts'

describe('approxEqual', () => {
  it('完全相等', () => {
    expect(approxEqual(1.539, 1.539)).toBe(true)
  })

  it('浮点误差内视为相等', () => {
    // 0.1 + 0.2 在 float64 下是 0.30000000000000004
    expect(0.1 + 0.2 === 0.3).toBe(false)
    expect(approxEqual(0.1 + 0.2, 0.3)).toBe(true)
  })

  it('超出容差则不相等', () => {
    expect(approxEqual(1.539, 1.54)).toBe(false)
  })

  it('大数值下相对容差生效', () => {
    // 账本累加 1000 笔后误差可达 1e-5 量级，绝对容差 1e-9 挡不住，需相对容差
    const a = 633333.2814000114
    const b = 633333.2814
    expect(Math.abs(a - b)).toBeGreaterThan(1e-9)
    expect(approxEqual(a, b)).toBe(true)
  })

  it('NaN 与 Infinity 一律不相等', () => {
    expect(approxEqual(Number.NaN, Number.NaN)).toBe(false)
    expect(approxEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run packages/shared/src/number.test.ts`
Expected: FAIL —— `Failed to resolve import "./number.ts"`

- [ ] **Step 4: 实现 `number.ts`**

```ts
/**
 * 近似相等。float64 下金额、净值、份额一律用它比较，禁止 `===`。
 *
 * 同时判断绝对误差与相对误差：账本累加若干笔后误差随数值量级增长，
 * 只用绝对容差会把本该相等的两个金额误判为不等，导致对账天天报警。
 *
 * @param a 待比较的数值
 * @param b 待比较的数值
 * @param eps 容差，默认 1e-9
 * @returns 两数在容差内相等返回 true；任一为 NaN 或 ±Infinity 返回 false
 */
export function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  // 非有限数之间谈不上「近似相等」，直接判否，避免 NaN 参与比较后返回 false 的偶然正确
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const diff = Math.abs(a - b)
  return diff <= eps || diff <= eps * Math.max(Math.abs(a), Math.abs(b))
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/shared/src/number.test.ts`
Expected: PASS，5 个测试通过

- [ ] **Step 6: 写失败的测试（日期）**

创建 `packages/shared/src/date.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { assertDate, daysBetween } from './date.ts'

describe('assertDate', () => {
  it('合法日期原样返回', () => {
    expect(assertDate('2026-11-16')).toBe('2026-11-16')
  })

  it('斜杠格式抛异常', () => {
    expect(() => assertDate('2024/01/01')).toThrow(TypeError)
  })

  it('带时间的字符串抛异常（Review Focus #2）', () => {
    // 实测 Date.parse('2024-01-01') 按 UTC 解释、'2024-01-01T00:00:00' 按本地解释，
    // 同一天差 8 小时，会让日期静默错位一天。必须在这里拦住。
    expect(() => assertDate('2024-01-01T00:00:00')).toThrow(TypeError)
    expect(() => assertDate('2024-01-01T00:00:00+08:00')).toThrow(TypeError)
  })

  it('不存在的日期抛异常（Review Focus #3）', () => {
    // 正则挡不住这个，JavaScript 会把它滚到 3 月 2 日
    expect(() => assertDate('2024-02-31')).toThrow(TypeError)
    expect(() => assertDate('2024-13-01')).toThrow(TypeError)
    expect(() => assertDate('2023-02-29')).toThrow(TypeError)
  })

  it('闰年 2 月 29 日合法', () => {
    expect(assertDate('2024-02-29')).toBe('2024-02-29')
  })
})

describe('daysBetween', () => {
  it('相邻两天相差 1', () => {
    expect(daysBetween('2024-01-01', '2024-01-02')).toBe(1)
  })

  it('逆序为负数', () => {
    expect(daysBetween('2024-03-01', '2024-01-01')).toBe(-60)
  })

  it('闰年整年 366 天', () => {
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366)
  })

  it('平年整年 365 天', () => {
    expect(daysBetween('2025-01-01', '2026-01-01')).toBe(365)
  })

  it('非法日期同样抛异常', () => {
    expect(() => daysBetween('2024-01-01', 'nope')).toThrow(TypeError)
  })
})
```

- [ ] **Step 7: 跑测试确认失败**

Run: `pnpm vitest run packages/shared/src/date.test.ts`
Expected: FAIL —— `Failed to resolve import "./date.ts"`

- [ ] **Step 8: 实现 `date.ts`**

```ts
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000

/**
 * 断言是合法的 YYYY-MM-DD，合法则原样返回。
 * 业务代码只许用这一天格式——带时间的字符串会让日期静默错位（见 §8.2）。
 *
 * @param value 待校验的日期字符串
 * @param label 出错时用于定位的字段名，默认 `date`
 * @returns 原样返回 value
 * @throws {TypeError} 格式不是 YYYY-MM-DD，或是不存在的日期（如 2024-02-31）
 */
export function assertDate(value: string, label = 'date'): string {
  if (!DATE_PATTERN.test(value)) {
    throw new TypeError(`${label} 必须是 YYYY-MM-DD 格式，收到：${value}`)
  }
  // 显式补 UTC。Date.parse 对纯日期按 UTC 解释、对带时间字符串按本地解释，
  // 两者相差 8 小时，会让日期静默错位一天
  const parsed = new Date(`${value}T00:00:00Z`)
  // 回读比对：正则挡不住 2024-02-31 这类不存在的日期，
  // JavaScript 会把它悄悄滚到 3 月 2 日而不报错
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} 不是真实存在的日期：${value}`)
  }
  return value
}

/**
 * 两个 YYYY-MM-DD 之间相差的天数（后者减前者），逆序为负。
 *
 * @param from 起始日期，YYYY-MM-DD
 * @param to 结束日期，YYYY-MM-DD
 * @returns 相差天数，可能为负
 * @throws {TypeError} 任一侧不是合法的 YYYY-MM-DD
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${assertDate(from, 'from')}T00:00:00Z`)
  const b = Date.parse(`${assertDate(to, 'to')}T00:00:00Z`)
  return (b - a) / MS_PER_DAY
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm vitest run packages/shared/src/date.test.ts`
Expected: PASS，10 个测试通过

- [ ] **Step 10: 建包出口**

创建 `packages/shared/src/index.ts`。显式列名导出，不用 `export *`：

```ts
export { assertDate, daysBetween } from './date.ts'
export { approxEqual } from './number.ts'
```

- [ ] **Step 11: 建编译配置**

创建根 `tsconfig.base.json`。`erasableSyntaxOnly` 与 Node 的原生执行能力对齐——它直接禁掉装饰器和 enum：

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "skipLibCheck": true
  }
}
```

创建 `packages/shared/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

创建 `.prettierrc`：

```json
{
  "semi": false,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

创建 `.prettierignore`。**必须有**：Task 4 会跑 `pnpm format`，而它是 `prettier --write .`，
没有排除范围就会把整个仓库重排一遍——包括使用者明确要求保留的 Vite 样例代码，
以及手写的文档。那会产生一份真实改动被淹没的大 diff。

```
node_modules/
dist/
build/
pnpm-lock.yaml

# 保留脚手架生成的样例代码，不重排
apps/web/

# 手写文档，不重排
docs/
*.md
```

- [ ] **Step 12: 建测试配置与脚本**

创建根 `vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
})
```

修改根 `package.json`，在 `scripts` 中加：

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit -p packages/shared",
"format": "prettier --write ."
```

- [ ] **Step 13: 跑全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 15 个测试通过（number 5 + date 10），类型检查无错误

- [ ] **Step 14: 提交**

```bash
git add -A
git commit -F - <<'EOF'
feat: 建立数值与日期基础工具

- approxEqual：float64 下金额、净值、份额的比较一律走它，禁用 ===。
  同时判绝对与相对误差——账本累加后误差随数值量级增长，
  只用绝对容差会把本该相等的金额误判为不等。
- assertDate / daysBetween：业务日期只许 YYYY-MM-DD。
  拒绝带时间的字符串（Date.parse 对两者解释不同，差 8 小时会静默错位一天），
  并回读比对以拒绝 2024-02-31 这类不存在的日期。
- 工具链：tsconfig 基础配置、Vitest、Prettier。

EOF
```

---

### Task 2: 三种价格类型

**Files:**
- Create: `packages/shared/src/price.ts`
- Create: `packages/shared/src/price.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type NavConfirmed = { readonly kind: 'nav'; readonly value: number; readonly date: string }`
  - `type NavEstimate = { readonly kind: 'estimate'; readonly value: number; readonly asOf: string; readonly basis: string }`
  - `type MarketPrice = { readonly kind: 'price'; readonly value: number; readonly asOf: string }`
  - `type AnyPrice = NavConfirmed | NavEstimate | MarketPrice`
  - `navConfirmed(value: number, date: string): NavConfirmed`
  - `navEstimate(value: number, asOf: string, basis: string): NavEstimate`
  - `marketPrice(value: number, asOf: string): MarketPrice`
  - `isConfirmed(p: AnyPrice): p is NavConfirmed`

**说明：** `NavConfirmed.date` 用 `assertDate` 校验（业务日期）；`NavEstimate.asOf` / `MarketPrice.asOf` 是 ISO 时间戳，**不校验**，它们是另一类东西。

- [ ] **Step 1: 写失败的测试**

创建 `packages/shared/src/price.test.ts`：

```ts
import { describe, expect, expectTypeOf, it } from 'vitest'
import { isConfirmed, marketPrice, navConfirmed, navEstimate } from './price.ts'
import type { AnyPrice, MarketPrice, NavConfirmed, NavEstimate } from './price.ts'

describe('三种价格类型', () => {
  it('构造确认净值', () => {
    const p = navConfirmed(1.539, '2026-11-16')
    expect(p.kind).toBe('nav')
    expect(p.value).toBe(1.539)
    expect(p.date).toBe('2026-11-16')
  })

  it('确认净值拒绝带时间的日期', () => {
    expect(() => navConfirmed(1.539, '2026-11-16T00:00:00')).toThrow(TypeError)
  })

  it('构造盘中估值时必带基准说明', () => {
    const e = navEstimate(1.5379, '2026-11-17T14:32:00+08:00', '上证科创板50成份指数')
    expect(e.kind).toBe('estimate')
    expect(e.basis).toBe('上证科创板50成份指数')
  })

  it('构造场内成交价', () => {
    const m = marketPrice(4.042, '2026-11-17T16:14:55+08:00')
    expect(m.kind).toBe('price')
  })

  it('isConfirmed 只对确认净值为真', () => {
    expect(isConfirmed(navConfirmed(1.0, '2026-11-16'))).toBe(true)
    expect(isConfirmed(navEstimate(1.0, '2026-11-17T14:32:00+08:00', 'x'))).toBe(false)
    expect(isConfirmed(marketPrice(1.0, '2026-11-17T16:14:55+08:00'))).toBe(false)
  })

  it('估值与场内价在类型层面不可当作确认净值使用', () => {
    // 本设计的核心安全机制：传错东西，编译期就该报错，而不是运行时才发现。
    // 不用 expectTypeOf(...).not.toBeCallableWith(...)：expect-type@1.4.0 在负向
    // 匹配器上把该方法定义为 never，既编译不过、也断言不了任何东西（已实测）。
    // 按官方推荐改用 @ts-expect-error 断言调用不通过编译——它自带守卫：
    // 若哪天类型被放宽到能通过，该指令变成「无用」，typecheck 反而会失败。
    const takesConfirmed = (n: NavConfirmed): number => n.value
    expectTypeOf(takesConfirmed).toBeCallableWith(navConfirmed(1.0, '2026-11-16'))
    // @ts-expect-error 估值不能传给只接受 NavConfirmed 的位置
    takesConfirmed(navEstimate(1.0, '2026-11-17T14:32:00+08:00', 'x'))
    // @ts-expect-error 场内成交价不能传给只接受 NavConfirmed 的位置
    takesConfirmed(marketPrice(1.0, '2026-11-17T16:14:55+08:00'))
  })

  it('AnyPrice 是三种类型的联合', () => {
    expectTypeOf<AnyPrice>().toEqualTypeOf<NavConfirmed | NavEstimate | MarketPrice>()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/shared/src/price.test.ts`
Expected: FAIL —— `Failed to resolve import "./price.ts"`

- [ ] **Step 3: 实现 `price.ts`**

```ts
import { assertDate } from './date.ts'

/** T-1 确认净值：基金公司收盘后公布。收益与风险计算**只能**用这个。 */
export type NavConfirmed = {
  readonly kind: 'nav'
  readonly value: number
  /** YYYY-MM-DD */
  readonly date: string
}

/** 盘中估值：由跟踪指数涨跌推算。**仅供参考，不得参与收益计算。** */
export type NavEstimate = {
  readonly kind: 'estimate'
  readonly value: number
  /** ISO 时间戳，非业务日期，不做 YYYY-MM-DD 校验 */
  readonly asOf: string
  /** 推算所依据的指数，如「上证科创板50成份指数」 */
  readonly basis: string
}

/** 场内成交价：含折溢价，与净值不等。 */
export type MarketPrice = {
  readonly kind: 'price'
  readonly value: number
  /** ISO 时间戳，非业务日期，不做 YYYY-MM-DD 校验 */
  readonly asOf: string
}

export type AnyPrice = NavConfirmed | NavEstimate | MarketPrice

/**
 * 构造确认净值。
 *
 * @param value 单位净值
 * @param date 净值日期，YYYY-MM-DD
 * @returns 确认净值对象
 * @throws {TypeError} date 不是合法的 YYYY-MM-DD
 */
export function navConfirmed(value: number, date: string): NavConfirmed {
  return { kind: 'nav', value, date: assertDate(date, 'navConfirmed.date') }
}

/** 构造盘中估值。asOf 是 ISO 时间戳，不做 YYYY-MM-DD 校验。 */
export function navEstimate(value: number, asOf: string, basis: string): NavEstimate {
  return { kind: 'estimate', value, asOf, basis }
}

/** 构造场内成交价。asOf 是 ISO 时间戳，不做 YYYY-MM-DD 校验。 */
export function marketPrice(value: number, asOf: string): MarketPrice {
  return { kind: 'price', value, asOf }
}

/** 窄化判定：是否为确认净值。收益与风险计算的前置守卫。 */
export function isConfirmed(p: AnyPrice): p is NavConfirmed {
  return p.kind === 'nav'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/shared/src/price.test.ts`
Expected: PASS，7 个测试通过

- [ ] **Step 5: 更新包出口**

`packages/shared/src/index.ts` 改为：

```ts
export { assertDate, daysBetween } from './date.ts'
export { approxEqual } from './number.ts'
export { isConfirmed, marketPrice, navConfirmed, navEstimate } from './price.ts'
export type { AnyPrice, MarketPrice, NavConfirmed, NavEstimate } from './price.ts'
```

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 22 个测试通过，类型检查无错误

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -F - <<'EOF'
feat: 建立三种价格的类型契约

确认净值 / 盘中估值 / 场内成交价用 kind 判别式分开。
收益与风险计算只接受 NavConfirmed——把估值传进去在编译期就报错，
不靠自觉。这是防止「用估算数字做决策」的技术保障。

EOF
```

---

### Task 3: 现金流类型与 XIRR（资金加权收益）

**Files:**
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/returns/cashflow.ts`
- Create: `packages/core/src/returns/cashflow.test.ts`
- Create: `packages/core/src/returns/xirr.ts`
- Create: `packages/core/src/returns/xirr.test.ts`
- Create: `packages/core/src/index.ts`
- Modify: `package.json`（根，`typecheck` 脚本追加 core）

**Interfaces:**
- Consumes: `assertDate`、`daysBetween` from `@fundmanager/shared`
- Produces:
  - `type CashFlow = { readonly date: string; readonly amount: number }` —— `amount` 负数为投入，正数为收回
  - `normalizeFlows(flows: readonly CashFlow[]): CashFlow[]`
  - `npv(rate: number, flows: readonly CashFlow[]): number`
  - `xirr(flows: readonly CashFlow[]): number | null`

**定义（按此写，不要另行解释）：**

- `npv(rate, flows) = Σ amount_i / (1 + rate)^(days_i / 365)`，`days_i` 为第 `i` 笔距**最早一笔**的天数
- `xirr` 返回使 `npv(r) = 0` 的 `r`
- 求根：牛顿法，初值 `0.1`，最多 100 次；未收敛或除零则改用二分法，区间 `[-0.9999, 10]`，最多 200 次
- 无解条件（任一满足即返回 `null`）：归一后笔数 < 2；所有 `amount` 同号；二分法两端同号
- **日期非法 → 抛 TypeError**（`assertDate`）
- `amount` 必须有限数，否则抛 TypeError

- [ ] **Step 1: 先让 core 能引用 shared**

Drizzle 无关，先把 workspace 依赖连上（`@fundmanager/shared` 已在 `packages/core/package.json` 中声明为 `workspace:*`，由脚手架步骤完成）。创建 `packages/core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 2: 写失败的测试（现金流归一化）**

创建 `packages/core/src/returns/cashflow.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { normalizeFlows } from './cashflow.ts'
import type { CashFlow } from './cashflow.ts'

describe('现金流归一化', () => {
  it('按日期升序排序，不理会输入顺序', () => {
    const input: CashFlow[] = [
      { date: '2025-01-01', amount: 600 },
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: 500 },
    ]
    expect(normalizeFlows(input).map((f) => f.date)).toEqual([
      '2024-01-01',
      '2024-07-01',
      '2025-01-01',
    ])
  })

  it('同日期多笔合并求和', () => {
    const input: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-01-01', amount: -500 },
    ]
    expect(normalizeFlows(input)).toEqual([{ date: '2024-01-01', amount: -1500 }])
  })

  it('合并后金额归零的笔次被剔除', () => {
    const input: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-01-01', amount: 1000 },
      { date: '2024-07-01', amount: 500 },
    ]
    expect(normalizeFlows(input)).toEqual([{ date: '2024-07-01', amount: 500 }])
  })

  it('不修改入参', () => {
    const input: CashFlow[] = [
      { date: '2025-01-01', amount: 600 },
      { date: '2024-01-01', amount: -1000 },
    ]
    normalizeFlows(input)
    expect(input[0]!.date).toBe('2025-01-01')
  })

  it('日期非法抛异常', () => {
    expect(() => normalizeFlows([{ date: '2024/01/01', amount: -1000 }])).toThrow(TypeError)
  })

  it('金额非有限数抛异常', () => {
    expect(() => normalizeFlows([{ date: '2024-01-01', amount: Number.NaN }])).toThrow(TypeError)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/returns/cashflow.test.ts`
Expected: FAIL —— `Failed to resolve import "./cashflow.ts"`

- [ ] **Step 4: 实现 `cashflow.ts`**

```ts
import { approxEqual, assertDate } from '@fundmanager/shared'

/** 一笔现金流。amount 负数为投入，正数为收回。date 为 YYYY-MM-DD。 */
export type CashFlow = {
  readonly date: string
  readonly amount: number
}

/**
 * 归一化现金流：按日期升序排序，同日期多笔合并求和，合并后归零的笔次剔除。
 *
 * XIRR 以首笔为时间基准，若日期乱序，贴现指数会算错，故必须先归一。
 *
 * @param flows 原始现金流，顺序任意
 * @returns 新数组，按日期升序；不修改入参
 * @throws {TypeError} 任一 date 非法，或任一 amount 不是有限数
 */
export function normalizeFlows(flows: readonly CashFlow[]): CashFlow[] {
  const merged = new Map<string, number>()
  for (const f of flows) {
    assertDate(f.date, 'CashFlow.date')
    if (!Number.isFinite(f.amount)) {
      throw new TypeError(`CashFlow.amount 必须是有限数，收到：${f.amount}`)
    }
    merged.set(f.date, (merged.get(f.date) ?? 0) + f.amount)
  }
  return (
    [...merged.entries()]
      // 同一天一进一出相抵为 0 的，不是现金流，留着会污染笔数判断（如 xirr 的「至少两笔」）
      .filter(([, amount]) => !approxEqual(amount, 0))
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date))
  )
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/returns/cashflow.test.ts`
Expected: PASS，6 个测试通过

- [ ] **Step 6: 写失败的测试（XIRR）**

创建 `packages/core/src/returns/xirr.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { CashFlow } from './cashflow.ts'
import { npv, xirr } from './xirr.ts'

describe('npv', () => {
  it('零利率时等于简单求和', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-12-31', amount: 1100 },
    ]
    expect(npv(0, flows)).toBeCloseTo(100, 6)
  })
})

describe('xirr', () => {
  it('持有满一年、赚 10% → 年化 10%', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-12-31', amount: 1100 },
    ]
    expect(xirr(flows)).toBeCloseTo(0.1, 6)
  })

  it('持有满一年、亏 10% → 年化 -10%', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-12-31', amount: 900 },
    ]
    expect(xirr(flows)).toBeCloseTo(-0.1, 6)
  })

  it('解出的收益率使净现值为零（自洽性）', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-03-15', amount: -2000 },
      { date: '2024-07-01', amount: 500 },
      { date: '2025-01-01', amount: 2800 },
    ]
    const r = xirr(flows)
    expect(r).not.toBeNull()
    expect(npv(r!, flows)).toBeCloseTo(0, 4)
  })

  it('现金流乱序输入也能算出同样结果（Review Focus #4）', () => {
    const ordered: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: 500 },
      { date: '2025-01-01', amount: 600 },
    ]
    const shuffled: CashFlow[] = [ordered[2]!, ordered[0]!, ordered[1]!]
    expect(xirr(shuffled)).toBeCloseTo(xirr(ordered)!, 10)
  })

  it('全部现金流同号 → null，不死循环（Review Focus #1）', () => {
    const allOut: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: -500 },
    ]
    expect(xirr(allOut)).toBeNull()
  })

  it('只有一笔现金流 → null（Review Focus #6）', () => {
    expect(xirr([{ date: '2024-01-01', amount: -1000 }])).toBeNull()
  })

  it('空数组 → null', () => {
    expect(xirr([])).toBeNull()
  })

  it('同日一进一出相抵后无解 → null', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-01-01', amount: 1000 },
    ]
    expect(xirr(flows)).toBeNull()
  })
})
```

- [ ] **Step 7: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/returns/xirr.test.ts`
Expected: FAIL —— `Failed to resolve import "./xirr.ts"`

- [ ] **Step 8: 实现 `xirr.ts`**

```ts
import { daysBetween } from '@fundmanager/shared'
import { normalizeFlows, type CashFlow } from './cashflow.ts'

/** 一年按 365 天计，与 XIRR 的行业惯例一致（不按 365.25，否则与券商数字对不上）。 */
const DAYS_PER_YEAR = 365

/** 判定 npv 已足够接近 0 的阈值。再往下压会被浮点噪声主导，纯属浪费迭代。 */
const NPV_EPSILON = 1e-10

/** 牛顿法迭代上限。超出即认为不收敛，交二分法兜底。 */
const NEWTON_MAX_ITERATIONS = 100

/** 二分法迭代上限。二分每次折半，200 次足以把初始区间压到 1e-60 量级。 */
const BISECTION_MAX_ITERATIONS = 200

/** 二分法搜索区间。下界 -0.9999 而非 -1，因为 rate = -1 时分母为 0。 */
const RATE_LOWER_BOUND = -0.9999
/** 上界取 1000%：再高的年化没有实际意义，且容易把求根带偏。 */
const RATE_UPPER_BOUND = 10

/**
 * 净现值：把各笔现金流按天数贴现到首笔当日再求和。
 *
 * @param rate 年化贴现率
 * @param flows 已归一的现金流（按日期升序，否则贴现天数会算错）
 * @returns 净现值。空数组返回 0
 * @throws {TypeError} flows 中含非法日期（经 daysBetween → assertDate 透传）
 */
export function npv(rate: number, flows: readonly CashFlow[]): number {
  const first = flows[0]
  if (first === undefined) return 0
  return flows.reduce(
    (sum, f) => sum + f.amount / (1 + rate) ** (daysBetween(first.date, f.date) / DAYS_PER_YEAR),
    0,
  )
}

/** npv 对 rate 的一阶导数，供牛顿法使用。 */
function npvDerivative(rate: number, flows: readonly CashFlow[]): number {
  const first = flows[0]
  if (first === undefined) return 0
  return flows.reduce((sum, f) => {
    const t = daysBetween(first.date, f.date) / DAYS_PER_YEAR
    return sum - (t * f.amount) / (1 + rate) ** (t + 1)
  }, 0)
}

/**
 * 牛顿法求根。快，但从坏初值出发可能不收敛或跑向无意义的方向。
 *
 * @returns 收敛则返回解，否则返回 null（由二分法接手）
 */
function solveNewton(flows: readonly CashFlow[]): number | null {
  // 初值 0.1：多数基金持仓的年化收益落在这个量级附近
  let rate = 0.1
  for (let i = 0; i < NEWTON_MAX_ITERATIONS; i++) {
    const value = npv(rate, flows)
    if (Math.abs(value) < NPV_EPSILON) return rate

    const slope = npvDerivative(rate, flows)
    // 导数为 0 就无法定出下一步方向；非有限值说明已跑到数值边界外
    if (!Number.isFinite(slope) || slope === 0) return null

    const next = rate - value / slope
    // rate <= -1 会让 (1 + rate) 非正，贴现失去意义（且可能除零）
    if (!Number.isFinite(next) || next <= -1) return null
    // 步长已小于浮点分辨率，再迭代也不会变，直接接受
    if (Math.abs(next - rate) < 1e-12) return next
    rate = next
  }
  return null
}

/**
 * 二分法求根。比牛顿法慢，但只要有符号变化就必然收敛。
 *
 * @returns 区间内有解则返回近似解；两端同号（无解）返回 null
 */
function solveBisection(flows: readonly CashFlow[]): number | null {
  let lo = RATE_LOWER_BOUND
  let hi = RATE_UPPER_BOUND
  let fLo = npv(lo, flows)
  const fHi = npv(hi, flows)
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null
  // 两端同号说明区间内不存在零点，继续折半没有意义
  if (fLo * fHi > 0) return null

  for (let i = 0; i < BISECTION_MAX_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid, flows)
    if (Math.abs(fMid) < NPV_EPSILON) return mid
    // 零点必在被符号变化夹住的那一侧，据此收缩区间
    if (fLo * fMid < 0) {
      hi = mid
    } else {
      lo = mid
      fLo = fMid
    }
  }
  return (lo + hi) / 2
}

/**
 * 资金加权收益率（年化）。回答「我这笔钱实际赚了多少」，
 * 与时间加权（TWR）回答的「基金经理行不行」是两个不同问题。
 *
 * @param flows 现金流，顺序任意。amount 负数为投入，正数为收回
 * @returns 年化收益率；无解时返回 null
 * @throws {TypeError} 日期非法或金额不是有限数（调用方的 bug，须早暴露）
 */
export function xirr(flows: readonly CashFlow[]): number | null {
  const normalized = normalizeFlows(flows)

  // 只有一笔现金流构不成投资行为，谈不上收益率
  if (normalized.length < 2) return null

  // 全部同号意味着「只有投入没有收回」或反之——方程无解，不是算不出来，
  // 是这个问题的答案客观上不存在
  const hasNegative = normalized.some((f) => f.amount < 0)
  const hasPositive = normalized.some((f) => f.amount > 0)
  if (!hasNegative || !hasPositive) return null

  // 先试快的；牛顿法放弃时（返回 null）由二分法兜底，故用 ?? 而非 ||
  return solveNewton(normalized) ?? solveBisection(normalized)
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/returns/xirr.test.ts`
Expected: PASS，9 个测试通过

- [ ] **Step 10: 建包出口与更新脚本**

创建 `packages/core/src/index.ts`：

```ts
export { normalizeFlows } from './returns/cashflow.ts'
export type { CashFlow } from './returns/cashflow.ts'
export { npv, xirr } from './returns/xirr.ts'
```

修改根 `package.json` 的 `typecheck` 脚本：

```json
"typecheck": "tsc --noEmit -p packages/shared && tsc --noEmit -p packages/core"
```

- [ ] **Step 11: 跑全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 37 个测试通过，类型检查无错误

- [ ] **Step 12: 提交**

```bash
git add -A
git commit -F - <<'EOF'
feat: 实现现金流归一化与 XIRR 资金加权收益

XIRR 回答「我这笔钱实际赚了多少」，与 TWR 回答的「基金经理行不行」
是两个不同问题，两者都不可替代。

- normalizeFlows：按日期排序并合并同日多笔。XIRR 以首笔为时间基准，
  乱序会让贴现指数算错；相抵为零的笔次剔除，否则污染「至少两笔」的判断。
- xirr：牛顿法求根、二分法兜底。无解（不满两笔、全部同号）返回 null
  而非 NaN；参数非法抛 TypeError 而非静默产生 NaN。

EOF
```

---

### Task 4: TWR（时间加权收益）

**Files:**
- Create: `packages/core/src/returns/twr.ts`
- Create: `packages/core/src/returns/twr.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `assertDate` from `@fundmanager/shared`
- Produces:
  - `type ValuationPoint = { readonly date: string; readonly value: number; readonly flow: number }`
  - `timeWeightedReturn(points: readonly ValuationPoint[]): number | null`

**定义（按此写）：**

- `points[0]` 是起始估值，不产生收益
- 对 `i >= 1`：子区间收益 `r_i = points[i].value / (points[i-1].value + points[i].flow) - 1`
  - `value` 为当日**收盘后**市值；`flow` 为当日**净现金流**（正为追加投入，负为取出），视作发生于当日期初之前，故计入分母
- `TWR = Π(1 + r_i) - 1`
- `points` 须按日期升序传入（调用方负责，本函数不排序，但**校验日期合法性**）
- 无解条件：`points.length < 2`；任一子区间分母 `<= 0`
- **日期非法或 value/flow 非有限数 → 抛 TypeError**

- [ ] **Step 1: 写失败的测试**

创建 `packages/core/src/returns/twr.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { ValuationPoint } from './twr.ts'
import { timeWeightedReturn } from './twr.ts'

describe('TWR 时间加权收益', () => {
  it('中途追加投入不干扰收益率', () => {
    // 期初 1000；中途追加 200 后市值 1200（本期收益 0）；
    // 期末 1320（本期收益 +10%）。追加的钱被正确剔除——这正是 TWR 相对
    // 「收益÷投入」的意义所在。
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2024-07-01', value: 1200, flow: 200 },
      { date: '2025-01-01', value: 1320, flow: 0 },
    ]
    expect(timeWeightedReturn(points)).toBeCloseTo(0.1, 10)
  })

  it('无现金流时退化为简单收益率', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2025-01-01', value: 1100, flow: 0 },
    ]
    expect(timeWeightedReturn(points)).toBeCloseTo(0.1, 10)
  })

  it('两个子区间连乘', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2024-07-01', value: 1100, flow: 0 },
      { date: '2025-01-01', value: 1210, flow: 0 },
    ]
    expect(timeWeightedReturn(points)).toBeCloseTo(0.21, 10)
  })

  it('初始市值为 0 → null，不产生 Infinity（Review Focus #5）', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 0, flow: 0 },
      { date: '2025-01-01', value: 1100, flow: 0 },
    ]
    expect(timeWeightedReturn(points)).toBeNull()
  })

  it('取出后分母仍非正 → null', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 100, flow: 0 },
      { date: '2024-07-01', value: 50, flow: -100 },
    ]
    expect(timeWeightedReturn(points)).toBeNull()
  })

  it('点数不足 → null', () => {
    expect(timeWeightedReturn([])).toBeNull()
    expect(timeWeightedReturn([{ date: '2024-01-01', value: 1000, flow: 0 }])).toBeNull()
  })

  it('日期非法抛异常', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2024-13-01', value: 1100, flow: 0 },
    ]
    expect(() => timeWeightedReturn(points)).toThrow(TypeError)
  })

  it('市值非有限数抛异常', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2024-07-01', value: Number.NaN, flow: 0 },
    ]
    expect(() => timeWeightedReturn(points)).toThrow(TypeError)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/src/returns/twr.test.ts`
Expected: FAIL —— `Failed to resolve import "./twr.ts"`

- [ ] **Step 3: 实现 `twr.ts`**

```ts
import { assertDate } from '@fundmanager/shared'

/**
 * 估值点。value 为当日收盘后市值；flow 为当日净现金流（正为追加投入，负为取出），
 * 视作发生于当日期初之前，故计入分母。
 */
export type ValuationPoint = {
  readonly date: string
  readonly value: number
  readonly flow: number
}

/**
 * 时间加权收益率。剔除现金流时点的影响，回答「基金经理行不行」，
 * 与资金加权（XIRR）回答的「我这笔钱赚了多少」是两个不同问题。
 *
 * 中途追加投入不影响结果——这正是它相对「总收益 ÷ 总投入」的意义所在。
 *
 * @param points 估值点序列。调用方须保证按日期升序，本函数不排序（但校验日期合法性）
 * @returns 区间累计收益率；无解时返回 null
 * @throws {TypeError} 日期非法，或 value/flow 不是有限数
 */
export function timeWeightedReturn(points: readonly ValuationPoint[]): number | null {
  // 先整体校验再计算：宁可一开始就拒掉坏数据，
  // 也不要算到一半才发现，那时错误已混进结果
  for (const p of points) {
    assertDate(p.date, 'ValuationPoint.date')
    if (!Number.isFinite(p.value) || !Number.isFinite(p.flow)) {
      throw new TypeError(`ValuationPoint 的 value/flow 必须是有限数，收到 value=${p.value}`)
    }
  }
  if (points.length < 2) return null

  // 逐子区间求收益再链式相乘。首点只作起点，不产生收益。
  let compounded = 1
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!
    const current = points[i]!
    // 当日期初的资产 = 上期期末 + 当日投入；取出则为减
    const base = previous.value + current.flow
    // 分母非正说明这一期没有本金，收益率无定义——
    // 不能返回 Infinity 或负数蒙混过去，那会污染后续连乘
    if (base <= 0) return null
    compounded *= current.value / base
  }
  return compounded - 1
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/core/src/returns/twr.test.ts`
Expected: PASS，8 个测试通过

- [ ] **Step 5: 更新包出口并跑全量验证**

在 `packages/core/src/index.ts` 追加：

```ts
export { timeWeightedReturn } from './returns/twr.ts'
export type { ValuationPoint } from './returns/twr.ts'
```

Run: `pnpm test && pnpm typecheck && pnpm format`
Expected: 全部 45 个测试通过（number 5 + date 10 + price 7 + cashflow 6 + xirr 9 + twr 8），类型检查无错误，格式化无改动或仅有格式化改动

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -F - <<'EOF'
feat: 实现 TWR 时间加权收益

逐子区间求收益再链式相乘，剔除现金流时点的影响。
中途追加投入不干扰结果——这正是它相对「总收益 ÷ 总投入」的意义。

分母非正时返回 null 而非 Infinity：那一期没有本金，收益率无定义，
返回 Infinity 会污染后续连乘。

EOF
```

---

## 自审记录

**规格覆盖：** 本计划覆盖设计与约束中的「基础工具」「类型契约」「收益计算」三块，其余子系统另立计划（见文末）。`CONSTRAINTS.md` §8 的风格规则逐条落实：8.1 → Task 1 Step 2-5（`approxEqual`，按相对容差处理大数值）；8.2 → Task 1 Step 6-9（`assertDate` 拒绝带时间字符串）；8.3 → 各任务的无解返 `null` 与非法抛异常；8.4 → 各任务 Step 的显式列名导出；8.5 → `core` 全纯函数；8.6 → Task 1 Step 1 装 Prettier；**8.7 → 计划中所有代码块已按注释规范写成**：导出的公共函数一律 JSDoc 形式（`approxEqual` / `assertDate` / `daysBetween` / `normalizeFlows` / `npv` / `xirr` / `timeWeightedReturn` / `navConfirmed`），**其中会抛异常的都带 `@throws`**；语义自明的导出函数（`navEstimate` / `marketPrice` / `isConfirmed`）用一行 JSDoc 即可，按 §8.7 只在「参数/返回值语义不显然时」才需要 `@param` / `@returns`；真正非导出的辅助函数用单行注释（`npvDerivative`）；函数体内的数值迭代、边界处理、公式推导均有行内注释，且只解释「为什么」（如二分法的符号变化依据、分母非正为何返回 `null` 而非 `Infinity`）。

> 2026-11-18 修正：本段原先把 `navEstimate` / `marketPrice` / `isConfirmed` 称为「非导出小函数」，**与事实不符**——三者在计划里都是 `export function`。它们的注释本就是 JSDoc 形式，无违规；错的是这段描述。已更正。

**Review Focus 落点：** 六条中五条有直接测试 —— #1 → Task 3 全同号；#2 → Task 1 拒绝带时间字符串 + Task 2 确认净值拒绝带时间日期；#3 → Task 1 拒绝 `2024-02-31`；#4 → Task 3 乱序；#5 → Task 4 分母为零；#6 → Task 3 单笔。**#6（本次新增）已覆盖**。唯一年化展示问题（极短区间）仍留作遗留项。

**类型一致性核对：** `approxEqual` / `assertDate` / `daysBetween` 三个名字在 Task 1 定义、Task 3 与 Task 4 消费，拼写一致。`CashFlow` / `ValuationPoint` 字段名一致。`normalizeFlows` 在 Task 3 定义并导出，其余任务不再定义同名函数。

**遗留项（须在后续计划中解决）：**
- 极短持有区间的年化展示策略（计划 5）
- `xirr` 求根稳定性未经长历史数据检验——计划 2 引入真实净值序列后，应补一个基于真实数据的回归测试

**未做的事（YAGNI）：** 未实现 Modified Dietz、日频对数 TWR、连续复利——本项目用不上。`core` 只从 `shared` 引入 `assertDate` / `daysBetween` / `approxEqual` 三个纯工具，**不引入价格类型**——价格类型的依赖将在估值与归因计划中建立。

---

## 后续计划（不在本计划范围）

| 计划 | 内容 | 依赖 |
|---|---|---|
| 2 | `core` 风险指标：年化波动率、最大回撤及修复期、下行波动、滚动持有收益分布、相关性矩阵 | 本计划 |
| 3 | `datasource`：数据源适配、解析（含 GBK 与 JS 文件）、缓存、降级 | 本计划 |
| 4 | 账本与持久化：流水表、持仓推导、份额折算、一致性检查、`node:sqlite` + Drizzle proxy 适配器 | 本计划 |
| 5 | `core` 估值与归因 + 服务端 API + 预警规则与通知 | 2, 3, 4 |
| 6 | 前端界面与图表（ECharts） | 5 |

### 计划 5 必须包含的一项验收：估算误差的统计验证

2026-11-18 在真实数据上测过三种估值算法（`000001`，2026-11-17 单日）：

| 算法 | 覆盖 | 误差 |
|---|---|---|
| 只用最新季报前十大 | 39.93% | -0.368pp（相对 50%） |
| 只用半年报全量 | 74.81% | -0.244pp（相对 33%） |
| **拼接：新前十权重 + 旧全量尾部** | **64.92%** | **-0.139pp（相对 19%）** |

**这是一只基金、一天的观测，不能当作精度结论。** 计划 5 必须补：

- **多基金 × 多交易日**的误差分布统计，尤其覆盖**经理调仓剧烈的时期**（那才是估算最不灵的时候）
- 用上面这组数据固化**回归测试**：估算代码每次改动后，误差不得退化
- 据此定出**验收阈值**——而不是凭单个观测拍板

所需数据源已实测可用（见 `docs/CONSTRAINTS.md` §5「持仓披露频率」）。
