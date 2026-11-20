/**
 * 净值服务：取净值历史，并在这一层**完成复权**（设计 §四.2）。
 *
 * 本文件是全仓库**唯一** import `toAdjustedSeries` 的地方。风险指标只认品牌类型
 * `AdjustedNav`；若把数据源的原始 `NavHistory.rows[].nav` 直接往下传，编译期虽然会被
 * 拦住，但最省事的绕法是 `as unknown as`——所以复权必须在服务端一次做对，下游只消费结果。
 *
 * 两个口径同时返回（设计 §四.1）：`nav` 是原始未复权净值（市值、XIRR 用），
 * `adjusted` 是分红再投口径（风险指标用）。**混用会把同一笔分红算两次。**
 */
import { toAdjustedSeries } from '@fundmanager/core'
import type { DataSourceError, Fetched, FundDataSource, NavHistory } from '@fundmanager/datasource'
import type { AdjustedNav } from '@fundmanager/shared'
import { fromDerived, fromFetched, type Sourced } from '../envelope.ts'

/** 净值历史的日期区间，两端含；`YYYY-MM-DD` */
export type NavRange = {
  readonly startDate?: string
  readonly endDate?: string
}

export type NavResult = {
  /** 原始未复权净值历史（数据源的降序） */
  readonly nav: Sourced<NavHistory>
  /** 复权净值序列（`toAdjustedSeries` 的升序输出）；无法复权时 `value` 为 null 并带原因 */
  readonly adjusted: Sourced<AdjustedNav[]>
}

/**
 * 备源降级时追加到 `adjusted.loss` 的口径说明。
 *
 * `navHistory` 的备源（`pingzhongdata` / `fundmobapi`）没有分红/拆分事件字段，复权只能
 * 按普通日处理，结果可能仍含除息造成的假回撤。不说明就等于把「复权」标签贴在一条
 * 可能未复权的序列上——正是反目标 A3。
 */
const DEGRADED_ADJUSTED_LOSS = '复权时缺分红/拆分事件，只能按普通日处理，序列可能仍含假回撤'

/** 当前时刻，带中国时区的 ISO 8601——与数据源层 `capturedAt` 同一格式 */
const capturedAtNow = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')

/**
 * 取数失败时的信封：`value` 为 null、`reason` 说明是**取数失败**而非「没有数据」。
 *
 * 账本列表与组合风险里，单只基金取不到净值不能打挂整条路由：调用方 catch 住
 * `DataSourceError` 后用它继续，让其余基金照常出数。`loss` 点名基金代码，
 * 列表信封由 `fromDerived` 汇聚 loss 时就能指出是哪一只。
 */
export function navFetchFailure<T>(
  fundCode: string,
  asOf: string,
  error: DataSourceError,
): Sourced<T> {
  return {
    value: null,
    reason: `该基金净值取数失败：${error.message}`,
    source: 'datasource/navHistory',
    dataAsOf: asOf,
    capturedAt: capturedAtNow(),
    stale: false,
    loss: `${fundCode} 净值取数失败`,
    provenance: [],
  }
}

/**
 * 取一只基金的净值历史，并产出两个口径。
 *
 * @param deps 只需 `navHistory`，便于测试注入假数据源
 * @param fundCode 6 位基金代码
 * @param range 日期区间；缺省取全量
 * @returns `nav` 与 `adjusted` 各一份信封，`stale` / `loss` 从数据源穿透
 *
 * @remarks 复权失败（`toAdjustedSeries` 抛 `TypeError`，如分红口径矛盾）**不拖垮整个端点**：
 * `adjusted.value` 为 null 并带原因，原始净值仍然可看。数据问题不应表现为入参错误。
 */
export async function getNav(
  deps: { readonly dataSource: Pick<FundDataSource, 'navHistory'> },
  fundCode: string,
  range: NavRange = {},
): Promise<NavResult> {
  const fetched: Fetched<NavHistory> = await deps.dataSource.navHistory(fundCode, range)
  const nav = fromFetched(fetched)
  const rows = fetched.value.rows

  let series: AdjustedNav[]
  try {
    series = toAdjustedSeries(rows, fundCode)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return { nav, adjusted: fromDerived<AdjustedNav[]>(null, `无法复权：${error.message}`, [nav]) }
  }

  // 备源降级（nav.loss 非空）意味着事件字段全缺，复权结果可能仍含假回撤：在 loss 上追加说明
  const loss = nav.loss === null ? null : `${nav.loss}；${DEGRADED_ADJUSTED_LOSS}`
  return { nav, adjusted: { ...fromDerived(series, null, [nav]), loss } }
}
