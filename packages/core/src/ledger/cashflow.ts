import type { CashFlow } from '../returns/cashflow.ts'
import type { LedgerTransaction } from './types.ts'

/**
 * 从某只基金的全部流水导出**外部现金流**序列，作为 XIRR 的输入。
 *
 * **只导出真正进出账本的钱**，即 `subscribe` / `redeem` / `dividend_cash` 三类；
 * `dividend_reinvest` 与 `split` 不产生外部现金流——再投是基金内部换份额，
 * 折算是基金自己变份额，钱没有进出账本（设计 §八）。
 *
 * `amount` 符号沿用账本口径：**流向账本为正**（赎回、现金分红），**流出为负**（申购）。
 *
 * **本函数不调用 `xirr`，也不该在这里调用。** XIRR 需要「当前市值」当最后一笔现金流，
 * 那是估值、属计划 5；本层不知道今天的净值，调了只能编。这里只产出纯流水，
 * 收益率的求解留给有市值的一方。
 *
 * @param transactions 全部流水（可含待确认、其他基金的），这里负责筛选
 * @param fundCode 只看这一只基金
 * @returns 新数组，按日期升序；不合并同日，不修改入参
 */
export function toCashFlows(
  transactions: readonly LedgerTransaction[],
  fundCode: string,
): readonly CashFlow[] {
  return (
    transactions
      .filter(
        (t) =>
          t.status === 'confirmed' &&
          t.fundCode === fundCode &&
          (t.kind === 'subscribe' || t.kind === 'redeem' || t.kind === 'dividend_cash'),
      )
      // 日期是 YYYY-MM-DD，字典序即时间序
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((t) => ({ date: t.date, amount: t.amount }))
  )
}
