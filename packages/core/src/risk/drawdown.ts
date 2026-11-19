import { daysBetween } from '@fundmanager/shared'
import type { NavConfirmed } from '@fundmanager/shared'
import { assertNavSeries } from './series.ts'

/**
 * 最大回撤：历史峰值到后续谷底的最大跌幅。返回非负幅度（0.5 表示跌 50%）。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @returns 最大回撤；不足 2 点返回 null
 * @throws {TypeError} 序列非法（透传 assertNavSeries）
 */
export function maxDrawdown(series: readonly NavConfirmed[]): number | null {
  assertNavSeries(series)
  if (series.length < 2) return null
  let peak = series[0]!.value
  let worst = 0
  for (const point of series) {
    if (point.value > peak) peak = point.value
    const drawdown = (peak - point.value) / peak
    if (drawdown > worst) worst = drawdown
  }
  return worst
}

/**
 * 最大回撤的修复期：从回撤谷底回到前一个峰值所花的日历天数。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @returns 修复所需天数；从未回撤或结束时仍未修复均返回 null
 * @throws {TypeError} 序列非法（透传 assertNavSeries）
 */
export function drawdownRecoveryDays(series: readonly NavConfirmed[]): number | null {
  assertNavSeries(series)
  if (series.length < 2) return null

  // 定位首次出现最大回撤的峰值索引与谷底索引。用严格 >，
  // 等值时保留先出现的那个，保证「首次」
  let peak = series[0]!.value
  let peakIndex = 0
  let worst = 0
  let troughIndex = -1
  let troughPeakIndex = -1
  for (let i = 0; i < series.length; i++) {
    const value = series[i]!.value
    if (value > peak) {
      peak = value
      peakIndex = i
    }
    const drawdown = (peak - value) / peak
    if (drawdown > worst) {
      worst = drawdown
      troughIndex = i
      troughPeakIndex = peakIndex
    }
  }
  // 从未回撤 → 没有「修复期」这一说
  if (worst <= 0) return null

  const peakValue = series[troughPeakIndex]!.value
  // 从谷底之后找第一个回到峰值水平的点
  for (let i = troughIndex + 1; i < series.length; i++) {
    if (series[i]!.value >= peakValue) {
      return daysBetween(series[troughIndex]!.date, series[i]!.date)
    }
  }
  // 结束时仍在水下 → 答案不存在，不能用末日期顶替（会把「还在亏」谎报成「已修复」）
  return null
}

/**
 * 当前回撤：序列末点相对历史峰值的跌幅。返回非负幅度。
 *
 * 当前日期由调用方以序列末点给出——core 不读时间。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @returns 当前回撤；不足 2 点返回 null
 * @throws {TypeError} 序列非法（透传 assertNavSeries）
 */
export function currentDrawdown(series: readonly NavConfirmed[]): number | null {
  assertNavSeries(series)
  if (series.length < 2) return null
  let peak = series[0]!.value
  for (const point of series) {
    if (point.value > peak) peak = point.value
  }
  return (peak - series[series.length - 1]!.value) / peak
}
