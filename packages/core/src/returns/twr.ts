import { assertDate } from '@fundmanager/shared'

/**
 * 估值点。value 为当日收盘后市值；flow 为当日净现金流（正为追加投入，负为取出），
 * 视作发生于当日期初之前，故计入分母。
 */
export type ValuationPoint = {
  readonly date: string
  readonly value: number
  readonly flow: number
}

/**
 * 时间加权收益率。剔除现金流时点的影响，回答「基金经理行不行」，
 * 与资金加权（XIRR）回答的「我这笔钱赚了多少」是两个不同问题。
 *
 * 中途追加投入不影响结果——这正是它相对「总收益 ÷ 总投入」的意义所在。
 *
 * @param points 估值点序列。调用方须保证按日期升序，本函数不排序（但校验日期合法性）
 * @returns 区间累计收益率；无解时返回 null
 * @throws {TypeError} 日期非法
 */
export function timeWeightedReturn(points: readonly ValuationPoint[]): number | null {
  // 先整体校验再计算：宁可一开始就拒掉坏数据，
  // 也不要算到一半才发现，那时错误已混进结果。
  // 只校验日期——value/flow 非有限数（NaN）在正常使用中不会出现，
  // 且数据源层会用 Zod 兜住，此处不为它写守卫（见 CONSTRAINTS §8.8）
  for (const p of points) {
    assertDate(p.date, 'ValuationPoint.date')
  }
  if (points.length < 2) return null

  // 逐子区间求收益再链式相乘。首点只作起点，不产生收益。
  let compounded = 1
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!
    const current = points[i]!
    // 当日期初的资产 = 上期期末 + 当日投入；取出则为减
    const base = previous.value + current.flow
    // 分母非正说明这一期没有本金，收益率无定义——
    // 不能返回 Infinity 或负数蒙混过去，那会污染后续连乘
    if (base <= 0) return null
    compounded *= current.value / base
  }
  return compounded - 1
}
