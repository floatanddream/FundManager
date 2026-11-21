import { assertDate } from '@fundmanager/shared'
import type { NavConfirmed } from '@fundmanager/shared'
import { approxEqual } from '@fundmanager/shared'
import { derivePosition } from './position.ts'
import type { LedgerTransaction } from './types.ts'
import { toCashFlows } from './cashflow.ts'
import { positionMarketValue } from './marketValue.ts'
import type { NavSeriesRow } from '../risk/adjusted.ts'

export type DailyGainInput = {
  readonly ledgerId: string
  readonly fundCode: string
  readonly transactions: readonly LedgerTransaction[]
  readonly previousDate: string
  readonly valuationDate: string
  readonly previousNav: NavConfirmed | null
  readonly latestNav: NavConfirmed | null
}

/**
 * 计算一只基金在统一净值窗口内的账本日收益。
 *
 * @returns 人民币元；有份额但缺少对应日期的确认净值时返回 null。
 * @throws {TypeError} 估值日期、输入净值或账本流水不合法。
 */
export function calculateDailyGain(input: DailyGainInput): number | null {
  const { ledgerId, fundCode, transactions, previousDate, valuationDate, previousNav, latestNav } =
    input
  assertDate(previousDate, 'previousDate')
  assertDate(valuationDate, 'valuationDate')
  if (previousDate >= valuationDate) throw new TypeError('previousDate 必须早于 valuationDate')
  for (const [label, nav, date] of [
    ['previousNav', previousNav, previousDate],
    ['latestNav', latestNav, valuationDate],
  ] as const) {
    if (
      nav &&
      (nav.kind !== 'nav' || !Number.isFinite(nav.value) || nav.value < 0 || nav.date !== date)
    ) {
      throw new TypeError(`${label} 必须是对应净值日的有效确认净值`)
    }
  }
  const start = derivePosition(transactions, ledgerId, fundCode, previousDate)
  const end = derivePosition(transactions, ledgerId, fundCode, valuationDate)
  if (
    (!approxEqual(start.shares, 0) && previousNav === null) ||
    (!approxEqual(end.shares, 0) && latestNav === null)
  )
    return null
  const startValue = previousNav === null ? 0 : positionMarketValue(start.shares, previousNav)
  const endValue = latestNav === null ? 0 : positionMarketValue(end.shares, latestNav)
  const externalFlows = toCashFlows(transactions, ledgerId, fundCode)
    .filter((t) => t.date > previousDate && t.date <= valuationDate)
    .reduce((sum, t) => sum + t.amount, 0)
  return endValue - startValue + externalFlows
}

/**
 * 检查区间分红、折算能否逐笔对应。除息和到账错日时，当前账本无法确定收益归属。
 *
 * @param input 与收益相同的账本和估值日期，不带净值。
 * @param rows 该基金在区间内的确认净值行，包含事件。
 * @throws {TypeError} 传入的账本流水不合法。
 */
export function matchesDailyGainEvents(
  input: Omit<DailyGainInput, 'previousNav' | 'latestNav'>,
  rows: readonly NavSeriesRow[],
): boolean {
  const { ledgerId, fundCode, transactions, previousDate, valuationDate } = input
  const actions = transactions.filter(
    (t) =>
      t.ledgerId === ledgerId &&
      t.fundCode === fundCode &&
      t.status === 'confirmed' &&
      t.date > previousDate &&
      t.date <= valuationDate &&
      (t.kind === 'dividend_cash' || t.kind === 'dividend_reinvest' || t.kind === 'split'),
  )
  const matched = new Set<LedgerTransaction>()
  for (const { nav, event } of rows) {
    if (!event) continue
    // 公告分红或折算针对事件前持仓，不能用当日申购后的份额核对。
    const before = derivePosition(
      transactions.filter((t) => t.date < nav.date),
      ledgerId,
      fundCode,
      nav.date,
    )
    if (approxEqual(before.shares, 0)) continue
    const sameDay = actions.filter((t) => t.date === nav.date)
    const action = sameDay[0]
    if (!action || sameDay.length !== 1 || matched.has(action)) return false
    if (event.kind === 'split') {
      if (
        action.kind !== 'split' ||
        action.splitRatio === null ||
        event.perUnit === null ||
        !approxEqual(action.splitRatio, event.perUnit)
      )
        return false
    } else if (event.kind === 'dividend') {
      const perUnit = event.perUnit ?? (event.per10Unit === null ? null : event.per10Unit / 10)
      if (
        (action.kind !== 'dividend_cash' && action.kind !== 'dividend_reinvest') ||
        perUnit === null ||
        perUnit <= 0 ||
        !approxEqual(action.amount - before.shares * perUnit, 0, 0.01)
      )
        return false
    } else {
      return false
    }
    matched.add(action)
  }
  return matched.size === actions.length
}

/** 市值可用且成本已知并为正时，才有可解释的持有收益率。 */
export function calculateHoldingGainRate(gain: number | null, cost: number | null): number | null {
  return gain === null || cost === null || cost <= 0 ? null : gain / cost
}

/** 成本未知时不计算持有收益。 */
export function calculateHoldingGain(value: number | null, cost: number | null): number | null {
  return value === null || cost === null ? null : value - cost
}

/** 汇总已知金额。没有参与项时沿用调用方给出的空值口径。 */
export function sumKnownAmounts(values: readonly (number | null)[], empty: number | null) {
  const known = values.filter((value): value is number => value !== null)
  return {
    value: known.length ? known.reduce((sum, value) => sum + value, 0) : empty,
    coverage: { included: known.length, total: values.length },
  }
}
