import type { NavConfirmed } from '@fundmanager/shared'
import type { LedgerTransaction } from './types.ts'

/**
 * 判断净值日之后是否有影响份额或成本的已确认流水，防止把旧净值套到新持仓。
 * 普通现金分红不改变份额或成本。
 */
export function positionChangedAfter(
  transactions: readonly LedgerTransaction[],
  ledgerId: string,
  fundCode: string,
  valuationDate: string,
  through: string,
): boolean {
  return transactions.some(
    (t) =>
      t.status === 'confirmed' &&
      t.ledgerId === ledgerId &&
      t.fundCode === fundCode &&
      t.date > valuationDate &&
      t.date <= through &&
      t.kind !== 'dividend_cash',
  )
}

/**
 * 计算历史持仓市值。调用方需传入与净值同日的账本份额及未复权确认单位净值。
 *
 * @throws {TypeError} 份额并非非负有限数。
 */
export function positionMarketValue(shares: number, nav: NavConfirmed): number {
  if (!Number.isFinite(shares) || shares < 0) {
    throw new TypeError('计算市值时，份额必须是非负有限数')
  }
  return shares * nav.value
}
