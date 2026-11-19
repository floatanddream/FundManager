import { daysBetween, navConfirmed } from '@fundmanager/shared'
import type { NavConfirmed } from '@fundmanager/shared'
import { assertNavSeries, dailyReturns } from './series.ts'

/** 默认相关性窗口：约一个 A 股交易年。 */
const DEFAULT_WINDOW = 250

/** 相关性矩阵结果。matrix 是对称方阵，对角线为 1。 */
export type CorrelationResult = {
  /** 行列顺序与入参 seriesList 一致 */
  readonly matrix: readonly (readonly number[])[]
  /** 参与计算的共同交易日收益观测数 */
  readonly observations: number
  /**
   * 参与计算的各段收益中，相邻共同日期相隔的最大日历天数。
   * 1 表示全部为相邻交易日；明显大于 1 说明窗口内发生过停牌/缺失，
   * 该段跨多日的累计收益被当成了一日收益（见 alignReturns 的说明）。
   */
  readonly maxGapDays: number
}

/**
 * 所有序列共同拥有的日期，升序。
 * 各基金历史长度与停牌日不同，必须先在共同日期上对齐再比。
 */
function intersectDates(seriesList: readonly (readonly NavConfirmed[])[]): string[] {
  const counts = new Map<string, number>()
  for (const s of seriesList) {
    for (const p of s) counts.set(p.date, (counts.get(p.date) ?? 0) + 1)
  }
  const result: string[] = []
  for (const [date, count] of counts) {
    if (count === seriesList.length) result.push(date)
  }
  return result.sort()
}

/**
 * 把一条序列按共同日期取子序列后再求日收益，得到与其他序列对齐的收益数组。
 *
 * **已知偏差**：对齐后的「一日收益」是相邻**共同日期**之间的区间收益。若某只基金
 * 在中途停牌或缺失，这段跨多日的累计收益会被视作一天收益——单点方差被抬高，
 * 与其它序列的收益错位，相关性因此轻微失真。本函数不做分段剔除（最简优先），
 * 失真程度由 `CorrelationResult.maxGapDays` 暴露给展示层标注。
 */
function alignReturns(series: readonly NavConfirmed[], commonDates: readonly string[]): number[] {
  const byDate = new Map(series.map((p) => [p.date, p.value]))
  return dailyReturns(commonDates.map((date) => navConfirmed(byDate.get(date)!, date)))
}

/**
 * 皮尔逊相关系数。任一侧方差为 0（净值恒定）时分母为 0，返回 NaN，
 * 由上层统一转成 null——NaN 一旦漏给调用方就会静默污染排序与展示。
 */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  const meanA = a.reduce((sum, x) => sum + x, 0) / n
  const meanB = b.reduce((sum, x) => sum + x, 0) / n
  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA
    const db = b[i]! - meanB
    covariance += da * db
    varianceA += da * da
    varianceB += db * db
  }
  return covariance / Math.sqrt(varianceA * varianceB)
}

/**
 * 组合内基金两两的日收益相关性矩阵。
 *
 * 先在共同日期上对齐，再取最近 window 个收益观测。某序列方差为 0
 * （净值恒定）时相关系数无定义，整体返回 null，不返回 NaN。
 *
 * **输入必须是复权后**（分红再投）的确认净值序列，见 `toAdjustedSeries`；
 * 未复权净值在分红日会压低相关性。
 *
 * @param seriesList 各基金复权后的确认净值序列，顺序即矩阵行列顺序
 * @param options.window 使用的最近收益观测数，默认 250
 * @returns 相关性矩阵；无法计算时返回 null
 * @throws {TypeError} window 不是不小于 2 的整数，或任一序列非法（透传 assertNavSeries）
 */
export function correlationMatrix(
  seriesList: readonly (readonly NavConfirmed[])[],
  options: { window?: number } = {},
): CorrelationResult | null {
  const window = options.window ?? DEFAULT_WINDOW
  if (!Number.isInteger(window) || window < 2) {
    throw new TypeError(`window 必须是不小于 2 的整数，收到：${window}`)
  }
  if (seriesList.length < 2) return null
  for (const s of seriesList) assertNavSeries(s)

  const commonDates = intersectDates(seriesList)
  // 2 个日期只有 1 个收益观测，样本方差与相关系数都无意义
  if (commonDates.length < 3) return null

  // 取最近 window 个收益观测，而不是从最早开始截
  const start = Math.max(0, commonDates.length - 1 - window)
  const aligned = seriesList.map((s) => alignReturns(s, commonDates).slice(start))
  const observations = aligned[0]!.length
  if (observations < 2) return null

  // 收益 i 对应 commonDates[i]→commonDates[i+1]，窗口内跨停牌段的最大日历跨度
  let maxGapDays = 1
  for (let i = start; i < commonDates.length - 1; i++) {
    maxGapDays = Math.max(maxGapDays, daysBetween(commonDates[i]!, commonDates[i + 1]!))
  }

  const matrix: number[][] = []
  for (let i = 0; i < aligned.length; i++) {
    const row: number[] = []
    for (let j = 0; j < aligned.length; j++) {
      row.push(i === j ? 1 : pearson(aligned[i]!, aligned[j]!))
    }
    matrix.push(row)
  }
  // 任一相关系数非有限（某序列在该窗口方差为 0）→ 整张矩阵不可信
  for (const row of matrix) {
    for (const value of row) {
      if (!Number.isFinite(value)) return null
    }
  }
  return { matrix, observations, maxGapDays }
}
