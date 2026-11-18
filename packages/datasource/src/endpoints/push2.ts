/**
 * `push2.eastmoney.com/api/qt/*` 两个端点：URL 构造 + 解析纯函数。
 *
 * - `stock/get` 个股分类信息（`f127` 细分行业、`f128` 地域板块）
 * - `clist/get` 板块成分股列表（`fs=b:BKxxxx`）
 *
 * 两者都**不需要任何请求头**（实测不带 Referer / 桌面 UA 均 200）。
 * 见 `docs/research/2026-11-18-datasource-inventory.md` §1.19（stock/get）、§1.20（clist/get）、§6 #17。
 *
 * 实现期对盘点的修正（以本节为准，详见各函数注释）：
 * 1. 成功信封里 `data` 可以是 **`null`**（代码不存在时）——按「数据缺失」返回 `null`，
 *    **绝不返回空对象**（那会让调用方以为「这只是没有行业」，而不是「这个代码查不到」）。
 * 2. `clist/get` 的 `diff` 是**字典**（形如 `{序:{f12,f14}}`）不是数组；按数组遍历会得到 `undefined`。
 * 3. `rc` 才是业务码，不是 HTTP 状态码——统一校验（Review Focus #1）。
 */
import type { HttpRequestSpec } from '../http/client.ts'
import { BusinessCodeError, ParseError } from '../http/errors.ts'

const PUSH2_ORIGIN = 'https://push2.eastmoney.com/api/qt'

/** `stock/get` 固定取这四个字段：`f57` 代码、`f58` 名称、`f127` 细分行业、`f128` 地域板块。 */
const STOCK_FIELDS = 'f57,f58,f127,f128'

/** `clist/get` 固定取这两个字段：`f12` 代码、`f14` 名称。 */
const CLIST_FIELDS = 'f12,f14'

/** 东财用 `-` 表示「无此数据」的哨兵值；空串同理。两者都归一成 `null`。 */
function orNull(value: string): string | null {
  return value === '' || value === '-' ? null : value
}

// ---------------------------------------------------------------------------
// stock/get：个股分类信息
// ---------------------------------------------------------------------------

/**
 * 个股分类信息。
 *
 * **`industry` 是细分行业名**（`f127`，实测如「通信设备」「白酒Ⅱ」「电池」），
 * **与 `HYPZ` 的 `HYMC`（国民经济行业分类，如「制造业」）不是同一套体系，不可混用**
 * （`CONSTRAINTS/05-data-sources.md` §5 / 盘点 §6 #17）。
 * 归因前必须明确用哪一套：`HYPZ` 是基金维度的申万（国民经济）一级，`f127` 是个股维度的细分行业。
 */
export type StockIndustry = {
  /** 股票代码（`f57`），如 `300308` */
  readonly code: string
  /** 股票名称（`f58`），如 `中际旭创` */
  readonly name: string
  /** 细分行业名（`f127`），无则 `null`。**不是申万/国民经济分类，见类型注释** */
  readonly industry: string | null
  /** 地域板块名（`f128`），如 `山东板块`；无则 `null` */
  readonly region: string | null
}

/**
 * 构造 `stock/get` 请求。
 *
 * `secid` 由**市场号 + 代码**拼成，市场号是本端点**唯一区分沪深两市**的字段：
 * `0.` = 深市/创业板，`1.` = 沪市。**取错会返回别的股票或空**——`1.300308` 查不到深市那只，
 * `0.600519` 同理。调用方必须自己知道代码属于哪个市场（本项目代码来自持仓，市场号可据首位推断）。
 */
export function stockRequest(secid: string): HttpRequestSpec {
  return { url: `${PUSH2_ORIGIN}/stock/get?secid=${secid}&fields=${STOCK_FIELDS}` }
}

/**
 * 解析 `stock/get` 响应。
 *
 * @returns 分类信息；**代码不存在时接口给 `data:null`，此处返回 `null`**（数据缺失，不是成功）
 * @throws {ParseError} 响应不是 JSON 对象、缺 `rc` 字段、`data` 既非对象也非 `null`、或字段类型不符
 * @throws {BusinessCodeError} `rc` 非 0
 */
export function parseStockIndustry(text: string): StockIndustry | null {
  const data = unwrapPush2(text, 'stock/get')
  // data 为 null 是**正常的「查不到」**，不是结构变化——返回 null，绝不返回空对象
  if (data === null) return null
  const row = asRecord(data, 'stock/get data')
  return {
    code: requireString(row.f57, 'stock/get f57'),
    name: requireString(row.f58, 'stock/get f58'),
    industry: fieldOrNull(row.f127, 'stock/get f127'),
    region: fieldOrNull(row.f128, 'stock/get f128'),
  }
}

// ---------------------------------------------------------------------------
// clist/get：板块成分股
// ---------------------------------------------------------------------------

/** 板块成分股列表。 */
export type SectorMembers = {
  /** 成分股总数（`data.total`）；接口分页返回时大于 `members.length` */
  readonly total: number
  /** 本页成分股，按接口返回顺序 */
  readonly members: readonly SectorMember[]
}

/** 一只成分股。 */
export type SectorMember = {
  /** 代码（`f12`），如 `601288` */
  readonly code: string
  /** 名称（`f14`），如 `农业银行` */
  readonly name: string
}

export type ClistQuery = {
  /**
   * 板块筛选串 `fs`，如 `b:BK0475`（银行板块）。
   *
   * **`fs=i:1.000300` 不返回成分股**（只回指数本身，实测 `total:1`）——指数成分必须用对应的
   * **板块代码** `b:BKxxxx`。`BK` 代码映射**未穷举**（已知遗留项），故本函数只接受调用方传入的
   * `fs` 串，不在模块内维护映射表。
   */
  readonly fs: string
  /** 页码，从 1 起；默认 1 */
  readonly pn?: number
  /** 每页条数；默认 20 */
  readonly pz?: number
}

/** 构造 `clist/get` 请求。`pz` 是分页大小——**要取全成分股须自行翻页**（调用方负责）。
 *
 * 查询串**手工拼接、不做百分号编码**：`fields` 的逗号与 `fs` 的冒号若被编码成 `%2C`/`%3A`，
 * 是否仍被接受未实测（push2 在本次实现期间被网络挡过），故照抄实测可用的原始 URL 形状。
 * `fs` 取值固定形如 `b:BKxxxx`，不含需要转义的字符。 */
export function clistRequest(query: ClistQuery): HttpRequestSpec {
  const pn = query.pn ?? 1
  const pz = query.pz ?? 20
  return {
    url: `${PUSH2_ORIGIN}/clist/get?pn=${pn}&pz=${pz}&fs=${query.fs}&fields=${CLIST_FIELDS}`,
  }
}

/**
 * 解析 `clist/get` 响应。
 *
 * `diff` 是**字典**（`{序:{f12,f14}}`），不是数组——按数组遍历会静默得到 `undefined`，
 * 故这里显式按 `Object.values` 取，并对每个值的结构做校验。
 *
 * @returns 成分股列表；**板块查无成分时接口可能给 `data:null`，此时返回 `null`**（数据缺失）
 * @throws {ParseError} 响应不是 JSON 对象、缺 `rc`、`data` 是对象但缺 `diff` / `total`，或条目结构不符
 * @throws {BusinessCodeError} `rc` 非 0
 */
export function parseSectorMembers(text: string): SectorMembers | null {
  const data = unwrapPush2(text, 'clist/get')
  if (data === null) return null
  const row = asRecord(data, 'clist/get data')
  if (typeof row.total !== 'number') {
    throw new ParseError('clist/get：data 缺少 total 字段（结构已变）')
  }
  const diff = row.diff
  // diff 缺失/为 null 说明结构变了——**不能当成「这个板块没有成分股」返回空集合**（Review Focus #2）
  if (typeof diff !== 'object' || diff === null || Array.isArray(diff)) {
    throw new ParseError('clist/get：data.diff 不是字典（结构已变，实测应为 {序:{f12,f14}}）')
  }
  const members = Object.values(diff).map((entry, index) => {
    const item = asRecord(entry, `clist/get diff[${index}]`)
    return {
      code: requireString(item.f12, `clist/get diff[${index}].f12`),
      name: requireString(item.f14, `clist/get diff[${index}].f14`),
    }
  })
  return { total: row.total, members }
}

// ---------------------------------------------------------------------------
// 共享的信封校验
// ---------------------------------------------------------------------------

/**
 * 校验 push2 的统一信封 `{ rc, data }`，返回 `data`（**可能为 `null`**）。
 *
 * **成功看 `rc` 不看 HTTP 状态码**（Review Focus #1）。`data` 为 `null` 是接口表达
 * 「查不到」的方式，交由各解析器分别处置（本族两个端点都返回 `null`）。
 *
 * @throws {ParseError} 不是 JSON 对象、缺 `rc`、`data` 既非对象也非 `null`
 * @throws {BusinessCodeError} `rc` 非 0
 */
function unwrapPush2(text: string, endpoint: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new ParseError(`push2/${endpoint}：响应不是合法 JSON`, { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ParseError(`push2/${endpoint}：响应不是 JSON 对象`)
  }
  const { rc, data } = parsed as { rc?: unknown; data?: unknown }
  if (typeof rc !== 'number') {
    throw new ParseError(`push2/${endpoint}：响应缺少 rc 字段（结构已变）`)
  }
  if (rc !== 0) {
    throw new BusinessCodeError(`push2/${endpoint} 业务码 ${rc} —— HTTP 200 不代表成功`)
  }
  if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
    throw new ParseError(`push2/${endpoint}：data 既不是对象也不是 null（结构已变）`)
  }
  return data
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ParseError(`push2 ${label}：不是对象（结构已变）`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ParseError(`push2 ${label}：不是字符串（结构已变）`)
  }
  return value
}

/** `f127`/`f128` 可能缺失或为空串/`-`；缺失即结构变了，其余按「无数据」归一成 `null`。 */
function fieldOrNull(value: unknown, label: string): string | null {
  if (value === undefined) throw new ParseError(`push2 ${label}：字段缺失（结构已变）`)
  if (typeof value !== 'string') throw new ParseError(`push2 ${label}：不是字符串（结构已变）`)
  return orNull(value)
}
