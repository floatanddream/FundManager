/**
 * 风险服务：单基金风险与组合风险（设计 §六）。
 *
 * **输入只认 `getNav` 的 `adjusted`**（设计 §四.1）：未复权单位净值在分红除息日会
 * 机械下跌，喂进风险函数会造出假回撤与虚高的波动率。复权在 `navService` 里一次做完，
 * 本文件只消费 `AdjustedNav[]`——没有强转，类型对不上就编译不过。
 *
 * Service 不写算式（§二 规则 1）：波动、回撤、相关性、组合指数合成都调
 * `@fundmanager/core`。这里只编排「取哪几条序列、权重是多少、各指标失败时说什么」。
 */
import {
  annualizedVolatility,
  compositeAdjustedSeries,
  correlationMatrix,
  currentDrawdown,
  derivePosition,
  downsideDeviation,
  drawdownRecoveryDays,
  maxDrawdown,
} from '@fundmanager/core'
import {
  DataSourceError,
  type FundDataSource,
  type NavHistory as RawNavHistory,
} from '@fundmanager/datasource'
import type { AdjustedNav } from '@fundmanager/shared'
import { fromDerived, type Sourced } from '../envelope.ts'
import type { createTransactionRepository } from '../repository/transactionRepository.ts'
import { getNav, navFetchFailure } from './navService.ts'

/** 风险指标信封：`value` 为 null 时 `reason` 说明为什么算不出来（§8.3：不是 0） */
export type RiskMetric = Sourced<number | null>

/** 单只基金的风险画像。所有指标都来自**复权**净值序列 */
export type FundRisk = {
  readonly fundCode: string
  /** 年化波动率（样本标准差 × √252） */
  readonly annualizedVolatility: RiskMetric
  /** 年化下行波动（目标收益 0） */
  readonly downsideDeviation: RiskMetric
  /** 最大回撤（非负幅度，0.5 表示跌 50%） */
  readonly maxDrawdown: RiskMetric
  /** 最大回撤的修复天数；从未回撤或至今未修复为 null */
  readonly drawdownRecoveryDays: RiskMetric
  /** 序列末点相对历史峰值的跌幅 */
  readonly currentDrawdown: RiskMetric
}

/** 组合内一只基金的参与情况；权重为市值权重 */
export type PortfolioMember = {
  readonly fundCode: string
  /** 份额 × 最新未复权净值；净值取不到为 null（该基金无法加权） */
  readonly marketValue: number | null
  /** 市值占比 [0, 1]；无法加权时为 null */
  readonly weight: number | null
  /** 复权序列的观测点数；0 表示该基金没进组合指数 */
  readonly observations: number
}

/** 组合风险画像 */
export type PortfolioRisk = {
  /** 与 `members` 同序的相关性矩阵；不足两只基金或观测不足时为 null */
  readonly correlation: Sourced<readonly (readonly number[])[] | null>
  /** 组合指数（**市值加权**）的最大回撤 */
  readonly maxDrawdown: RiskMetric
  /** 组合指数的当前回撤 */
  readonly currentDrawdown: RiskMetric
  /** 参与组合的基金 */
  readonly members: readonly PortfolioMember[]
}

export type RiskDeps = {
  readonly dataSource: Pick<FundDataSource, 'navHistory'>
}

export type PortfolioRiskDeps = RiskDeps & {
  readonly transactionRepository: Pick<
    ReturnType<typeof createTransactionRepository>,
    'listAll' | 'listByFund'
  >
}

const NO_HOLDINGS = '该账本没有持仓'
const NO_ADJUSTED = '无法取得复权净值，风险指标不可计算'
const FEW_OBSERVATIONS = '复权净值观测不足，样本方差无定义'
const NO_DRAWDOWN = '复权净值不足两点，回撤无定义'
const NO_RECOVERY = '从未回撤，或最大回撤至今尚未修复'
const NO_MARKET_VALUE = '无法取得持仓的最新净值，组合权重不可计算'
const NO_COMMON_DATES = '各基金的复权净值没有共同交易日，无法合成组合序列'

/**
 * 信封契约：`reason` **只在 `value` 为 null 时出现**。
 *
 * 原实现让 `reason` 只看「序列够不够长」而不看 `value` 是否算出来了，
 * 于是回撤算出了数、`reason` 还写着「回撤无定义」——两字段同时非 null，
 * 前端无从判断该信哪个。
 */
function reasonOnlyIfNull(value: number | null, reason: string | null): string | null {
  return value === null ? (reason ?? '无法计算') : null
}

/** 波动类指标至少需要 3 个净值点（2 个收益观测）才有样本方差 */
const MIN_POINTS = 3

/** 当前时刻，带中国时区的 ISO 8601——与数据源层 `capturedAt` 同一格式 */
const capturedAtNow = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')

/** 中国时区的今天（`YYYY-MM-DD`） */
const todayInChina = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

/**
 * 本地账本数据的信封：可信度由账本本身保证，故 `stale` 恒 false、无口径损失。
 * 组合风险里用来给派生值提供「账本时点」这个输入。
 */
const fromLedger = <T>(value: T | null, reason: string | null, asOf: string): Sourced<T> => ({
  value,
  reason,
  source: 'repository/transaction',
  dataAsOf: asOf,
  capturedAt: capturedAtNow(),
  stale: false,
  loss: null,
  provenance: [],
})

/**
 * 指标信封：时点取序列末点，`stale` / `loss` 从复权序列穿透。
 *
 * 复权缺分红事件时 `adjusted.loss` 非空，风险数字不能以 `loss: null` 的样子出现
 * （反目标 A3）。
 */
const metric = (input: Sourced<unknown>, value: number | null, reason: string | null): RiskMetric =>
  fromDerived(value, reason, [input])

/**
 * 一只基金的风险指标。
 *
 * @param deps 只需 `navHistory`，便于测试注入构造序列
 * @param fundCode 6 位基金代码
 * @returns `adjusted` 取不到时五项指标全为 `value: null` + `reason`；
 *   `adjusted.loss` 非空（备源缺事件）时各指标一并带出
 */
export async function getFundRisk(deps: RiskDeps, fundCode: string): Promise<FundRisk> {
  const { adjusted } = await getNav(deps, fundCode)
  const series = adjusted.value
  if (series === null) return emptyFundRisk(fundCode, adjusted, NO_ADJUSTED)

  // 风险函数观测不足时各自返回 null；统一用「观测不足」作原因，比逐项另编文案更可读
  const tooShort = series.length < MIN_POINTS
  const reasonFor = (value: number | null, fallback: string): string | null =>
    value !== null ? null : tooShort ? FEW_OBSERVATIONS : fallback

  const volatility = annualizedVolatility(series)
  const downside = downsideDeviation(series)
  const drawdown = maxDrawdown(series)
  const recovery = drawdownRecoveryDays(series)
  const current = currentDrawdown(series)

  return {
    fundCode,
    annualizedVolatility: metric(adjusted, volatility, reasonFor(volatility, FEW_OBSERVATIONS)),
    downsideDeviation: metric(adjusted, downside, reasonFor(downside, FEW_OBSERVATIONS)),
    maxDrawdown: metric(adjusted, drawdown, reasonFor(drawdown, NO_DRAWDOWN)),
    drawdownRecoveryDays: metric(adjusted, recovery, reasonFor(recovery, NO_RECOVERY)),
    currentDrawdown: metric(adjusted, current, reasonFor(current, NO_DRAWDOWN)),
  }
}

/** 复权取不到时五项指标一起为 null、共用一条 reason，避免前端逐项辨认 */
const emptyFundRisk = (fundCode: string, adjusted: Sourced<unknown>, reason: string): FundRisk => {
  const empty = metric(adjusted, null, reason)
  return {
    fundCode,
    annualizedVolatility: empty,
    downsideDeviation: empty,
    maxDrawdown: empty,
    drawdownRecoveryDays: empty,
    currentDrawdown: empty,
  }
}

/** 组合风险计算前的单只基金中间态 */
type HeldFund = {
  readonly fundCode: string
  readonly marketValue: number | null
  readonly adjusted: Sourced<AdjustedNav[]>
}

/**
 * 取一只基金的净值；数据源失败时装成信封返回，不打挂整个组合。
 *
 * 失败的那只基金 `marketValue` 与 `adjusted` 都为 null，随后被排除出组合指数，
 * 并按既有「口径不全」路径写进组合信封的 `loss`——与「取不到复权序列」同一形态。
 */
async function navOrFailure(
  deps: RiskDeps,
  fundCode: string,
  asOf: string,
): Promise<{
  nav: Sourced<RawNavHistory>
  adjusted: Sourced<AdjustedNav[]>
}> {
  try {
    return await getNav(deps, fundCode)
  } catch (error) {
    if (!(error instanceof DataSourceError)) throw error
    const failed = navFetchFailure<RawNavHistory>(fundCode, asOf, error)
    // 取数失败时两个口径都拿不到。`adjusted` 用 `null` 表达「没有序列」，
    // 不把失败的 `nav` 信封硬转成 `AdjustedNav[]` 的形状——那是在说谎
    return { nav: failed, adjusted: navFetchFailure<AdjustedNav[]>(fundCode, asOf, error) }
  }
}

/**
 * 组合风险：账本内每只基金的**复权**序列做两两相关；组合回撤按**市值加权**合成
 * 一条复权序列后再算（合成算法在 `core/compositeAdjustedSeries`）。
 *
 * @param deps 账本流水 + 净值数据源
 * @param opts.asOf 推导截止日，缺省为今天（中国时区）
 * @returns 账本没有持仓（无流水或份额全为 0）时 `value: null` +
 *   `reason: '该账本没有持仓'`，不是空对象；份额 > 0 但没有一只拿到最新净值时
 *   同样 `value: null` 并说明原因
 *
 * @remarks 某只基金取不到复权序列时它不进组合指数与相关性矩阵（权重让给其余基金），
 * 但**不静默**：它的 `observations` 为 0，组合信封的 `loss` 点名该基金
 *
 * @remarks 权重取**截止日**的市值，并在整段历史上保持不变。账本只存流水、不存每日持仓，
 * 历史权重无从还原；这是个近似，组合回撤因此是「按今天的配置回看历史」，不是真实账户的
 * 历史轨迹。要还原真实轨迹得先有估值点序列（TWR 那件事，设计 §三 未做）。
 */
export async function getPortfolioRisk(
  deps: PortfolioRiskDeps,
  ledgerId: string,
  opts: { readonly asOf?: string } = {},
): Promise<Sourced<PortfolioRisk | null>> {
  const asOf = opts.asOf ?? todayInChina()
  const all = await deps.transactionRepository.listAll(ledgerId)
  const fundCodes = [...new Set(all.map((tx) => tx.fundCode))]

  const held = await Promise.all(
    fundCodes.map(async (fundCode): Promise<HeldFund | null> => {
      const shares = derivePosition(all, ledgerId, fundCode, asOf).shares
      // 已全部赎回的不算持仓；它的风险已不是「你现在承担的风险」
      if (shares <= 0) return null
      const { nav, adjusted } = await navOrFailure(deps, fundCode, asOf)
      // 市值用**未复权**单位净值 × 份额——那是真能赎回拿到的钱（设计 §四.1）
      const latest = nav.value?.rows.find((row) => row.nav.date <= asOf) ?? null
      const marketValue = latest === null ? null : shares * latest.nav.value
      return { fundCode, marketValue, adjusted }
    }),
  )
  const funds = held.filter((h): h is HeldFund => h !== null)
  if (funds.length === 0) return fromLedger(null, NO_HOLDINGS, asOf)

  const priced = funds.filter(
    (h): h is HeldFund & { marketValue: number } => h.marketValue !== null,
  )
  if (priced.length === 0) return fromLedger(null, NO_MARKET_VALUE, asOf)

  const totalValue = priced.reduce((sum, h) => sum + h.marketValue, 0)
  const weightOf = new Map(priced.map((h) => [h.fundCode, h.marketValue / totalValue]))
  const inputs: Sourced<unknown>[] = [fromLedger(asOf, null, asOf), ...funds.map((h) => h.adjusted)]

  // 只有拿到最新净值（有市值权重）且取到复权序列的基金能进组合指数与相关矩阵
  const usable = funds.filter(
    (h): h is HeldFund & { adjusted: Sourced<AdjustedNav[]> & { value: AdjustedNav[] } } =>
      h.adjusted.value !== null && weightOf.has(h.fundCode),
  )
  // 相关性的信封输入：全都没有可用序列时退回各基金的信封（reason 里已说明），
  // `fromDerived` 不接受空输入
  const usableInputs =
    usable.length > 0 ? usable.map((h) => h.adjusted) : funds.map((h) => h.adjusted)
  const usableWeights = usable.map((h) => weightOf.get(h.fundCode)!)
  const composite =
    usable.length === 0
      ? []
      : compositeAdjustedSeries(
          usable.map((h) => h.adjusted.value),
          usableWeights,
        )
  // 合成序列的信封：输入是各基金的复权序列，stale / loss 与最早时点由此汇聚
  const compositeInput =
    usable.length === 0
      ? fromLedger<number>(null, NO_COMMON_DATES, asOf)
      : fromDerived(
          usable.map((h) => h.adjusted.value),
          null,
          usable.map((h) => h.adjusted),
        )

  const correlation =
    usable.length < 2 ? null : correlationMatrix(usable.map((h) => h.adjusted.value))
  const correlationReason =
    usable.length === 0
      ? '没有可用的复权净值序列，相关性无定义'
      : usable.length < 2
        ? '不足两只基金，相关性无定义'
        : '各基金没有足够的共同交易日收益观测'
  // 只算一次：下面 value 与 reason 两处必须基于同一个数，各算一遍迟早漂
  const portfolioDrawdown = composite.length < 2 ? null : maxDrawdown(composite)
  const portfolioCurrent = composite.length < 2 ? null : currentDrawdown(composite)
  const risk: PortfolioRisk = {
    correlation: fromDerived(
      correlation?.matrix ?? null,
      correlation === null ? correlationReason : null,
      usableInputs,
    ),
    // 合成序列一点都没有 = 没有共同交易日；只有一天 = 回撤无定义——两者原因不同
    maxDrawdown: metric(
      compositeInput,
      portfolioDrawdown,
      reasonOnlyIfNull(portfolioDrawdown, composite.length === 0 ? NO_COMMON_DATES : NO_DRAWDOWN),
    ),
    currentDrawdown: metric(
      compositeInput,
      portfolioCurrent,
      reasonOnlyIfNull(portfolioCurrent, composite.length === 0 ? NO_COMMON_DATES : NO_DRAWDOWN),
    ),
    members: funds.map((h) => ({
      fundCode: h.fundCode,
      marketValue: h.marketValue,
      weight: weightOf.get(h.fundCode) ?? null,
      observations: h.adjusted.value?.length ?? 0,
    })),
  }

  const envelope = fromDerived<PortfolioRisk | null>(risk, null, inputs)
  // 取不到复权净值或无最新净值的基金被排除在组合外：组合口径已不等于用户的完整持仓
  const excluded = funds
    .filter((h) => h.marketValue === null || h.adjusted.value === null)
    .map((h) => h.fundCode)
  if (excluded.length === 0) return envelope
  return {
    ...envelope,
    loss: [envelope.loss, `以下基金口径不全，未计入组合：${excluded.join('、')}`]
      .filter((s): s is string => s !== null)
      .join('；'),
  }
}
