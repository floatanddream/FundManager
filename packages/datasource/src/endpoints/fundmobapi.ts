/**
 * `fundmobapi.eastmoney.com/FundMNewApi/*` 端点族：URL 构造 + 解析纯函数。
 *
 * 这是官方**移动端 App** 的接口族，是 `navHistory` / `holdings` / `assetAllocation` 三条降级链的备源
 * （`profile` 不在此列——见下）。实测细节见 `docs/research/2026-11-18-datasource-inventory.md`
 * §1.13–§1.16、§3（本族被列为**最脆弱**的一族）、§6 #10/#11。
 *
 * **三处与其它端点族不同、照惯例会踩的坑：**
 *
 * 1. **不需要 `Referer`，但有 User-Agent 门禁。** 典型的桌面版 Windows Chrome UA 会被拒：
 *    HTTP 200 + `Success:false` + `ErrCode:61136403`，而 `ErrMsg` 是**误导性的「网络繁忙，请稍后重试！」**。
 *    **它不是限流**——照限流做退避重试会永远失败。故本模块把 UA 固定成带 `Mobile` 的，并在错误信息里点明。
 * 2. **报告期在顶层 `Expansion`**（`FundMNInverstPosition` 为 `"2026-09-30"`），**不在 `Datas` 内**——
 *    与 `f10/*` 把时点放在数据行里的惯例相反。
 * 3. `FundMNBasicInformation` / `FundMNDetailInformation` **不接入 `profile` 能力的备源**：
 *    设计 §七 的表据此声明「无备源」。注意 `FundMNDetailInformation` 实测**带** `BENCH`/`PERFCMP`
 *    两个字段（见 `parseMobDetailInformation` 的注释）——但本任务按计划不把它接进 `profile`。
 */
import { z } from 'zod'

import type { HttpRequestSpec } from '../http/client.ts'
import { BusinessCodeError, ParseError } from '../http/errors.ts'

const FUNDMOBAPI_ORIGIN = 'https://fundmobapi.eastmoney.com/FundMNewApi'

/**
 * 本族**唯一被接受**的 User-Agent。
 *
 * 必须是带 `Mobile` 的（实测 iPhone 那条 3/3 成功）。**不要**换成桌面浏览器 UA——
 * 含 `Windows NT 10.0` + `Win64` + `AppleWebKit/537.36 (KHTML, like Gecko)` + `Chrome/…`
 * 的组合会被接口拒绝，且失败信息谎称「网络繁忙」。这条是踩过的坑，换 UA 前先看本注释。
 */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

/**
 * App 协议形状的公共查询参数。
 *
 * **按盘点里实测可用的那组原样使用**（§1.13–§1.16）：`deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=`。
 * `Uid` 为空串（未登录即匿名），实测可用；这些参数随 App 升级可能变化，是 §3 记的脆弱点之一。
 */
const COMMON_PARAMS: readonly [string, string][] = [
  ['deviceid', 'Wap'],
  ['plat', 'Wap'],
  ['product', 'EFund'],
  ['version', '2.0.0'],
  ['Uid', ''],
]

/** UA 被拒的业务码（实测）。`ErrMsg` 会把它误导成「网络繁忙」，故单独识别。 */
const UA_REJECTED_CODE = 61136403

/** 拼 URL：端点自身的参数在前，公共 App 参数在后（`URLSearchParams` 保留插入顺序）。 */
function mobUrl(path: string, params: readonly [string, string][]): string {
  const search = new URLSearchParams()
  for (const [name, value] of [...params, ...COMMON_PARAMS]) search.set(name, value)
  return `${FUNDMOBAPI_ORIGIN}/${path}?${search}`
}

/** 本族请求：**只带 `User-Agent`，不带 `Referer`**（实测加了也无害，但非必需）。 */
function mobRequest(path: string, params: readonly [string, string][]): HttpRequestSpec {
  return { url: mobUrl(path, params), headers: { 'User-Agent': MOBILE_USER_AGENT } }
}

/** 数值字段：接口一律给字符串（`"--"` / 空串 / `null` 表示无数据）。 */
const rawNumber = z.union([z.string(), z.number()]).nullish()

/**
 * 归一数值：`--` / 空串 / `null` → `null`；非空却读不出数抛 `ParseError`（字段格式变了，不许给错值）。
 *
 * @param label 出错时用于定位的字段名（错误信息要能自解释）
 * @returns 数值；无数据时为 `null`。百分数只去掉 `%`，**不做 /100**
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

/**
 * 校验本族统一信封的业务码，返回整个响应对象。
 *
 * 与 `api.fund/f10/*` 一样是**软失败**：HTTP 200 也可能是错误页（`Success:false` / `ErrCode` 非 0）。
 * 故只看状态码一律视为 bug。这里额外把 **UA 被拒**（`ErrCode:61136403`）单独识别出来——
 * 因为它的 `ErrMsg` 谎称「网络繁忙」，若不点破，使用者会去查网络或加重试，永远白费。
 *
 * @returns 已确认 `ErrCode` 为 0 且 `Success` 为真的响应对象（未做字段级结构校验）
 * @throws {ParseError} 响应不是 JSON 对象，或缺少 `ErrCode` 字段（结构已变）
 * @throws {BusinessCodeError} 业务码非 0——含 UA 被拒；重试无意义
 */
function assertMobOk(text: string, endpoint: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new ParseError(`fundmobapi/${endpoint}：响应不是合法 JSON`, { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ParseError(`fundmobapi/${endpoint}：响应不是 JSON 对象`)
  }
  const env = parsed as Record<string, unknown>
  if (typeof env['ErrCode'] !== 'number') {
    throw new ParseError(`fundmobapi/${endpoint}：响应缺少 ErrCode 字段（结构已变）`)
  }
  if (env['ErrCode'] !== 0 || env['Success'] !== true) {
    const errMsg =
      typeof env['ErrMsg'] === 'string' && env['ErrMsg'] !== '' ? env['ErrMsg'] : '（ErrMsg 为空）'
    if (env['ErrCode'] === UA_REJECTED_CODE) {
      throw new BusinessCodeError(
        `fundmobapi/${endpoint} 业务码 ${UA_REJECTED_CODE}：${errMsg} —— ` +
          `这不是网络问题，是 User-Agent 被拒：桌面版 Windows Chrome 的 UA 会被本接口拦截` +
          `（接口的「网络繁忙」是误导信息）。必须固定使用带 Mobile 的 UA；` +
          `也不要按限流做退避重试，那样只会永远失败`,
      )
    }
    throw new BusinessCodeError(
      `fundmobapi/${endpoint} 业务码 ${String(env['ErrCode'])}：${errMsg} —— HTTP 200 不代表成功`,
    )
  }
  return parsed
}

/**
 * 按 Zod schema 校验响应结构。
 *
 * **结构不符必须抛，绝不退化成空集合**（Review Focus #2）：接口改版却返回 `[]`，
 * 用户看到的是「这只基金没有数据」而不是「解析失败」——那正是最危险的静默错值。
 *
 * @throws {ParseError} 结构与预期不符
 */
function parseShape<S extends z.ZodType>(schema: S, value: unknown, endpoint: string): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new ParseError(`fundmobapi/${endpoint}：响应结构不符预期 —— ${result.error.message}`)
  }
  return result.data
}

// ---------------------------------------------------------------------------
// FundMNInverstPosition：持仓（仅前十大，带个股行业与增减持方向）
// ---------------------------------------------------------------------------

/** 一行股票持仓。 */
export type MobHoldingRow = {
  readonly stockCode: string
  readonly stockName: string
  /** 占净值比例（`JZBL`，%，已去 `%` 号但不 /100） */
  readonly navRatio: number | null
  /** 个股所属行业（`INDEXNAME`，细分口径，如「通信」「电子」）——与 `HYPZ` 的国民经济分类**不是一套** */
  readonly industryName: string | null
  /** 相对上期的变动方向（`PCTNVCHGTYPE`），实测「增持」/「减持」 */
  readonly changeType: string | null
  /** 变动幅度（`PCTNVCHG`，单位为占净值比例的百分点） */
  readonly changeValue: number | null
}

/** 一行债券持仓。本接口给债券代码/名称/占净值比例，**不区分增减持**。 */
export type MobBondRow = {
  readonly bondCode: string
  readonly bondName: string
  readonly navRatio: number | null
}

/**
 * `FundMNInverstPosition` 的解析结果。
 *
 * **只有前十大股票持仓**（实测 `fundStocks` 长度 10）——这正是 `holdings` 降级时口径变弱的根源，
 * 故 `loss` 必须在能力层说清楚（见 `capabilities/holdings.ts`）。
 */
export type MobPosition = {
  /** 报告期，取自**顶层 `Expansion`**（如 `"2026-09-30"`），**不在 `Datas` 内** */
  readonly reportDate: string
  readonly stocks: readonly MobHoldingRow[]
  readonly bonds: readonly MobBondRow[]
  /** 联接/ETF 基金的内层标的代码（`ETFCODE`）；非联接基金为 null */
  readonly etfCode: string | null
  readonly etfShortName: string | null
}

const positionSchema = z.object({
  Datas: z.object({
    fundStocks: z
      .array(
        z.object({
          GPDM: z.string(),
          GPJC: z.string(),
          JZBL: rawNumber,
          INDEXNAME: z.string().nullish(),
          PCTNVCHGTYPE: z.string().nullish(),
          PCTNVCHG: rawNumber,
        }),
      )
      .nullish(),
    fundboods: z
      .array(z.object({ ZQDM: z.string(), ZQMC: z.string(), ZJZBL: rawNumber }))
      .nullish(),
    ETFCODE: z.string().nullish(),
    ETFSHORTNAME: z.string().nullish(),
  }),
  Expansion: z.string(),
})

/** 构造 `FundMNInverstPosition` 请求。 */
export function inverstPositionRequest(fundCode: string): HttpRequestSpec {
  return mobRequest('FundMNInverstPosition', [['FCODE', fundCode]])
}

/**
 * 解析 `FundMNInverstPosition`。
 *
 * @throws {BusinessCodeError} 业务码非 0（含 UA 被拒的 `61136403`）
 * @throws {ParseError} 结构不符预期（含 `Expansion` 缺失）
 */
export function parseInverstPosition(text: string): MobPosition {
  const data = parseShape(
    positionSchema,
    assertMobOk(text, 'FundMNInverstPosition'),
    'FundMNInverstPosition',
  )
  return {
    reportDate: data.Expansion,
    stocks: (data.Datas.fundStocks ?? []).map((row) => ({
      stockCode: row.GPDM,
      stockName: row.GPJC,
      navRatio: toNumber(row.JZBL, `FundMNInverstPosition JZBL(${row.GPDM})`),
      industryName: row.INDEXNAME ?? null,
      changeType: row.PCTNVCHGTYPE ?? null,
      changeValue: toNumber(row.PCTNVCHG, `FundMNInverstPosition PCTNVCHG(${row.GPDM})`),
    })),
    bonds: (data.Datas.fundboods ?? []).map((row) => ({
      bondCode: row.ZQDM,
      bondName: row.ZQMC,
      navRatio: toNumber(row.ZJZBL, `FundMNInverstPosition ZJZBL(${row.ZQDM})`),
    })),
    etfCode: data.Datas.ETFCODE ?? null,
    etfShortName: data.Datas.ETFSHORTNAME ?? null,
  }
}

// ---------------------------------------------------------------------------
// FundMNAssetAllocationNew：资产配置（按报告期）
// ---------------------------------------------------------------------------

/**
 * 一个报告期的资产配置。
 *
 * `--`（如货币/债券基金的 `GP`）读作 `null`——**不代表 0**，故本层保留 `null` 不在端点层折算，
 * 由能力层决定怎么进 `CategorizedSeries`。
 */
export type MobAssetAllocationRow = {
  /** 报告期（`FSRQ`），`YYYY-MM-DD` */
  readonly reportDate: string
  /** 股票占净比（`GP`，%） */
  readonly stockRatio: number | null
  /** 债券占净比（`ZQ`，%） */
  readonly bondRatio: number | null
  /** 现金占净比（`HB`，%） */
  readonly cashRatio: number | null
  /** 其他占净比（`QT`，%） */
  readonly otherRatio: number | null
  /** 净资产（`JZC`，亿元） */
  readonly netAsset: number | null
}

const allocationSchema = z.object({
  Datas: z.array(
    z.object({
      FSRQ: z.string(),
      GP: rawNumber,
      ZQ: rawNumber,
      HB: rawNumber,
      QT: rawNumber,
      JZC: rawNumber,
    }),
  ),
})

/** 构造 `FundMNAssetAllocationNew` 请求。 */
export function assetAllocationRequest(fundCode: string): HttpRequestSpec {
  return mobRequest('FundMNAssetAllocationNew', [['FCODE', fundCode]])
}

/**
 * 解析 `FundMNAssetAllocationNew`。
 *
 * 实测**只返回最新一个报告期**（`TotalCount:1`，加 `pageIndex`/`pageSize` 也不变）——
 * 与 `pingzhongdata.Data_assetAllocation` 给多期历史不同，这一点写在能力层注释里。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期
 */
export function parseMobAssetAllocation(text: string): readonly MobAssetAllocationRow[] {
  const data = parseShape(
    allocationSchema,
    assertMobOk(text, 'FundMNAssetAllocationNew'),
    'FundMNAssetAllocationNew',
  )
  return data.Datas.map((row) => ({
    reportDate: row.FSRQ,
    stockRatio: toNumber(row.GP, `FundMNAssetAllocationNew GP(${row.FSRQ})`),
    bondRatio: toNumber(row.ZQ, `FundMNAssetAllocationNew ZQ(${row.FSRQ})`),
    cashRatio: toNumber(row.HB, `FundMNAssetAllocationNew HB(${row.FSRQ})`),
    otherRatio: toNumber(row.QT, `FundMNAssetAllocationNew QT(${row.FSRQ})`),
    netAsset: toNumber(row.JZC, `FundMNAssetAllocationNew JZC(${row.FSRQ})`),
  }))
}

// ---------------------------------------------------------------------------
// FundMNHisNetList：历史净值（移动端，分页；不含分红/拆分字段）
// ---------------------------------------------------------------------------

/**
 * 一行净值。
 *
 * **本端点不含 `FHFCZ`/`FHSP` 等分红/拆分字段**（与 `f10/lsjz` 的关键区别）——
 * 故它作 `navHistory` 备源时的 `loss` 必须写明「丢失分红/拆分事件字段」。
 */
export type MobNavRow = {
  /** 净值日期（`FSRQ`），`YYYY-MM-DD` */
  readonly date: string
  /** 单位净值（`DWJZ`） */
  readonly nav: number | null
  /** 累计净值（`LJJZ`） */
  readonly accNav: number | null
  /** 日增长率（`JZZZL`，百分数） */
  readonly growthRate: number | null
}

/** `FundMNHisNetList` 的**一页**。翻页是能力层的事，故把 `totalCount` 一并交出去（防静默截断成 20 天）。 */
export type MobNavPage = {
  readonly rows: readonly MobNavRow[]
  readonly totalCount: number
}

const hisNetSchema = z.object({
  Datas: z.array(
    z.object({ FSRQ: z.string(), DWJZ: rawNumber, LJJZ: rawNumber, JZZZL: rawNumber }),
  ),
  TotalCount: z.number().int().nonnegative(),
})

export type HisNetListQuery = {
  readonly fundCode: string
  /** 页码，从 1 起；默认 1 */
  readonly pageIndex?: number
  /** 每页条数，默认 20（实测接口认这个参数） */
  readonly pageSize?: number
}

/** 构造 `FundMNHisNetList` 的一页请求。 */
export function hisNetListRequest(query: HisNetListQuery): HttpRequestSpec {
  return mobRequest('FundMNHisNetList', [
    ['FCODE', query.fundCode],
    ['pageIndex', String(query.pageIndex ?? 1)],
    ['pageSize', String(query.pageSize ?? 20)],
  ])
}

/**
 * 解析 `FundMNHisNetList` 的一页。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期
 */
export function parseMobHisNetList(text: string): MobNavPage {
  const page = parseShape(hisNetSchema, assertMobOk(text, 'FundMNHisNetList'), 'FundMNHisNetList')
  return {
    rows: page.Datas.map((row) => ({
      date: row.FSRQ,
      nav: toNumber(row.DWJZ, `FundMNHisNetList DWJZ(${row.FSRQ})`),
      accNav: toNumber(row.LJJZ, `FundMNHisNetList LJJZ(${row.FSRQ})`),
      growthRate: toNumber(row.JZZZL, `FundMNHisNetList JZZZL(${row.FSRQ})`),
    })),
    totalCount: page.TotalCount,
  }
}

// ---------------------------------------------------------------------------
// FundMNBasicInformation / FundMNDetailInformation：基本信息 / 详情
// ---------------------------------------------------------------------------

/** 基本面信息（`FundMNBasicInformation`）。 */
export type MobBasicInformation = {
  readonly fundCode: string
  readonly shortName: string
  /** 基金类型，如「混合型-灵活」 */
  readonly fundType: string
  /** 最新净值日（`FSRQ`），`YYYY-MM-DD` */
  readonly navDate: string
  /** 最新单位净值（`DWJZ`） */
  readonly nav: number | null
  /** 日增长率（`RZDF`，%） */
  readonly growthRate: number | null
  readonly company: string
  /** 基金经理名（`JJJL` 用逗号分隔多人） */
  readonly managers: readonly string[]
}

const basicSchema = z.object({
  Datas: z.object({
    FCODE: z.string(),
    SHORTNAME: z.string(),
    FTYPE: z.string(),
    FSRQ: z.string(),
    DWJZ: rawNumber,
    RZDF: rawNumber,
    JJGS: z.string(),
    JJJL: z.string().nullish(),
  }),
})

/** 构造 `FundMNBasicInformation` 请求。 */
export function basicInformationRequest(fundCode: string): HttpRequestSpec {
  return mobRequest('FundMNBasicInformation', [['FCODE', fundCode]])
}

/**
 * 解析 `FundMNBasicInformation`。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期
 */
export function parseMobBasicInformation(text: string): MobBasicInformation {
  const data = parseShape(
    basicSchema,
    assertMobOk(text, 'FundMNBasicInformation'),
    'FundMNBasicInformation',
  ).Datas
  return {
    fundCode: data.FCODE,
    shortName: data.SHORTNAME,
    fundType: data.FTYPE,
    navDate: data.FSRQ,
    nav: toNumber(data.DWJZ, 'FundMNBasicInformation DWJZ'),
    growthRate: toNumber(data.RZDF, 'FundMNBasicInformation RZDF'),
    company: data.JJGS,
    managers: splitManagers(data.JJJL),
  }
}

/** 详情（`FundMNDetailInformation`）。 */
export type MobDetailInformation = {
  readonly fundCode: string
  readonly fullName: string
  readonly shortName: string
  readonly fundType: string
  /** 成立日期（`ESTABDATE`），`YYYY-MM-DD` */
  readonly establishDate: string
  readonly company: string
  readonly managers: readonly string[]
  /**
   * 业绩比较基准（取 `PERFCMP`，缺失时退回 `BENCH`）。
   *
   * **注**：设计 §七 声明本端点「不含业绩比较基准与跟踪标的」，但实测 `000001` 的 `PERFCMP`/`BENCH`
   * 都有值（与 `jbgk` 的「业绩比较基准」一致）。本字段仅为如实反映响应；**本任务按计划不接 `profile` 备源**，
   * 故它目前没有消费方。
   */
  readonly benchmark: string | null
  /** 跟踪标的代码（`INDEXCODE`）；主动基金实测为 `"--"` → `null` */
  readonly trackingCode: string | null
  /** 跟踪标的名称（`INDEXNAME`）；主动基金实测为 `"--"` → `null` */
  readonly trackingName: string | null
}

const detailSchema = z.object({
  Datas: z.object({
    FCODE: z.string(),
    FULLNAME: z.string(),
    SHORTNAME: z.string(),
    FTYPE: z.string(),
    ESTABDATE: z.string(),
    JJGS: z.string(),
    JJJL: z.string().nullish(),
    BENCH: z.string().nullish(),
    PERFCMP: z.string().nullish(),
    INDEXCODE: z.string().nullish(),
    INDEXNAME: z.string().nullish(),
  }),
})

/** 构造 `FundMNDetailInformation` 请求。 */
export function detailInformationRequest(fundCode: string): HttpRequestSpec {
  return mobRequest('FundMNDetailInformation', [['FCODE', fundCode]])
}

/**
 * 解析 `FundMNDetailInformation`。
 *
 * @throws {BusinessCodeError} 业务码非 0
 * @throws {ParseError} 结构不符预期
 */
export function parseMobDetailInformation(text: string): MobDetailInformation {
  const data = parseShape(
    detailSchema,
    assertMobOk(text, 'FundMNDetailInformation'),
    'FundMNDetailInformation',
  ).Datas
  // "--" 是接口的「无此值」占位（主动基金的跟踪标的字段即如此），归一为 null
  const dashToNull = (value: string | null | undefined): string | null =>
    value === null || value === undefined || value === '--' ? null : value
  return {
    fundCode: data.FCODE,
    fullName: data.FULLNAME,
    shortName: data.SHORTNAME,
    fundType: data.FTYPE,
    establishDate: data.ESTABDATE,
    company: data.JJGS,
    managers: splitManagers(data.JJJL),
    benchmark: dashToNull(data.PERFCMP) ?? dashToNull(data.BENCH),
    trackingCode: dashToNull(data.INDEXCODE),
    trackingName: dashToNull(data.INDEXNAME),
  }
}

/** `JJJL` 用逗号分隔多个人名；空串/缺失 → `[]`。 */
function splitManagers(value: string | null | undefined): readonly string[] {
  if (value === null || value === undefined || value.trim() === '') return []
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
}
