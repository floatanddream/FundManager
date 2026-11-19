import { daysBetween } from '@fundmanager/shared'
import type { NavConfirmed } from '@fundmanager/shared'
import { assertNavSeries } from './series.ts'

/** 滚动持有收益的分布统计量。所有收益率是简单收益。 */
export type RollingReturnStats = {
  /** 持有天数（日历天），原样回显 */
  readonly holdingDays: number
  /** 参与统计的窗口数 */
  readonly windows: number
  /** 亏损概率 [0, 1]：窗口收益 < 0 的比例（恰好 0 不算亏损） */
  readonly lossProbability: number
  readonly meanReturn: number
  readonly medianReturn: number
  readonly minReturn: number
  readonly maxReturn: number
  readonly p05: number
  readonly p25: number
  readonly p75: number
  readonly p95: number
}

/**
 * 分位数（type-7 线性插值，numpy 默认口径）。
 *
 * 取 0.5 即中位数：对升序数组 `sorted`，`h = (n−1)×p`，在相邻两点间按
 * `h − ⌊h⌋` 的权重线性插值。n 为偶数时恰好落在中间两点正中；n 为奇数时
 * 落在正中那个观测上。接口文档里写「中位数」，实现只有这一条路径。
 *
 * @param sorted 已升序排列的数组
 * @param p 概率 [0, 1]
 */
function quantile(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!)
}

/**
 * 滚动持有收益分布：历史上任意时点买入、持有 holdingDays 日历天后卖出，
 * 这批收益的分布统计——回答「亏损概率多少」。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @param holdingDays 持有天数（日历天），必须是正整数
 * @returns 分布统计量；没有任何可用窗口时返回 null
 * @throws {TypeError} holdingDays 非正整数，或序列非法（透传 assertNavSeries）
 */
export function rollingReturnDistribution(
  series: readonly NavConfirmed[],
  holdingDays: number,
): RollingReturnStats | null {
  if (!Number.isInteger(holdingDays) || holdingDays <= 0) {
    throw new TypeError(`holdingDays 必须是正整数，收到：${holdingDays}`)
  }
  assertNavSeries(series)

  const returns: number[] = []
  for (let i = 0; i < series.length; i++) {
    const start = series[i]!
    // 找第一个「日期 >= 起点 + holdingDays 天」的观测；按索引取第 N 个点
    // 会在停牌、节假日处取错日期。日期严格升序，故首个命中即正确
    for (let j = i + 1; j < series.length; j++) {
      const end = series[j]!
      if (daysBetween(start.date, end.date) >= holdingDays) {
        returns.push(end.value / start.value - 1)
        break
      }
    }
  }
  if (returns.length === 0) return null

  const sorted = [...returns].sort((a, b) => a - b)
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
  return {
    holdingDays,
    windows: returns.length,
    lossProbability: returns.filter((r) => r < 0).length / returns.length,
    meanReturn: mean,
    medianReturn: quantile(sorted, 0.5),
    minReturn: sorted[0]!,
    maxReturn: sorted[sorted.length - 1]!,
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
  }
}
