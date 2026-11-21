/**
 * `api.fund.eastmoney.com/f10/*` 端点族：URL 构造 + 解析纯函数。
 *
 * 六个端点（`lsjz` / `HYPZ/` / `FHGG` / `JJGG` / `GetArrayCwzb` / `JJHSL/`）已实测全部可用，
 * 且**全部必需 `Referer`**（见 `docs/research/2026-11-18-datasource-inventory.md` §1.7–1.12）。
 * 该 host 下的 `JJFH` / `JJCF` 已失效，不在本模块内。
 *
 * 解析器一律纯函数：吃原始响应文本，出不带 IO 的结构化数据。
 */
import { z } from 'zod'

import type { HttpRequestSpec } from '../http/client.ts'
import { BusinessCodeError, ParseError } from '../http/errors.ts'

const F10_API_ORIGIN = 'https://api.fund.eastmoney.com/f10'
const F10_PAGE_ORIGIN = 'https://fundf10.eastmoney.com'

/**
 * 构造 f10 端点的请求头。
 *
 * `Referer` 是本族**唯一必需**的头，缺了不会得到 4xx——东财返回 HTTP 200，
 * body 是 `{"Data":"","ErrCode":-999,...}`。故这一条不能省，也不能靠状态码发现。
 *
 * @param page F10 页面的路径前缀（如 `jjjz`），东财只校验 Referer 来自本站，不校验具体页面
 */
function f10Headers(page: string, fundCode: string): Record<string, string> {
  return { Referer: `${F10_PAGE_ORIGIN}/${page}_${fundCode}.html` }
}

/** 拼 f10 端点 URL。参数名大小写**各端点不同且大小写敏感**，故由调用方逐个写死。 */
function f10Url(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) search.set(name, String(value))
  }
  return `${F10_API_ORIGIN}/${path}?${search}`
}

/**
 * 校验 f10 族统一信封的业务码，返回整个响应对象。
 *
 * 这是 Review Focus #1 的落点：**只看 HTTP 状态码一律视为 bug**。缺 Referer 时
 * HTTP 200 + `ErrCode:-999`，只查状态码会把错误页当数据往下传。
 *
 * @returns 已确认 `ErrCode` 为 0 的响应对象（未做字段级结构校验）
 * @throws {ParseError} 响应不是 JSON 对象，或没有 `ErrCode` 字段（结构已变）
 * @throws {BusinessCodeError} `ErrCode` 非 0——重试无意义（缺 Referer、路径失效都不会自愈）
 */
function assertF10Ok(text: string, endpoint: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new ParseError(`f10/${endpoint}：响应不是合法 JSON`, { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ParseError(`f10/${endpoint}：响应不是 JSON 对象`)
  }
  const { ErrCode, ErrMsg } = parsed as { ErrCode?: unknown; ErrMsg?: unknown }
  if (typeof ErrCode !== 'number') {
    throw new ParseError(`f10/${endpoint}：响应缺少 ErrCode 字段（结构已变）`)
  }
  if (ErrCode !== 0) {
    const detail = typeof ErrMsg === 'string' && ErrMsg !== '' ? ErrMsg : '（ErrMsg 为空）'
    throw new BusinessCodeError(
      `f10/${endpoint} 业务码 ${ErrCode}：${detail} —— HTTP 200 不代表成功` +
        `（实测缺 Referer 即返回 ErrCode:-999）`,
    )
  }
  return parsed
}

/**
 * 按 Zod schema 校验响应结构。
 *
 * **结构不符必须抛，绝不退化成空集合**：接口改版却返回 `[]`，用户看到的是
 * 「这只基金没有数据」而不是「解析失败」——那正是最危险的静默错值。
 *
 * @throws {ParseError} 结构与预期不符
 */
function parseShape<S extends z.ZodType>(schema: S, value: unknown, endpoint: string): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new ParseError(`f10/${endpoint}：响应结构不符预期 —— ${result.error.message}`)
  }
  return result.data
}

/**
 * 把接口的数值字段归一化成 number。
 *
 * 接口的数值一律是字符串（带千分位、带百分号），并用空串 / `null` / `--` 表示「无此数据」。
 * **非空却读不出数的值抛 ParseError**——那说明字段格式变了；给 `null` 会让
 * 「本期利润」这类数字无声地变成缺失，settle 不下去。
 *
 * @param label 出错时用于定位的字段名（错误信息要能自解释）
 * @returns 数值；无数据时为 `null`。百分数只去掉 `%` 号，**不做 /100**
 * @throws {ParseError} 非空但无法解析成有限数
 */
function toNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ParseError(`${label}：数值不是有限数（${value}）`)
    return value
  }
  if (typeof value !== 'string') {
    throw new ParseError(`${label}：数值既不是字符串也不是数字（${typeof value}）`)
  }
  const text = value.replace(/[,\s%]/g, '')
  if (text === '' || text === '--') return null
  const num = Number(text)
  if (!Number.isFinite(num)) throw new ParseError(`${label}：无法解析的数值「${value}」`)
  return num
}

// ---------------------------------------------------------------------------
// lsjz：历史净值（含分红/拆分事件字段）
// ---------------------------------------------------------------------------

/**
 * 净值行上的分红/拆分事件类型。
 *
 * `unknown` 不是「没有事件」，而是**接口给了一个我们没有见过的 `FHFCBZ` 取值**——
 * 此时保留原文而不猜（见 `buildNavEvent`）。
 */
export type NavEventKind = 'dividend' | 'split' | 'unknown'

/** 附在净值行上的分红或拆分折算事件。 */
export type NavEvent = {
  readonly kind: NavEventKind
  /** 接口 `FHFCZ`：分红为每份现金额，拆分为折算比例 */
  readonly perUnit: number | null
  /** 接口 `FHFCZ10`：每 10 份数值。**无事件时接口给 `null` 而不是空串**，有事件时是字符串 */
  readonly per10Unit: number | null
  /** 接口 `FHSP` 原文，如「每10份派现金0.1000元」 */
  readonly description: string
}

/** 一行净值。 */
export type NavRow = {
  /** 净值日期（`FSRQ`），`YYYY-MM-DD` */
  readonly date: string
  /** 单位净值（`DWJZ`） */
  readonly nav: number | null
  /** 累计净值（`LJJZ`） */
  readonly accNav: number | null
  /** 日增长率（`JZZZL`，百分数，如 `-0.09` 表示 -0.09%） */
  readonly growthRate: number | null
  /** 该日附带的分红/拆分事件；无事件为 `null` */
  readonly event: NavEvent | null
}

/** `lsjz` 的**一页**。翻页是能力层的事，故把 `totalCount` 一并交出去（否则会被静默截断成 20 天）。 */
export type NavPage = {
  readonly rows: readonly NavRow[]
  readonly pageIndex: number
  readonly pageSize: number
  readonly totalCount: number
}

export type LsjzQuery = {
  readonly fundCode: string
  /** 页码，从 1 起；默认 1 */
  readonly pageIndex?: number
  /** 每页条数，默认 20（接口默认值） */
  readonly pageSize?: number
  /** 起始净值日 `YYYY-MM-DD`，含 */
  readonly startDate?: string
  /** 截止净值日 `YYYY-MM-DD`，含 */
  readonly endDate?: string
}

/** 构造 `f10/lsjz` 的一页请求。参数名 `fundCode` 是驼峰，与 `FHGG`/`JJGG` 的 `fundcode` 不同。 */
export function lsjzRequest(query: LsjzQuery): HttpRequestSpec {
  return {
    url: f10Url('lsjz', {
      fundCode: query.fundCode,
      pageIndex: query.pageIndex ?? 1,
      pageSize: query.pageSize ?? 20,
      startDate: query.startDate,
      endDate: query.endDate,
    }),
    headers: f10Headers('jjjz', query.fundCode),
  }
}

/**
 * `FHFCBZ`（事件类型码）→ 类型。
 *
 * **部分验证**：仅两个样本——`000001` 的分红为 `"0"`、`510300` 的份额折算为 `"106"`。
 * 未穷举，故不认识的取值归 `'unknown'`，**不猜**（猜错会把分红当拆分，账就错了）。
 */
const NAV_EVENT_KINDS: Readonly<Record<string, NavEventKind>> = { '0': 'dividend', '106': 'split' }

const rawNumber = z.union([z.string(), z.number()]).nullish()

const lsjzRowSchema = z.object({
  FSRQ: z.string(),
  DWJZ: rawNumber,
  LJJZ: rawNumber,
  JZZZL: rawNumber,
  FHFCZ: rawNumber,
  FHFCZ10: rawNumber,
  FHFCBZ: rawNumber,
  FHSP: z.string().nullish(),
})

const lsjzPageSchema = z.object({
  Data: z.object({ LSJZList: z.array(lsjzRowSchema) }),
  TotalCount: z.number().int().nonnegative(),
  PageSize: z.number().int().positive(),
  PageIndex: z.number().int().positive(),
})

type RawLsjzRow = z.output<typeof lsjzRowSchema>

/** 分红/拆分信息藏在**普通净值行**的附加字段里，不是独立事件列表——故逐行判断而非另起一路。 */
function buildNavEvent(row: RawLsjzRow): NavEvent | null {
  const description = row.FHSP ?? ''
  const hasAmount = row.FHFCZ !== null && row.FHFCZ !== undefined && row.FHFCZ !== ''
  const code = row.FHFCBZ === null || row.FHFCBZ === undefined ? '' : String(row.FHFCBZ)
  if (description === '' && !hasAmount && code === '') return null
  return {
    kind: NAV_EVENT_KINDS[code] ?? 'unknown',
    perUnit: toNumber(row.FHFCZ, `lsjz FHFCZ(${row.FSRQ})`),
    per10Unit: toNumber(row.FHFCZ10, `lsjz FHFCZ10(${row.FSRQ})`),
    description,
  }
}

/**
 * 解析 `f10/lsjz` 的一页。
 *
 * @throws {BusinessCodeError} 业务码非 0（缺 Referer 时即此）
 * @throws {ParseError} 结构不符预期
 */
export function parseLsjz(text: string): NavPage {
  const page = parseShape(lsjzPageSchema, assertF10Ok(text, 'lsjz'), 'lsjz')
  return {
    rows: page.Data.LSJZList.map((row) => ({
      date: row.FSRQ,
      nav: toNumber(row.DWJZ, `lsjz DWJZ(${row.FSRQ})`),
      accNav: toNumber(row.LJJZ, `lsjz LJJZ(${row.FSRQ})`),
      growthRate: toNumber(row.JZZZL, `lsjz JZZZL(${row.FSRQ})`),
      event: buildNavEvent(row),
    })),
    pageIndex: page.PageIndex,
    pageSize: page.PageSize,
    totalCount: page.TotalCount,
  }
}

// ---------------------------------------------------------------------------
// HYPZ：基金行业配置（按报告期）
// ---------------------------------------------------------------------------

/**
 * 一行行业配置。
 *
 * **口径警告**：`HYMC` 是**国民经济行业分类**（「制造业」「信息传输、软件和信息技术服务业」），
 * 与 `push2` 的 `f127`（「白酒Ⅱ」「电池」）不是一套体系，**归因前必须明确用哪套，不可混用**。
 */
export type IndustryAllocationRow = {
  /** 行业代码（`HYDM`） */
  readonly industryCode: string
  /** 行业名（`HYMC`） */
  readonly industryName: string
  /** 行业市值（`SZ`） */
  readonly marketValue: number | null
  /** 占净值比例（`ZJZBL`，百分数） */
  readonly navRatio: number | null
}

/** 一个报告期的行业配置。 */
export type IndustryQuarter = {
  /** 季度序号（`Quarter`），如 `"3"` */
  readonly quarter: string
  /** 报告期（`JZRQ`），`YYYY-MM-DD` */
  readonly reportDate: string
  readonly rows: readonly IndustryAllocationRow[]
}

const hypzSchema = z.object({
  Data: z.object({
    QuarterInfos: z.array(
      z.object({
        Quarter: z.string(),
        JZRQ: z.string(),
        HYPZInfo: z.array(
          z.object({ HYDM: z.string(), HYMC: z.string(), SZ: rawNumber, ZJZBL: rawNumber }),
        ),
      }),
    ),
  }),
})

/**
 * 构造 `f10/HYPZ/` 请求。路径带尾斜杠，且参数名是驼峰 `fundCode`。
 *
 * @param year 报告年份；无数据的年份返回空 `QuarterInfos`（不是错误）
 */
export function hypzRequest(query: { fundCode: string; year: number }): HttpRequestSpec {
  return {
    url: f10Url('HYPZ/', { fundCode: query.fundCode, year: query.year }),
    headers: f10Headers('hytz', query.fundCode),
  }
}

/**
 * 解析 `f10/HYPZ/` 一个年份的全部季度。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期
 */
export function parseHypz(text: string): readonly IndustryQuarter[] {
  const data = parseShape(hypzSchema, assertF10Ok(text, 'HYPZ'), 'HYPZ')
  return data.Data.QuarterInfos.map((quarter) => ({
    quarter: quarter.Quarter,
    reportDate: quarter.JZRQ,
    rows: quarter.HYPZInfo.map((row) => ({
      industryCode: row.HYDM,
      industryName: row.HYMC,
      marketValue: toNumber(row.SZ, `HYPZ SZ(${quarter.JZRQ}/${row.HYMC})`),
      navRatio: toNumber(row.ZJZBL, `HYPZ ZJZBL(${quarter.JZRQ}/${row.HYMC})`),
    })),
  }))
}

// ---------------------------------------------------------------------------
// FHGG / JJGG：公告列表（同结构，只差 URL 与 filtered 分类）
// ---------------------------------------------------------------------------

/** 一条公告元数据。**不含**分红金额/登记日——那要用 `fhsp_{code}.html` 或 `lsjz` 的附加字段。 */
export type Announcement = {
  readonly fundCode: string
  readonly title: string
  /** 发布日期，`YYYY-MM-DD`。取自 `PUBLISHDATEDesc`——`PUBLISHDATE` 带 `T00:00:00`，§8.2 禁止带时间的日期串进业务 */
  readonly publishDate: string
  readonly id: string
  /** 公告分类码（`NEWCATEGORY`），取值语义未穷举，原样保留 */
  readonly category: string | null
}

/** 公告的一页。 */
export type AnnouncementPage = {
  readonly items: readonly Announcement[]
  readonly pageIndex: number
  readonly pageSize: number
  readonly totalCount: number
}

const announcementPageSchema = z.object({
  Data: z.array(
    z.object({
      FUNDCODE: z.string(),
      TITLE: z.string(),
      PUBLISHDATEDesc: z.string(),
      ID: z.string(),
      NEWCATEGORY: z.union([z.string(), z.number()]).nullish(),
    }),
  ),
  TotalCount: z.number().int().nonnegative(),
  PageSize: z.number().int().positive(),
  PageIndex: z.number().int().positive(),
})

type RawAnnouncement = z.output<typeof announcementPageSchema>

function toAnnouncementPage(page: RawAnnouncement): AnnouncementPage {
  return {
    items: page.Data.map((row) => ({
      fundCode: row.FUNDCODE,
      title: row.TITLE,
      publishDate: row.PUBLISHDATEDesc,
      id: row.ID,
      category:
        row.NEWCATEGORY === null || row.NEWCATEGORY === undefined ? null : String(row.NEWCATEGORY),
    })),
    pageIndex: page.PageIndex,
    pageSize: page.PageSize,
    totalCount: page.TotalCount,
  }
}

/** 构造 `f10/FHGG`（分红送配公告）请求。注意参数名是全小写 `fundcode`。 */
export function fhggRequest(query: {
  fundCode: string
  pageIndex?: number
  pageSize?: number
}): HttpRequestSpec {
  return {
    url: f10Url('FHGG', {
      fundcode: query.fundCode,
      pageIndex: query.pageIndex ?? 1,
      pageSize: query.pageSize ?? 10,
    }),
    headers: f10Headers('fhsp', query.fundCode),
  }
}

/** 构造 `f10/JJGG`（全部公告）请求。`type` 是公告分类过滤，取值枚举未穷举（实测 `0` 即可）。 */
export function jjggRequest(query: {
  fundCode: string
  pageIndex?: number
  pageSize?: number
  type?: number
}): HttpRequestSpec {
  return {
    url: f10Url('JJGG', {
      fundcode: query.fundCode,
      pageIndex: query.pageIndex ?? 1,
      pageSize: query.pageSize ?? 10,
      type: query.type ?? 0,
    }),
    headers: f10Headers('jjgg', query.fundCode),
  }
}

/**
 * 解析 `f10/FHGG`。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期
 */
export function parseFhgg(text: string): AnnouncementPage {
  return toAnnouncementPage(parseShape(announcementPageSchema, assertF10Ok(text, 'FHGG'), 'FHGG'))
}

/**
 * 解析 `f10/JJGG`。与 `FHGG` 结构相同，只差端点（错误信息要能指认是哪个端点挂了）。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期
 */
export function parseJjgg(text: string): AnnouncementPage {
  return toAnnouncementPage(parseShape(announcementPageSchema, assertF10Ok(text, 'JJGG'), 'JJGG'))
}

// ---------------------------------------------------------------------------
// GetArrayCwzb：财务指标（列式字典）
// ---------------------------------------------------------------------------

/** 一个报告期的财务指标。 */
export type FinancialPeriod = {
  /** 报告期（`FSRQ`），`YYYY-MM-DD` */
  readonly reportDate: string
  /**
   * 其余指标，**按接口原始列名保留**（`COMPROFIT` / `NETPROFIT` / `UNITPROFIT` / `NGROWTH` /
   * `FNGROWTH` / `DISPROFIT` / `DIFUNTIPROFIT` / `ENDNAV` / `ENDUNITNAV` / `FCNGROWTH`）。
   * 这些列名的中文语义未在盘点中核实，故本层不另起中文名——起错了就是账错，保留原名可回溯。
   */
  readonly metrics: Readonly<Record<string, number | null>>
}

/** `GetArrayCwzb` 的解析结果。 */
export type FinancialReport = {
  readonly periods: readonly FinancialPeriod[]
  /** 解析成功但发生降级（列长不一致、跳过占位空行）时的说明；正常时为 `[]` */
  readonly warnings: readonly string[]
}

const cwzbSchema = z.object({
  Data: z.object({
    data: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.null()]))),
  }),
})

/** 构造 `f10/GetArrayCwzb` 请求。参数名是全小写 `fundcode`，`showtype` 实测固定 `0`。 */
export function cwzbRequest(query: { fundCode: string; year: number }): HttpRequestSpec {
  return {
    url: f10Url('GetArrayCwzb', { fundcode: query.fundCode, showtype: 0, year: query.year }),
    headers: f10Headers('cwzb', query.fundCode),
  }
}

/**
 * 解析 `f10/GetArrayCwzb`。
 *
 * 响应是**列式字典**（`FSRQ:[...]`、`NETPROFIT:[...]` 按索引对齐），不是行式数组，
 * 故这里按索引 zip 成行。各列长度不保证一致：**以最短的一列为准并记入 `warnings`**，
 * 不补齐、不猜。
 *
 * 另有一个实测坑：查一个没有数据的年份（如 `year=1999`）返回的**不是空数组**，
 * 而是一行全空串的占位行（`FSRQ:[""]`）。这类行若原样输出，下游会拿到一个日期为空的
 * 报告期，故跳过并记入 `warnings`。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期（含列式字典里没有 `FSRQ` 列）
 */
export function parseCwzb(text: string): FinancialReport {
  const data = parseShape(cwzbSchema, assertF10Ok(text, 'GetArrayCwzb'), 'GetArrayCwzb').Data.data
  const reportDates = parseShape(z.array(z.string()), data['FSRQ'], 'GetArrayCwzb FSRQ')
  const metricColumns = Object.entries(data).filter(([name]) => name !== 'FSRQ')

  const warnings: string[] = []
  for (const [name, values] of metricColumns) {
    if (values.length !== reportDates.length) {
      warnings.push(
        `列 ${name} 长度 ${values.length} 与 FSRQ 长度 ${reportDates.length} 不一致，按最短的截断`,
      )
    }
  }
  const rowCount = Math.min(reportDates.length, ...metricColumns.map(([, values]) => values.length))

  const periods: FinancialPeriod[] = []
  for (let i = 0; i < rowCount; i++) {
    const reportDate = reportDates[i]!
    if (reportDate === '') {
      warnings.push(`第 ${i} 行报告期为空，已跳过（接口对无数据的年份返回一行占位空行）`)
      continue
    }
    const metrics: Record<string, number | null> = {}
    for (const [name, values] of metricColumns) {
      metrics[name] = toNumber(values[i], `GetArrayCwzb ${name}[${i}]`)
    }
    periods.push({ reportDate, metrics })
  }
  return { periods, warnings }
}

// ---------------------------------------------------------------------------
// JJHSL：换手率
// ---------------------------------------------------------------------------

/** 一个报告期的换手率。 */
export type TurnoverRow = {
  /** 报告期（`REPORTDATE`），`YYYY-MM-DD`；实测为半年度（06-30 / 12-31） */
  readonly reportDate: string
  /** 股票周转率（`STOCKTURNOVER`）。接口原文数值，**单位未实测**，不做换算 */
  readonly stockTurnover: number | null
}

/** 换手率的一页。 */
export type TurnoverPage = {
  readonly rows: readonly TurnoverRow[]
  readonly pageIndex: number
  readonly pageSize: number
  readonly totalCount: number
}

const jjhslSchema = z.object({
  Data: z.array(z.object({ REPORTDATE: z.string(), STOCKTURNOVER: rawNumber })),
  TotalCount: z.number().int().nonnegative(),
  PageSize: z.number().int().positive(),
  PageIndex: z.number().int().positive(),
})

/** 构造 `f10/JJHSL/` 请求。路径带尾斜杠，且参数名是全小写 `pageindex` / `pagesize`。 */
export function jjhslRequest(query: {
  fundCode: string
  pageIndex?: number
  pageSize?: number
}): HttpRequestSpec {
  return {
    url: f10Url('JJHSL/', {
      fundcode: query.fundCode,
      pageindex: query.pageIndex ?? 1,
      pagesize: query.pageSize ?? 5,
    }),
    headers: f10Headers('jjhsl', query.fundCode),
  }
}

/**
 * 解析 `f10/JJHSL/` 的一页。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期
 */
export function parseJjhsl(text: string): TurnoverPage {
  const page = parseShape(jjhslSchema, assertF10Ok(text, 'JJHSL'), 'JJHSL')
  return {
    rows: page.Data.map((row) => ({
      reportDate: row.REPORTDATE,
      stockTurnover: toNumber(row.STOCKTURNOVER, `JJHSL STOCKTURNOVER(${row.REPORTDATE})`),
    })),
    pageIndex: page.PageIndex,
    pageSize: page.PageSize,
    totalCount: page.TotalCount,
  }
}
