/**
 * 持仓服务：流水 → 持仓（`core/derivePosition`）→ 接最新净值算市值与浮动盈亏。
 *
 * **市值用未复权单位净值 × 份额**（设计 §四.1）：那是真能赎回拿到的钱。复权净值是
 * 分红再投口径，只给风险指标用；拿它算市值会把分红算重。
 *
 * 成本未知（流水中没有买入记录）时 `cost` / `costPerShare` / 浮动盈亏全部为 `null`
 * 并带原因，**不编 0**（§6：此时只做风险跟踪、不显示个人盈亏）。
 */
import {
  derivePosition,
  positionChangedAfter,
  positionMarketValue,
  type LedgerTransaction,
} from '@fundmanager/core'
import { DataSourceError } from '@fundmanager/datasource'
import type { FundDataSource, NavHistory } from '@fundmanager/datasource'
import { approxEqual } from '@fundmanager/shared'
import { fromDerived, fromFetched, type Sourced } from '../envelope.ts'
import type { createTransactionRepository } from '../repository/transactionRepository.ts'
import { navFetchFailure } from './navService.ts'

export type PositionDeps = {
  readonly transactionRepository: Pick<
    ReturnType<typeof createTransactionRepository>,
    'listAll' | 'listByFund'
  >
  readonly dataSource: Pick<FundDataSource, 'navHistory'>
}

/** 一只基金在账本里的持仓。`shares` / `realizedGain` 是账本内生的，不带口径 */
export type PositionView = {
  readonly fundCode: string
  /** 推导截止日，`YYYY-MM-DD` */
  readonly asOf: string
  readonly shares: number
  readonly cost: Sourced<number>
  readonly costPerShare: Sourced<number>
  /** 份额 × 最新**未复权**净值；净值取不到时 `value` 为 null */
  readonly marketValue: Sourced<number>
  /** 市值 − 成本；成本或净值已知不了时为 null */
  readonly unrealizedGain: Sourced<number>
  readonly realizedGain: number
}

/** 成本未知的统一说法：前端直接显示，也让「为什么不给盈亏」自解释 */
const COST_UNKNOWN = '成本未知（流水中没有买入记录），只能做风险跟踪，不显示个人盈亏'
const NAV_MISSING = '净值历史里没有截止日当天及以前的净值，无法计算市值'
const WAITING_FOR_NAV = '最近的确认净值早于本次持仓变动，等待对应净值后再计算市值'
const NO_SHARES = '份额为 0，单位成本无意义'

/** 当前时刻，带中国时区的 ISO 8601——与数据源层 `capturedAt` 同一格式 */
const capturedAtNow = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')

/** 中国时区的今天（`YYYY-MM-DD`） */
const todayInChina = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

/**
 * 本地账本数据的信封：可信度由账本本身保证、由对账守，故 `stale` 恒 false、无口径损失。
 * 字段仍填满，前端不必为两种形状写两套解析。
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

/** 市值只需未复权净值。清仓后已知市值为零，也无需访问上游。 */
async function getMarketValue(
  deps: PositionDeps,
  transactions: readonly LedgerTransaction[],
  ledgerId: string,
  fundCode: string,
  asOf: string,
  shares: number,
): Promise<Sourced<number>> {
  if (approxEqual(shares, 0)) return fromLedger(0, null, asOf)

  let nav: Sourced<NavHistory>
  try {
    nav = fromFetched(await deps.dataSource.navHistory(fundCode))
  } catch (error) {
    if (!(error instanceof DataSourceError)) throw error
    nav = navFetchFailure(fundCode, asOf, error)
  }

  const latest = nav.value?.rows.find((row) => row.nav.date <= asOf)?.nav
  if (!latest) return fromDerived<number>(null, nav.reason ?? NAV_MISSING, [nav])

  const input = { ...nav, dataAsOf: latest.date }
  const hasNewPositionChange = positionChangedAfter(
    transactions,
    ledgerId,
    fundCode,
    latest.date,
    asOf,
  )
  return hasNewPositionChange
    ? fromDerived<number>(null, WAITING_FOR_NAV, [input])
    : fromDerived(positionMarketValue(shares, latest), null, [input])
}

/**
 * 推导单只基金的持仓视图。
 *
 * @param transactions 可以是全账本流水；`derivePosition` 负责按 `ledgerId` / `fundCode` 筛选——
 *   **必须传 `ledgerId`**，否则两个账本买同一只基金会被加在一起
 */
async function buildPosition(
  deps: PositionDeps,
  transactions: readonly LedgerTransaction[],
  ledgerId: string,
  fundCode: string,
  asOf: string,
): Promise<PositionView> {
  const position = derivePosition(transactions, ledgerId, fundCode, asOf)

  const marketValue = await getMarketValue(
    deps,
    transactions,
    ledgerId,
    fundCode,
    asOf,
    position.shares,
  )

  const cost = fromLedger(position.cost, position.cost === null ? COST_UNKNOWN : null, asOf)
  const costPerShare = fromLedger(
    position.costPerShare,
    position.cost === null ? COST_UNKNOWN : position.costPerShare === null ? NO_SHARES : null,
    asOf,
  )
  const unrealizedGain = fromDerived(
    position.cost === null || marketValue.value === null ? null : marketValue.value - position.cost,
    position.cost === null ? `${COST_UNKNOWN}，无法计算浮动盈亏` : marketValue.reason,
    [cost, marketValue],
  )

  return {
    fundCode,
    asOf,
    shares: position.shares,
    cost,
    costPerShare,
    marketValue,
    unrealizedGain,
    realizedGain: position.realizedGain,
  }
}

/**
 * 该账本的全部持仓：账本里出现过的每只基金一行，份额为 0（已全部赎回）也保留——
 * 它的已实现收益仍要看，成本未知的行正是 §6 要说明「为什么没有盈亏」的那一类。
 *
 * @param opts.asOf 推导截止日，缺省为今天（中国时区）
 * @returns 列表信封取各行最早的数据时点；`stale` / `loss` 从净值穿透，任一持仓的
 *   净值降级都会反映到列表上。账本一笔流水都没有时为空列表，不是 null
 */
export async function listPositions(
  deps: PositionDeps,
  ledgerId: string,
  opts: { readonly asOf?: string } = {},
): Promise<Sourced<readonly PositionView[]>> {
  const asOf = opts.asOf ?? todayInChina()
  const all = await deps.transactionRepository.listAll(ledgerId)
  const fundCodes = [...new Set(all.map((t) => t.fundCode))]
  if (fundCodes.length === 0) return fromLedger<readonly PositionView[]>([], null, asOf)
  const views = await Promise.all(
    fundCodes.map((code) => buildPosition(deps, all, ledgerId, code, asOf)),
  )
  return fromDerived(
    views,
    null,
    views.flatMap((view) => [view.marketValue, view.cost]),
  )
}

/**
 * 单只基金在该账本里的持仓。
 *
 * @returns 该基金在账本里**一笔流水都没有**时为 `null`（路由据此回 404：查错了对象，
 *   不是「0 份额持仓」）；否则即使份额为 0 也照常返回，已实现收益仍可看
 */
export async function getFundPosition(
  deps: PositionDeps,
  ledgerId: string,
  fundCode: string,
  opts: { readonly asOf?: string } = {},
): Promise<Sourced<PositionView> | null> {
  const asOf = opts.asOf ?? todayInChina()
  const transactions = await deps.transactionRepository.listByFund(ledgerId, fundCode)
  if (transactions.length === 0) return null
  const view = await buildPosition(deps, transactions, ledgerId, fundCode, asOf)
  return fromDerived(view, null, [view.marketValue, view.cost])
}
