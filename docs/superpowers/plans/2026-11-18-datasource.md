# 数据源层（`packages/datasource`）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 20 个已实测端点接进来，上层按**能力**取数；每次取数都带上「来源 + 数据时点 + 新鲜度 + 口径损失」，失败绝不静默。

**Architecture:** 三层 + 一道缝。`capabilities/`（按能力取数，含主备降级链）→ `endpoints/`（每端点一个模块：URL 构造 + 解析纯函数）→ `http/`（共享内核：请求头、超时、退避、解码）。`CacheStore` 定接口、先内存实现。装配点只有一处：`createFundDataSource()`。

**Tech Stack:** TypeScript 7（strict，ESM）· Vitest 5 · Zod 4 · Node 24 原生执行 `.ts`（无构建步骤）· pnpm workspace

**Spec:** `docs/superpowers/specs/2026-11-18-datasource-design.md`（权威设计）
**逐端点实测数据:** `docs/research/2026-11-18-datasource-inventory.md`（请求头、编码、变量名、字节数、19 条解析陷阱）——**凡计划未写明的端点细节，以这份盘点为准**

## Global Constraints

- TypeScript strict，ESM。**不使用装饰器**——Node 原生执行 `.ts` 会 `SyntaxError`
- **相对导入必须带 `.ts` 后缀**，不能用 `.js`（本项目无构建步骤）
- **不使用 `baseUrl`**（TypeScript 7 已移除）
- **包的出口用显式列名导出，不用 `export *`**（`CONSTRAINTS/08-code-style.md` §8.4）
- **`endpoints/` 的解析器必须是纯函数**：`(text: string) => T`，不做 IO、不读时钟。这是 §9.2 两层测试能成立的前提
- **`capabilities` → `endpoints` → `http` 单向依赖。`endpoints` 一律不得 import `capabilities`**
- **class 只允许出现在 `http/` 与 `cache/`**（有状态：限流间隔、退避计数、缓存表）。解析逻辑一律纯函数（§8.5，2026-11-18 修订版）
- **错误分类**（§8.3）：数学/数据上无解 → 返回 `null`；参数非法 → 抛异常；数据缺失 → 返回 `null`
- **测试要短**（§8.10，硬要求）：造数据用助手函数、**不写 `describe` 包裹**、同类断言合并进同一个 `it`。测试文件总行数应与被测代码相当
- **测试要克制**（§8.8）：判据只有一条——**这条路径会不会在真实使用中静默产生错值**。会就测，不会就不写
- 注释解释「为什么」，不复述「做什么」；标识符英文、注释与用户可见文案中文、**测试名中文**
- **提交信息不得包含任何工具署名行**；提交只 `git add` 本任务文件，**禁止 `git add -A`**
- **测试文件放 `src/`**（`vitest.config.ts` 的 include 是 `packages/*/src/**/*.test.ts`）；**fixture 放 `test/fixtures/`**；**契约测试放 `test/contract/`**（不在 include 内，由独立配置跑）

## Review Focus

规格未逐一写明、但最可能在实际使用中咬人的五类：

1. **软失败被当成成功** —— 东财多个接口失败时仍返回 HTTP 200，错误藏在 body 的 `ErrCode`/`Success` 里（已知两例：缺 Referer → `ErrCode:-999`；UA 门禁 → `61136403`，而 `ErrMsg` 谎称「网络繁忙」）。只看状态码会把错误页当数据。**每条解析路径都必须校验业务码**
2. **解析失败伪装成空集合** —— 接口结构变了却返回 `[]`，用户看到「这只基金没有持仓」而不是「解析失败」。**结构不符必须抛 `ParseError`**
3. **缓存降级未标 `stale`** —— 旧数据被当成当前值（反目标 A3）。**唯一允许用旧值的路径是「TTL 过期且取数失败」，且必须带 `stale: true`**
4. **降级到更弱的源但未标 `loss`** —— 持仓由全量（半年报 77 只）退化为仅前十大，用户以为看到了全部。**损失程度必须落在 `loss` 字段里**
5. **分页只取第一页** —— `lsjz` / `FundMNHisNetList` 都分页，只取首页会让「净值历史」被静默截断成 20 天

## 文件结构

```
packages/datasource/
├── tsconfig.json                     ← 新建（照 core 的样子）
├── src/
│   ├── index.ts                      ← 包出口，显式列名
│   ├── http/
│   │   ├── errors.ts                 ← 错误类
│   │   ├── encoding.ts               ← 按 charset 解码 + 去 BOM
│   │   └── client.ts                 ← HttpClient（有状态）
│   ├── cache/
│   │   ├── cacheStore.ts             ← 接口 + CacheEntry 类型
│   │   └── memoryCache.ts            ← 内存实现
│   ├── endpoints/                    ← 每端点一个模块，导出 URL 构造 + 纯解析
│   │   ├── f10.ts                    ← lsjz / HYPZ / FHGG / JJGG / GetArrayCwzb / JJHSL
│   │   ├── pingzhongdata.ts
│   │   ├── fundArchives.ts           ← jjcc / gmbd
│   │   ├── htmlPages.ts              ← jbgk / fhsp
│   │   ├── gtimg.ts                  ← qt（GBK）/ fqkline
│   │   ├── push2.ts
│   │   └── fundcode.ts
│   ├── capabilities/
│   │   ├── types.ts                  ← Fetched<T>、FundDataSource、各能力输出类型
│   │   ├── fetchWithFallback.ts      ← 降级链 + 缓存 + stale/loss 的唯一实现
│   │   ├── <capability>.ts           ← 每能力一个
│   │   └── index.ts                  ← createFundDataSource()（唯一装配点）
│   └── refresh-fixtures.ts           ← 重抓脚本入口（放 src 内是为了被 typecheck 覆盖）
└── test/
    ├── fixtures/<端点>/<code>.<ext>  +  manifest.json
    └── contract/*.contract.test.ts   +  vitest.contract.config.ts
```

`refresh-fixtures.ts` 放 `src/` 内、不从 `index.ts` 导出：它需要被 `tsc` 覆盖，而 datasource 的 `tsconfig.json` 只 include `src`。

---

### Task 1: 包骨架与 HTTP 内核

**Files:**
- Create: `packages/datasource/tsconfig.json`、`src/index.ts`、`src/http/errors.ts`、`src/http/encoding.ts`、`src/http/client.ts`、`src/http/client.test.ts`
- Modify: 根 `package.json`（`typecheck` 加上 datasource）

**Interfaces:**
- Produces:
  - `class DataSourceError extends Error`
  - `class HttpError extends DataSourceError`（HTTP 非 2xx、网络失败、超时）
  - `class BusinessCodeError extends DataSourceError`（业务码失败，恒不重试）
  - `class ParseError extends DataSourceError`（结构不符）
  - `decodeBody(bytes: Uint8Array, charset?: string): string`
  - `class HttpClient`，构造 `{ fetch, minIntervalMs?, timeoutMs?, maxRetries? }`，方法 `request(spec: { url: string; headers?: Record<string,string>; charset?: string }): Promise<{ status: number; text: string }>`

- [ ] **Step 1: 验证 `gbk` 解码在本机可用**

`qt.gtimg.cn` 返回 GBK，这一条不成立整个腾讯行情族就没法做，必须先证。

Run: `node -e "console.log(new TextDecoder('gbk').decode(new Uint8Array([0xbb, 0xa6, 0xb6, 0xab, 0x33, 0x30, 0x30])))"`
Expected: 打出 `沪深300`。若抛 `RangeError`，说明本机 Node 无 GBK 支持，**停下来报告**——需要引入解码依赖，那是本计划之外的决策。

- [ ] **Step 2: 写失败的测试**

`src/http/client.test.ts`。假 fetch 是**一个普通函数参数**，不是 mock 框架（§8.9）。

```ts
import { expect, it } from 'vitest'
import { HttpClient, HttpError } from './client.ts'

/** 造一个假的 fetch：第 n 次调用返回第 n 个预设响应 */
const fakeFetch = (...responses: Response[]): typeof globalThis.fetch => {
  let i = 0
  return async () => responses[Math.min(i++, responses.length - 1)]!
}

it('非 2xx 抛 HttpError', async () => {
  const c = new HttpClient({ fetch: fakeFetch(new Response('nope', { status: 500 })) })
  await expect(c.request({ url: 'https://x' })).rejects.toThrow(HttpError)
})

it('网络失败会重试，重试耗尽才抛', async () => {
  let calls = 0
  const flaky = (async () => {
    calls++
    if (calls < 3) throw new Error('ECONNRESET')
    return new Response('ok')
  }) as typeof globalThis.fetch
  const c = new HttpClient({ fetch: flaky, maxRetries: 2, minIntervalMs: 0 })
  await expect(c.request({ url: 'https://x' })).resolves.toEqual({ status: 200, text: 'ok' })
  expect(calls).toBe(3)
})

it('按 charset 解码 GBK 并去掉 UTF-8 BOM', async () => {
  const gbk = new Uint8Array([0xbb, 0xa6, 0xb6, 0xab, 0x33, 0x30, 0x30])
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61])
  const c = new HttpClient({
    fetch: fakeFetch(new Response(gbk), new Response(bom)),
    minIntervalMs: 0,
  })
  expect(await c.request({ url: 'https://x', charset: 'gbk' })).toEqual({
    status: 200,
    text: '沪深300',
  })
  const r = await c.request({ url: 'https://x' })
  expect(r.text).toBe('a') // BOM 已被去掉
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run packages/datasource/src/http/client.test.ts`
Expected: FAIL，`Cannot find module './client.ts'`

- [ ] **Step 4: 实现 `errors.ts` / `encoding.ts` / `client.ts`**

要点（签名与测试已定的部分不再重复）：

- `decodeBody`：去 BOM（先 `EF BB BF`）→ `new TextDecoder(charset ?? 'utf-8')`。**charset 大小写不敏感**
- `HttpClient` 只对**传输失败**（网络错误、超时、非 2xx）重试。**业务码错误由解析器抛，解析器在内核之外，因此结构上不可能被重试**——这正是设计要的，不要为了「统一」把业务码检查搬进内核
- 限流：记录上次请求时刻，两次请求间隔不足 `minIntervalMs`（默认 300）就等待。**状态在实例上，故用 class**
- 退避：第 n 次重试等待 `minIntervalMs * 2 ** n`
- 默认值：`minIntervalMs: 300`、`timeoutMs: 15000`、`maxRetries: 2`
- 超时用 `AbortSignal.timeout(timeoutMs)`

- [ ] **Step 5: 建 `tsconfig.json`，接入 `typecheck` 与包出口**

`packages/datasource/tsconfig.json` 照 `packages/core/tsconfig.json`（`extends` 根配置，`include: ["src"]`）。
根 `package.json` 的 `typecheck` 追加 `&& tsc --noEmit -p packages/datasource`。
`src/index.ts` 本任务只导出 `http/` 的四个错误类与 `HttpClient`、`decodeBody`。

- [ ] **Step 6: 跑测试与类型检查**

Run: `pnpm vitest run packages/datasource && pnpm typecheck`
Expected: 1 个测试文件通过，类型检查无错误

- [ ] **Step 7: 提交**

```bash
git add packages/datasource/tsconfig.json packages/datasource/src/index.ts \
  packages/datasource/src/http/errors.ts packages/datasource/src/http/encoding.ts \
  packages/datasource/src/http/client.ts packages/datasource/src/http/client.test.ts \
  package.json
git commit -m "feat: 数据源层骨架与 HTTP 内核（解码、退避、双重校验）"
```

---

### Task 2: `CacheStore` 与新鲜度语义

**Files:**
- Create: `src/cache/cacheStore.ts`、`src/cache/memoryCache.ts`、`src/cache/memoryCache.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type CacheEntry<T> = { readonly value: T; readonly source: string; readonly dataAsOf: string; readonly capturedAt: string; readonly expiresAt: number }`
  - `interface CacheStore { get<T>(key: string): Promise<CacheEntry<T> | undefined>; set<T>(key: string, entry: CacheEntry<T>): Promise<void> }`
  - `class MemoryCacheStore implements CacheStore`，`get` **不删除过期项**（过期项的用途正是降级时的旧值）

- [ ] **Step 1: 写失败的测试**

```ts
import { expect, it } from 'vitest'
import { MemoryCacheStore } from './memoryCache.ts'

const entry = (expiresAt: number) => ({
  value: [1, 2],
  source: 'f10/lsjz',
  dataAsOf: '2026-11-17',
  capturedAt: '2026-11-18T11:00:00+08:00',
  expiresAt,
})

it('存了能取回，原样不丢字段', async () => {
  const s = new MemoryCacheStore()
  await s.set('nav:000001', entry(9999999999999))
  expect(await s.get('nav:000001')).toEqual(entry(9999999999999))
})

it('没存过取回 undefined', async () => {
  expect(await new MemoryCacheStore().get('nope')).toBeUndefined()
})

it('已过期仍能取回——降级正是要靠它拿旧值', async () => {
  const s = new MemoryCacheStore()
  await s.set('nav:000001', entry(1)) // 1970 年就过期了
  expect(await s.get('nav:000001')).toBeDefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/datasource/src/cache/memoryCache.test.ts`
Expected: FAIL，`Cannot find module './memoryCache.ts'`

- [ ] **Step 3: 实现**

`MemoryCacheStore` 内部一个 `Map<string, CacheEntry<unknown>>`。**`get` 绝不判断过期**——过期与否由 capability 层决定，这里只负责存。理由：过期项正是降级时唯一的旧值来源，在这里删掉等于把降级能力删掉。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/datasource/src/cache/memoryCache.test.ts`
Expected: PASS，3 个用例

- [ ] **Step 5: 提交**

```bash
git add packages/datasource/src/cache/ packages/datasource/src/index.ts
git commit -m "feat: CacheStore 接口与内存实现，过期项保留供降级取旧值"
```

---

### Task 3～8: 端点适配器

六个任务同形，只列差异。**每个任务的验收依据是 `docs/research/2026-11-18-datasource-inventory.md` 对应小节**（URL、必需请求头、编码、响应变量名、解析陷阱都已在其中实测记录）。

**每个任务共同的步骤：**

- [ ] **Step A: 抓 fixture 落盘**

用 `curl` 抓，命令见该任务的「抓取命令」列。原始响应**逐字节存盘、不清洗**（清洗后无法验证解析器，且编码陷阱只有原始字节才暴露）。按端点建目录：`packages/datasource/test/fixtures/<端点>/`。

- [ ] **Step B: 写失败的测试**

解析器是纯函数，测试就是「读 fixture 文件 → 断言解析结果」。**每个解析器至少两条测试**：一条正常路径（断言真实取值），一条**业务码失败路径**（构造错误响应文本，断言抛 `BusinessCodeError`）。后者是 Review Focus #1 的落点。

```ts
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseLsjz } from './f10.ts'

const raw = readFileSync(new URL('../../test/fixtures/api_fund_lsjz/000001.json', import.meta.url), 'utf8')

it('解析净值行', () => {
  expect(parseLsjz(raw)[0]).toEqual({ date: '2026-11-17', nav: 0.951, accNav: 3.524 })
})

it('业务码非 0 抛 BusinessCodeError，不返回空集合', () => {
  const bad = JSON.stringify({ Data: '', ErrCode: -999, ErrMsg: 'xxx' })
  expect(() => parseLsjz(bad)).toThrow(BusinessCodeError)
})
```

- [ ] **Step C: 跑测试确认失败** → **Step D: 实现解析 + URL 构造** → **Step E: 跑测试确认通过**
- [ ] **Step F: 写该 fixture 目录的 `manifest.json`**

字段：`sourceUrl` / `endpoint` / `fundCode` / `capturedAt`（抓取时刻，带时区）/ `dataAsOf`（**数据本身的时点**）/ `requestHeaders`（复现所需，含 Referer/UA）/ `bytes` / `sha256` / `notes`。

- [ ] **Step G: 提交**

| 任务 | 模块 | 端点 | 抓取命令要点（必看盘点小节） | 特别注意 |
|---|---|---|---|---|
| 3 | `endpoints/f10.ts` | `lsjz`、`HYPZ/`、`FHGG`、`JJGG`、`GetArrayCwzb`、`JJHSL/` | 全部**必需 Referer**（如 `https://fundf10.eastmoney.com/jjjz_000001.html`） | 缺 Referer 返回 200 + `ErrCode:-999`；`GetArrayCwzb` 是**列式字典**；`lsjz` 的分红字段藏在普通净值行里 |
| 4 | `endpoints/pingzhongdata.ts` | `pingzhongdata/{code}.js` | 无需任何头 | **JS 赋值语句不是 JSON**（用 `node:vm` 沙箱，**不要 `eval`**）；**带 UTF-8 BOM**；`Data_netWorthTrend[].x` 是 **epoch 毫秒** |
| 5 | `endpoints/fundArchives.ts` | `FundArchivesDatas.aspx?type=jjcc`、`type=gmbd` | 两者**必需 Referer** | **变量名不同**：`jjcc` 是 `var apidata=`，`gmbd` 是 `var gmbd_apidata=`；`jjcc` 一个响应含**多个报告期**；半年报/年报块**无视 `topline`**；表头列数与数据列不一致，**不能按位置取「占净值比例」** |
| 6 | `endpoints/htmlPages.ts` | `jbgk_{code}.html`、`fhsp_{code}.html` | 无需任何头 | `jbgk` 是 `<th>`/`<td>` 平铺、**同一行可能夹多组**，按 `<th>` 文本定位；`fhsp` 是两张不同 class 的表（`table.cfxq` 分红 / `table.fhxq` 拆分），金额与比例要**从中文里正则抽出** |
| 7 | `endpoints/gtimg.ts` | `qt.gtimg.cn/q=`、`fqkline/get` | 无需任何头 | `qt` 是 **GBK**、`~` 分隔；`fqkline` 响应头写 UTF-8 但有 GBK 风险，解码失败时**回退 GBK** |
| 8 | `endpoints/push2.ts`、`endpoints/fundcode.ts` | `push2/stock/get`、`push2/clist/get`、`fundcode_search.js` | 无需任何头 | `push2` 的 `diff` 是**字典不是数组**；`fundcode_search.js` 是 `var r = [[...]]`；`f127` 是细分行业名，**与 `HYPZ.HYMC` 口径不同不可混用** |

**Task 3～8 每任务各自的提交信息**：`feat: <端点族中文名> 适配与解析`

---

### Task 9: 能力层与装配

**Files:**
- Create: `src/capabilities/types.ts`、`fetchWithFallback.ts`、`fetchWithFallback.test.ts`、各能力模块、`capabilities/index.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: 全部 `endpoints/` 模块、`CacheStore`、`HttpClient`
- Produces:
  - `type Fetched<T> = { readonly value: T; readonly source: string; readonly dataAsOf: string; readonly capturedAt: string; readonly stale: boolean; readonly loss: string | null }`
  - `interface FundDataSource`（每能力一个方法，全部返回 `Promise<Fetched<...>>`）：`navHistory`、`profile`、`holdings`、`industryAllocation`、`assetAllocation`、`scaleHistory`、`dividends`、`announcements`、`financials`、`turnover`、`fundCodes`、`quotes`、`dailyKline`、`stockIndustry`、`sectorMembers`
  - `createFundDataSource(deps: { http: HttpClient; cache: CacheStore }): FundDataSource`
  - `fetchWithFallback<T>(spec): Promise<Fetched<T>>` —— **唯一**实现降级、缓存、`stale`、`loss` 的地方

- [ ] **Step 1: 写失败的测试（`fetchWithFallback`，这是本任务的核心）**

```ts
import { expect, it } from 'vitest'
import { fetchWithFallback } from './fetchWithFallback.ts'

const ok = (value: number) => async () => ({ value, source: 'main', dataAsOf: '2026-11-17' })
const boom = async (): Promise<never> => {
  throw new Error('主源挂了')
}

it('主源成功：不标 stale，loss 为 null', async () => {
  const r = await fetchWithFallback({ key: 'k', ttlMs: 0, sources: [{ name: 'main', run: ok(1) }] })
  expect(r).toMatchObject({ value: 1, source: 'main', stale: false, loss: null })
})

it('主源挂了走备源，loss 记下失去了什么', async () => {
  const r = await fetchWithFallback({
    key: 'k', ttlMs: 0,
    sources: [{ name: 'main', run: boom }, { name: 'backup', run: ok(2), loss: '仅前十大' }],
  })
  expect(r).toMatchObject({ value: 2, source: 'backup', loss: '仅前十大' })
})

it('全链失败且缓存有旧值：返回旧值并标 stale', async () => {
  const cache = new MemoryCacheStore()
  await cache.set('k', { value: 9, source: 'main', dataAsOf: '2026-11-10', capturedAt: '2026-11-11T10:00:00+08:00', expiresAt: 1 })
  const r = await fetchWithFallback({ key: 'k', ttlMs: 1000, sources: [{ name: 'main', run: boom }], cache })
  expect(r).toMatchObject({ value: 9, stale: true, dataAsOf: '2026-11-10' })
})

it('全链失败且缓存无值：抛，不得返回空值', async () => {
  const cache = new MemoryCacheStore()
  await expect(
    fetchWithFallback({ key: 'k', ttlMs: 1000, sources: [{ name: 'main', run: boom }], cache }),
  ).rejects.toThrow(DataSourceError)
})
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现 `fetchWithFallback` 与各能力模块** → **Step 4: 跑测试确认通过**

实现要点：
- TTL 未过期 → 直接用缓存，`stale: false`（数据本来就该是这个时点，不算降级）
- TTL 过期或未命中 → 依次跑 `sources`；成功则写缓存
- 全链失败 → 取缓存（不看是否过期）：有则 `stale: true`，无则抛
- **`parse` 抛 `ParseError` 视为该源失败并继续降级**；抛 `BusinessCodeError` 同样继续降级，但若**全链**都是业务码错误，抛出的错误信息须包含「可能是缺少 Referer 或 UA 被拒」——设计 §4 要求错误能自解释
- 分页（Review Focus #5）：`navHistory` 必须翻页取全，**不得只取首页**。上限页数可配，默认足够覆盖 10 年
- `dataAsOf` 取值按设计 §十三：净值取最新净值日；持仓/行业/资产/规模取报告期；无天然时点的取 `capturedAt` 的日期

- [ ] **Step 5: 写测试钉住 Review Focus #4（降级损失）**

```ts
it('持仓降级到前十大必须在 loss 里说明，不得静默', async () => {
  // 主源 jjcc 失败、备源 fundmobapi 只给前十大
  const r = await ds.holdings('000001')
  expect(r.loss).toContain('前十大')
})
```

- [ ] **Step 6: 装配并跑全量验证**

`createFundDataSource` 是**唯一**装配点——`FundDataSource` 的实现全部在这些工厂函数内组装，上层只见 interface（§1 的「换源只改装配点」）。

Run: `pnpm vitest run packages/datasource && pnpm typecheck`
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add packages/datasource/src/capabilities packages/datasource/src/index.ts
git commit -m "feat: 能力层与装配，降级链显式标记 stale 与口径损失"
```

---

### Task 10: 重抓脚本、契约测试与收尾

**Files:**
- Create: `src/refresh-fixtures.ts`、`test/contract/pingzhongdata.contract.test.ts`、`test/contract/vitest.contract.config.ts`
- Modify: 根 `package.json`（加 `test:contract`）、`AGENTS.md`（命令表加一行）

**Interfaces:**
- Consumes: `createFundDataSource`、全部 `manifest.json`
- Produces: `pnpm test:contract` 命令

- [ ] **Step 1: 实现 `src/refresh-fixtures.ts`**

按 `test/fixtures/*/manifest.json` 的 `sourceUrl` + `requestHeaders` 重抓，写回文件并更新 `capturedAt` / `bytes` / `sha256`。**走 `packages/datasource` 的真实代码路径**，不另写一套 HTTP。

- [ ] **Step 2: 实现契约测试**

`test/contract/vitest.contract.config.ts`：`include: ['packages/datasource/test/contract/**/*.contract.test.ts']`。
根 `package.json` 加 `"test:contract": "vitest run -c packages/datasource/test/contract/vitest.contract.config.ts"`。

契约测试**打真网络**，断言：端点仍可达、结构仍能解析、关键字段仍在。**允许因接口变动而红**——接口挂了要被它发现，但不能把日常测试搞红（§9.2）。先写净值历史一条即可，其余端点后续按需补。

- [ ] **Step 3: 跑日常测试，确认契约测试没被捞进去**

Run: `pnpm test`
Expected: **不含**任何 `*.contract.test.ts`（`vitest.config.ts` 的 include 是 `packages/*/src/**/*.test.ts`，契约测试在 `test/` 下，天然不在内）——**这一步是验证，不是猜测**

- [ ] **Step 4: 跑契约测试**

Run: `pnpm test:contract`
Expected: 打真网络并通过。若失败，先判断是接口真变了还是网络抖动（§9.2）

- [ ] **Step 5: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm format`
Expected: 全部通过；`pnpm format` **无改动**（仓库级格式化已是恒等操作）

- [ ] **Step 6: 提交**

```bash
git add packages/datasource/src/refresh-fixtures.ts packages/datasource/test/contract \
  package.json AGENTS.md
git commit -m "feat: fixture 重抓脚本与契约测试，与日常测试分离"
```

---

## 自审记录

**规格覆盖**：设计 §六（三层）→ Task 1/2/3-8/9；§七（能力与降级链）→ Task 9；§八（解析陷阱）→ Task 3-8 逐条对应；§九（缓存）→ Task 2/9；§十（测试策略）→ 各 Task 的 fixture 步骤 + Task 10；§十三（接口细节）→ 已写进各 Task 的 Interfaces。**无缺口。**

**Review Focus 落点**：#1 业务码 → Task 3-8 每任务的 Step B 第二条测试；#2 解析失败伪装成空 → Task 3-8 的 `ParseError`；#3 未标 stale → Task 9 Step 1 第三、四条；#4 未标 loss → Task 9 Step 5；#5 分页 → Task 9 Step 4 要点 + Step 5。

**遗留项**（不阻塞本计划）：分红/折算的 `FHFCBZ` 取值语义仅 2 个样本，代码内须标注「部分验证」；`/f10/JJGG` 的 `type` 参数取值未穷举；板块 `BK` 代码映射未穷举；是否自动入账分红留给计划 4。
