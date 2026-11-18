import { approxEqual, assertDate } from '@fundmanager/shared'

/** 一笔现金流。amount 负数为投入，正数为收回。date 为 YYYY-MM-DD。 */
export type CashFlow = {
  readonly date: string
  readonly amount: number
}

/**
 * 归一化现金流：按日期升序排序，同日期多笔合并求和，合并后归零的笔次剔除。
 *
 * XIRR 以首笔为时间基准，若日期乱序，贴现指数会算错，故必须先归一。
 *
 * @param flows 原始现金流，顺序任意
 * @returns 新数组，按日期升序；不修改入参
 * @throws {TypeError} 任一 date 非法，或任一 amount 不是有限数
 */
export function normalizeFlows(flows: readonly CashFlow[]): CashFlow[] {
  const merged = new Map<string, number>()
  for (const f of flows) {
    assertDate(f.date, 'CashFlow.date')
    if (!Number.isFinite(f.amount)) {
      throw new TypeError(`CashFlow.amount 必须是有限数，收到：${f.amount}`)
    }
    merged.set(f.date, (merged.get(f.date) ?? 0) + f.amount)
  }
  return (
    [...merged.entries()]
      // 同一天一进一出相抵为 0 的，不是现金流，留着会污染笔数判断（如 xirr 的「至少两笔」）
      .filter(([, amount]) => !approxEqual(amount, 0))
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date))
  )
}
