import type { AdjustedNav } from '@fundmanager/shared'
import { dailyReturns } from './series.ts'

/** A 股年均交易日。年化按 √252 放大，与券商口径一致。 */
const TRADING_DAYS_PER_YEAR = 252

/** 年化因子必须为正，否则年化不成立 */
function assertPeriodsPerYear(periodsPerYear: number): void {
  if (!(periodsPerYear > 0)) {
    throw new TypeError(`periodsPerYear 必须是正数，收到：${periodsPerYear}`)
  }
}

/**
 * 年化波动率：日收益的样本标准差（÷ n−1）× √periodsPerYear。
 *
 * **输入必须是复权后**（分红再投）的确认净值序列，见 `toAdjustedSeries`；
 * 未复权净值在分红除息日会记出一笔不存在的亏损，抬高波动率。
 *
 * @param series 复权后的确认净值序列，须按日期严格升序
 * @param options.periodsPerYear 年化因子，默认 252（A 股年均交易日）
 * @returns 非负的年化波动率；收益观测不足 2 个（净值点不足 3 个）时返回 `null`
 * @throws {TypeError} 序列非法（透传 assertNavSeries），或 periodsPerYear 非正
 */
export function annualizedVolatility(
  series: readonly AdjustedNav[],
  options: { periodsPerYear?: number } = {},
): number | null {
  const periodsPerYear = options.periodsPerYear ?? TRADING_DAYS_PER_YEAR
  assertPeriodsPerYear(periodsPerYear)
  const returns = dailyReturns(series)
  // 样本方差分母 n−1 为 0 时无定义；返回 0 会被误读为「无风险」
  if (returns.length < 2) return null
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear)
}

/**
 * 年化下行波动：只计低于目标收益的偏差，分母为全部观测数 n（标准 Sortino 口径），
 * 再按 √periodsPerYear 年化。
 *
 * **输入必须是复权后**（分红再投）的确认净值序列，见 `toAdjustedSeries`。
 *
 * @param series 复权后的确认净值序列，须按日期严格升序
 * @param options.target 目标收益率（MAR），默认 0
 * @param options.periodsPerYear 年化因子，默认 252
 * @returns 非负的年化下行波动；收益观测不足 2 个时返回 `null`。收益全程不低于目标时为 0
 * @throws {TypeError} 序列非法、target 非有限数，或 periodsPerYear 非正
 */
export function downsideDeviation(
  series: readonly AdjustedNav[],
  options: { target?: number; periodsPerYear?: number } = {},
): number | null {
  const target = options.target ?? 0
  const periodsPerYear = options.periodsPerYear ?? TRADING_DAYS_PER_YEAR
  if (!Number.isFinite(target)) {
    throw new TypeError(`target 必须是有限数，收到：${target}`)
  }
  assertPeriodsPerYear(periodsPerYear)
  const returns = dailyReturns(series)
  if (returns.length < 2) return null
  // 高于目标的部分记 0：下行波动只关心「没达到目标」的幅度
  const sumSquares = returns.reduce((sum, r) => sum + Math.min(r - target, 0) ** 2, 0)
  return Math.sqrt(sumSquares / returns.length) * Math.sqrt(periodsPerYear)
}
