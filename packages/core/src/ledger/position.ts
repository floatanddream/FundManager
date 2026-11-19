import { assertDate } from '@fundmanager/shared'
import type { LedgerPosition, LedgerTransaction } from './types.ts'

/**
 * 从流水推导某只基金在某日的持仓份额。
 *
 * 纯函数：不读时钟、不做 IO，`asOf` 由调用方给。只吃 `status === 'confirmed'`
 * 的流水——待确认流水被算进持仓就是静默算错账，这条是契约而非优化。
 *
 * @param transactions 流水，顺序任意；可含其他基金与其他账本
 * @param fundCode 要推导的基金代码
 * @param asOf 截止日（含当日），`YYYY-MM-DD`
 * @returns 持仓；`cost` / `costPerShare` 暂无数据，固定为 null
 * @throws {TypeError} 任一日期不是合法的 `YYYY-MM-DD`，或 `split` 缺折算比例
 */
export function derivePosition(
  transactions: readonly LedgerTransaction[],
  fundCode: string,
  asOf: string,
): LedgerPosition {
  assertDate(asOf, 'asOf')

  const relevant: LedgerTransaction[] = []
  for (const t of transactions) {
    if (t.status !== 'confirmed' || t.fundCode !== fundCode) continue
    // 先校验再比较：非法日期按字典序会被静默归入「截止日之前」或之后，
    // 份额随之算错。只校验真正参与推导的流水，其他基金的坏数据不牵连本基金
    assertDate(t.date, 'LedgerTransaction.date')
    if (t.date <= asOf) relevant.push(t)
  }
  // 日期定长 YYYY-MM-DD，字典序即时间序。同日多笔保持入参顺序（sort 稳定），
  // 故同日内不要放相互依赖的事件（如先分红再按分红额再投），顺序无从保证
  relevant.sort((a, b) => a.date.localeCompare(b.date))

  let shares = 0
  for (const t of relevant) {
    if (t.kind === 'split') {
      // 折算存的是比例，份额按比例乘。缺比例时无法推断，宁可报错也不当成 0 或 1
      if (t.splitRatio === null) {
        throw new TypeError(`split 流水缺 splitRatio，无法推导份额：${t.id}`)
      }
      shares *= t.splitRatio
    } else {
      shares += t.sharesDelta ?? 0
    }
  }

  return {
    fundCode,
    asOf,
    shares,
    // 成本与已实现收益是计划的后续任务，本层尚不产出——用 null 明示「未知」，
    // 不用 0 冒充，免得上层把 0 当成真实成本
    cost: null,
    costPerShare: null,
    realizedGain: 0,
  }
}
