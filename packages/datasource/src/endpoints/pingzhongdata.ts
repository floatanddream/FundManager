/**
 * `fund.eastmoney.com/pingzhongdata/{code}.js` 端点：URL 构造 + 解析纯函数。
 *
 * 该端点**不需要任何请求头**（实测不带 Referer、不带特殊 UA 均 200），响应是一份
 * **JS 赋值脚本**（多个 `var x = ...;`，**不是 JSON**），带 UTF-8 BOM，首段还夹着
 * `/** 测试数据 *​/` 注释。见 `docs/research/2026-11-18-datasource-inventory.md` §1.1。
 *
 * 一个响应里含 20+ 个变量（净值走势、累计净值、费率、经理、规模、资产配置、持有人结构、
 * 同类排名…），故 `parsePingzhongdata` **一次把需要的变量全部解析出来**（设计 §13 的
 * endpoint 粒度）——上层按能力在结果上切片，不重复解析同一份 766 KB 响应。
 *
 * 未纳入的变量及理由（避免误用）：`ishb`（语义未核实）；`stockCodes` / `stockCodesNew` /
 * `zqCodes` / `zqCodesNew`（是**测算用**的持仓代码，非确认持仓，持仓以 `jjcc` 端点为准）；
 * `swithSameType`（同类基金展示位，格式含「code_名称_收益」且实测有残缺，解析无可靠契约）。
 */
import vm from 'node:vm'

import { z } from 'zod'

import type { HttpRequestSpec } from '../http/client.ts'
import { ParseError } from '../http/errors.ts'

const PINGZHONGDATA_ORIGIN = 'https://fund.eastmoney.com/pingzhongdata'

/** 构造 `pingzhongdata/{code}.js` 请求。本端点**不需要任何请求头**。 */
export function pingzhongdataRequest(fundCode: string): HttpRequestSpec {
  return { url: `${PINGZHONGDATA_ORIGIN}/${fundCode}.js` }
}

// ---------------------------------------------------------------------------
// 沙箱执行
// ---------------------------------------------------------------------------

/** 沙箱执行上限（ms）。正常一份 766 KB 脚本本机约 10 ms 量级，5 s 足以兜住异常输入。 */
const SANDBOX_TIMEOUT_MS = 5000

/**
 * 在 `node:vm` 沙箱里执行响应脚本，返回 contextified 对象（`var` 声明会变成它的属性）。
 *
 * **必须用 `node:vm`，不得用 `eval`**（`CONSTRAINTS/08-code-style.md`、`AGENTS.md` 明令）。
 * 空沙箱无 `require`/`process`/`fetch`，脚本拿不到宿主能力；再加执行超时，异常输入也炸不开。
 *
 * @throws {ParseError} 响应不是可执行的 JS（如把别的端点的 JSON/HTML 喂了进来）
 */
function runAssignmentScript(text: string): Record<string, unknown> {
  // decodeBody 已在解码时剥掉 BOM，但解析器也可能被直接喂原文（测试即如此），故再兜一层
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const sandbox: Record<string, unknown> = {}
  vm.createContext(sandbox)
  try {
    vm.runInContext(source, sandbox, { timeout: SANDBOX_TIMEOUT_MS, filename: 'pingzhongdata.js' })
  } catch (cause) {
    throw new ParseError('pingzhongdata：响应不是可执行的 JS 赋值脚本（结构已变）', { cause })
  }
  return sandbox
}

/** 取沙箱里的变量；**缺失即抛**——结构变了要早暴露，不能静默少一段数据。 */
function readVar(sandbox: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(sandbox, name)) {
    throw new ParseError(`pingzhongdata：响应缺少变量 ${name}（结构已变）`)
  }
  return sandbox[name]
}

/**
 * 按 Zod schema 校验结构。
 *
 * **结构不符必须抛，绝不退化成空集合**（Review Focus #2）：接口改版却返回空数组，
 * 用户看到的是「这只基金没有数据」而不是「解析失败」——那正是最危险的静默错值。
 */
function parseShape<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new ParseError(`pingzhongdata ${label}：响应结构不符预期 —— ${result.error.message}`)
  }
  return result.data
}

/**
 * 东财走势时间戳是**北京时间零点**的 epoch 毫秒——实测首条 `1008604800000` 正是基金成立日
 * `2001-12-18`，末条 `1794844800000` 对应当日单位净值 `2026-11-17`，与 `f10/lsjz` 的
 * `FSRQ` 逐日吻合（同值 `0.9510`）。故按 +08:00 还原日历日：
 * 直接 `toISOString().slice(0, 10)` 会**整体早一天**，把整条净值序列的日期都推前一天
 * ——§8.2 记的 8 小时错位就是这个坑。中国自 1991 年起无夏令时，+08:00 恒定。
 */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000

function epochMsToDate(ms: number, label: string): string {
  if (!Number.isFinite(ms))
    throw new ParseError(`pingzhongdata ${label}：时间戳不是有限数（${ms}）`)
  return new Date(ms + CHINA_OFFSET_MS).toISOString().slice(0, 10)
}

/** 把接口的数值字符串归一化成 number；空串视为无数据返回 `null`。非空却读不出数抛 `ParseError`。 */
function toNumber(value: string, label: string): number | null {
  const text = value.trim()
  if (text === '') return null
  const num = Number(text)
  if (!Number.isFinite(num)) {
    throw new ParseError(`pingzhongdata ${label}：无法解析的数值「${value}」`)
  }
  return num
}

/** 语义上必须有值的数值；为空即结构变化，抛 `ParseError` 而不是给 `null`。 */
function toRequiredNumber(value: string, label: string): number {
  const num = toNumber(value, label)
  if (num === null) throw new ParseError(`pingzhongdata ${label}：字段为空但语义上必须有值`)
  return num
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/** 净值走势的一个点（`Data_netWorthTrend`）。 */
export type NavTrendPoint = {
  /** 净值日，`YYYY-MM-DD`（由 epoch 毫秒按北京时间还原） */
  readonly date: string
  /** 单位净值（`y`） */
  readonly nav: number
  /** 日增长率（`equityReturn`，百分数，如 `0.74` 表示 +0.74%） */
  readonly equityReturn: number
  /**
   * 分红说明原文（`unitMoney`）。**实测该文案残缺、不含金额**（一律为「分红：每10份派现金元」），
   * 故它**只能标记「当日有分红」，不能当分红金额用**——金额请以 `f10/lsjz` 的 `FHFCZ` 或
   * `fhsp` HTML 为准。
   */
  readonly unitMoney: string
}

/** 累计净值走势的一个点（`Data_ACWorthTrend`，原始为 `[epochMs, value]`）。 */
export type AccNavTrendPoint = {
  readonly date: string
  /** 累计净值 */
  readonly accNav: number
}

/** 一组具名序列（`name` + 数值数组）。 */
export type NamedSeries = {
  readonly name: string
  readonly data: readonly number[]
}

/** 带 `categories`（报告期或类别）与若干具名 `series` 的图数据。资产配置、持有人结构、申购赎回同形。 */
export type CategorizedSeries = {
  readonly categories: readonly string[]
  readonly series: readonly NamedSeries[]
}

/** 规模变动的一个报告期（`Data_fluctuationScale`）。 */
export type ScalePoint = {
  /** 报告期，`YYYY-MM-DD` */
  readonly reportDate: string
  /** 期末净资产（`y`，亿元） */
  readonly netAsset: number
  /** 环比（`mom` 原文，如 `"21.50%"`） */
  readonly mom: string
}

/** 股票仓位测算的一个点（`Data_fundSharesPositions`，原始为 `[epochMs, 百分比]`）。**是测算值，非确认仓位**。 */
export type StockPositionPoint = {
  readonly date: string
  /** 股票占净比测算值（%） */
  readonly ratio: number
}

/** 累计收益率走势的一条线（`Data_grandTotal`）。 */
export type GrandTotalSeries = {
  /** 序列名，实测为基金名 / `同类平均` / `沪深300` */
  readonly name: string
  readonly points: readonly { readonly date: string; readonly value: number }[]
}

/** 同类排名走势的一个点（`Data_rateInSimilarType`）。 */
export type PeerRankPoint = {
  readonly date: string
  /** 排名（`y`） */
  readonly rank: number
  /** 同类总数（`sc`，原始为字符串） */
  readonly total: number
}

/** 同类排名百分位走势的一个点（`Data_rateInSimilarPersent`，原始为 `[epochMs, 百分位]`）。 */
export type PeerPercentPoint = {
  readonly date: string
  /** 百分位 */
  readonly percentile: number
}

/** 现任基金经理（`Data_currentFundManager` 的摘要字段；其 `power` / `profit` 图表未纳入）。 */
export type FundManager = {
  readonly id: string
  readonly name: string
  /** 星级 */
  readonly star: number
  /** 任职时长原文，如 `"14年又344天"` */
  readonly workTime: string
  /** 管理规模原文，如 `"84.45亿(4只基金)"` */
  readonly fundSize: string
}

/** 业绩评价（`Data_performanceEvaluation`，五维雷达）。 */
export type PerformanceEvaluation = {
  /** 综合评分（`avr`，原文为字符串） */
  readonly average: number | null
  /** 维度名，如实测 `["选证能力","收益率","抗风险","稳定性","择时能力"]` */
  readonly categories: readonly string[]
  readonly scores: readonly number[]
}

/** `syl_*` 四个区间收益率（`近1年/近6月/近3月/近1月`，百分数）。 */
export type IntervalReturns = {
  readonly oneYear: number | null
  readonly sixMonth: number | null
  readonly threeMonth: number | null
  readonly oneMonth: number | null
}

/** `pingzhongdata/{code}.js` 一次解析出的全部数据。 */
export type Pingzhongdata = {
  readonly fundCode: string
  readonly fundName: string
  /** 原费率（`fund_sourceRate`，%） */
  readonly sourceRate: number | null
  /** 现费率（`fund_Rate`，%） */
  readonly rate: number | null
  /** 最小申购金额（`fund_minsg`，元）——语义按字段名推断，未在盘点中核实 */
  readonly minPurchase: number | null
  readonly returns: IntervalReturns
  readonly navTrend: readonly NavTrendPoint[]
  readonly accNavTrend: readonly AccNavTrendPoint[]
  readonly assetAllocation: CategorizedSeries
  readonly holderStructure: CategorizedSeries
  readonly buySedemption: CategorizedSeries
  readonly scaleHistory: readonly ScalePoint[]
  readonly stockPosition: readonly StockPositionPoint[]
  readonly grandTotal: readonly GrandTotalSeries[]
  readonly managers: readonly FundManager[]
  readonly performanceEvaluation: PerformanceEvaluation
  readonly peerRankTrend: readonly PeerRankPoint[]
  readonly peerPercentTrend: readonly PeerPercentPoint[]
}

// ---------------------------------------------------------------------------
// 结构校验
// ---------------------------------------------------------------------------

const navPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  equityReturn: z.number(),
  unitMoney: z.string(),
})

/** 走势点统一是 `[epochMs, value]` 二元组 */
const trendTupleSchema = z.tuple([z.number(), z.number()])

const categorizedSeriesSchema = z.object({
  categories: z.array(z.string()),
  series: z.array(z.object({ name: z.string(), data: z.array(z.number()) })),
})

const scaleSchema = z.object({
  categories: z.array(z.string()),
  series: z.array(z.object({ y: z.number(), mom: z.string() })),
})

const grandTotalSchema = z.array(z.object({ name: z.string(), data: z.array(trendTupleSchema) }))

const peerRankSchema = z.array(z.object({ x: z.number(), y: z.number(), sc: z.string() }))

const managerSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    star: z.number(),
    workTime: z.string(),
    fundSize: z.string(),
  }),
)

const performanceEvaluationSchema = z.object({
  avr: z.string(),
  categories: z.array(z.string()),
  data: z.array(z.number()),
})

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析 `pingzhongdata/{code}.js` 的全部已纳变量。
 *
 * 时间戳一律按**北京时间**还原为 `YYYY-MM-DD`（见 `epochMsToDate`）。
 *
 * @throws {ParseError} 响应不是可执行 JS、缺少白名单变量，或任一变量结构不符预期
 */
export function parsePingzhongdata(text: string): Pingzhongdata {
  const sandbox = runAssignmentScript(text)
  const read = (name: string): unknown => readVar(sandbox, name)

  const navTrend = parseShape(
    z.array(navPointSchema),
    read('Data_netWorthTrend'),
    'Data_netWorthTrend',
  ).map((p) => ({
    date: epochMsToDate(p.x, 'Data_netWorthTrend.x'),
    nav: p.y,
    equityReturn: p.equityReturn,
    unitMoney: p.unitMoney,
  }))

  const accNavTrend = parseShape(
    z.array(trendTupleSchema),
    read('Data_ACWorthTrend'),
    'Data_ACWorthTrend',
  ).map(([x, accNav]) => ({ date: epochMsToDate(x, 'Data_ACWorthTrend.x'), accNav }))

  const scaleRaw = parseShape(scaleSchema, read('Data_fluctuationScale'), 'Data_fluctuationScale')
  if (scaleRaw.categories.length !== scaleRaw.series.length) {
    throw new ParseError(
      `pingzhongdata Data_fluctuationScale：categories(${scaleRaw.categories.length}) 与 series(${scaleRaw.series.length}) 长度不一致`,
    )
  }
  const scaleHistory = scaleRaw.categories.map((reportDate, i) => ({
    reportDate,
    netAsset: scaleRaw.series[i]!.y,
    mom: scaleRaw.series[i]!.mom,
  }))

  const evaluation = parseShape(
    performanceEvaluationSchema,
    read('Data_performanceEvaluation'),
    'Data_performanceEvaluation',
  )

  return {
    fundCode: parseShape(z.string(), read('fS_code'), 'fS_code'),
    fundName: parseShape(z.string(), read('fS_name'), 'fS_name'),
    sourceRate: toNumber(
      parseShape(z.string(), read('fund_sourceRate'), 'fund_sourceRate'),
      'fund_sourceRate',
    ),
    rate: toNumber(parseShape(z.string(), read('fund_Rate'), 'fund_Rate'), 'fund_Rate'),
    minPurchase: toNumber(parseShape(z.string(), read('fund_minsg'), 'fund_minsg'), 'fund_minsg'),
    returns: {
      // syl_1n=近1年、syl_6y=近6月、syl_3y=近3月、syl_1y=近1月（后缀与周期的对应是接口既有，不按字面理解）
      oneYear: toNumber(parseShape(z.string(), read('syl_1n'), 'syl_1n'), 'syl_1n'),
      sixMonth: toNumber(parseShape(z.string(), read('syl_6y'), 'syl_6y'), 'syl_6y'),
      threeMonth: toNumber(parseShape(z.string(), read('syl_3y'), 'syl_3y'), 'syl_3y'),
      oneMonth: toNumber(parseShape(z.string(), read('syl_1y'), 'syl_1y'), 'syl_1y'),
    },
    navTrend,
    accNavTrend,
    assetAllocation: parseShape(
      categorizedSeriesSchema,
      read('Data_assetAllocation'),
      'Data_assetAllocation',
    ),
    holderStructure: parseShape(
      categorizedSeriesSchema,
      read('Data_holderStructure'),
      'Data_holderStructure',
    ),
    buySedemption: parseShape(
      categorizedSeriesSchema,
      read('Data_buySedemption'),
      'Data_buySedemption',
    ),
    scaleHistory,
    stockPosition: parseShape(
      z.array(trendTupleSchema),
      read('Data_fundSharesPositions'),
      'Data_fundSharesPositions',
    ).map(([x, ratio]) => ({ date: epochMsToDate(x, 'Data_fundSharesPositions.x'), ratio })),
    grandTotal: parseShape(grandTotalSchema, read('Data_grandTotal'), 'Data_grandTotal').map(
      (s) => ({
        name: s.name,
        points: s.data.map(([x, value]) => ({
          date: epochMsToDate(x, `Data_grandTotal.${s.name}.x`),
          value,
        })),
      }),
    ),
    managers: parseShape(
      managerSchema,
      read('Data_currentFundManager'),
      'Data_currentFundManager',
    ).map((m) => ({
      id: m.id,
      name: m.name,
      star: m.star,
      workTime: m.workTime,
      fundSize: m.fundSize,
    })),
    performanceEvaluation: {
      average: toNumber(evaluation.avr, 'Data_performanceEvaluation.avr'),
      categories: evaluation.categories,
      scores: evaluation.data,
    },
    peerRankTrend: parseShape(
      peerRankSchema,
      read('Data_rateInSimilarType'),
      'Data_rateInSimilarType',
    ).map((p) => ({
      date: epochMsToDate(p.x, 'Data_rateInSimilarType.x'),
      rank: p.y,
      total: toRequiredNumber(p.sc, 'Data_rateInSimilarType.sc'),
    })),
    peerPercentTrend: parseShape(
      z.array(trendTupleSchema),
      read('Data_rateInSimilarPersent'),
      'Data_rateInSimilarPersent',
    ).map(([x, percentile]) => ({
      date: epochMsToDate(x, 'Data_rateInSimilarPersent.x'),
      percentile,
    })),
  }
}
