import { approxEqual, assertDate } from '@fundmanager/shared'
import type { LedgerTransaction } from './types.ts'
import { derivePosition } from './position.ts'

export type ReconcileInput = {
  readonly transactions: readonly LedgerTransaction[]
  readonly fundCode: string
  readonly asOf: string
  /** 用户声称的实际份额（平台显示值） */
  readonly claimedShares: number
  /** 上次对得上的日期；从未对过为 null */
  readonly lastMatchedAt: string | null
}

export type ReconcileResult = {
  readonly matched: boolean
  readonly derivedShares: number
  readonly claimedShares: number
  /** `derivedShares - claimedShares`；为正说明流水推出来的份额多于平台 */
  readonly difference: number
  /** 即输入中的 `lastMatchedAt`；对不上时由此提示「最早从哪天起可能有问题」 */
  readonly sinceDate: string | null
}

/**
 * 一致性检查：从全部已确认流水**全量重推**应有份额，与用户声称的份额比对。
 *
 * 纯函数：不写任何东西、不插入「调整」流水、不自动修正——只回报结论，
 * 由上层拦住用户确认（§6「绝不悄悄改账」）。
 *
 * 为什么不做「上期确认份额 + 期间流水」的增量：用户事后补录一笔早于上次对账日的
 * 流水时，那笔既不在上期确认份额里、又落在本期窗口外，会被静默漏掉（设计 §九）。
 * 账本流水量很小，全量重推是毫秒级。
 *
 * @param input 流水、基金、截止日、声称份额、上次对得上的日期
 * @returns 是否一致、推导份额、差异与上次对得上的日期
 * @throws {TypeError} 日期或基金代码非法（由 `derivePosition` 抛出）
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { transactions, fundCode, asOf, claimedShares, lastMatchedAt } = input
  // 声称份额非有限数时任何比较都是 false，会静默变成「永远对不上」；
  // 这是参数非法，而不是数据缺失，故抛异常（§8.3）
  if (!Number.isFinite(claimedShares)) {
    throw new TypeError(`claimedShares 必须是有限数，收到：${claimedShares}`)
  }
  if (lastMatchedAt !== null) assertDate(lastMatchedAt, 'lastMatchedAt')

  const derivedShares = derivePosition(transactions, fundCode, asOf).shares
  return {
    // 份额比较用容差而非 ===：浮点累计与平台四舍五入都可能在末位有差（§8.1）
    matched: approxEqual(derivedShares, claimedShares),
    derivedShares,
    claimedShares,
    difference: derivedShares - claimedShares,
    sinceDate: lastMatchedAt,
  }
}
