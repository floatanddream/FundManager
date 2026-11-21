import { navConfirmed } from '@fundmanager/shared'
import type { AdjustedNav, NavConfirmed } from '@fundmanager/shared'
import { assertNavSeries } from './series.ts'

/**
 * 把若干条复权净值序列按给定权重合成为一条组合指数。
 *
 * **为什么在 core 而不是 Service**：加权求和是算式（§二 规则 1）。Service 只搬运
 * 权重与序列，算法留在这里，才能用「几个数进、几个数出」的方式验证。
 *
 * **为什么输入必须是复权序列**：组合回撤直接读合成序列；用未复权单位净值合成，
 * 每只基金分红除息日都会在组合里造出一次不存在的下跌。品牌类型 `AdjustedNav`
 * 让这种误用在编译期就过不去。
 *
 * 每一期都用截止日市值权重加权基金收益，再把组合收益复利成指数。权重代表
 * 截止日的配置并在历史期间保持不变；不能把首日归一的基金价格水平线性相加，
 * 那相当于历史期间固定份额，收益路径会错误。
 *
 * **只取共同日期**：各基金停牌/缺失日不同，逐日补值需要「停牌日净值不变」的假设。
 * 取交集不做这个假设，代价是组合序列在个别基金缺数时少几个观测。
 *
 * @param seriesList 各基金的复权净值序列（升序），顺序即权重顺序
 * @param weights 与 `seriesList` 同序的市值权重；只比较相对大小，不必和为 1
 * @param label 出错时用于定位的标签
 * @returns 组合指数（截止日权重逐期加权收益后复利），没有共同日期时为空数组
 * @throws {TypeError} 序列数与权重数不一致、权重为负或非有限数、权重和为 0，
 *   或任一条序列非法（透传 `assertNavSeries`）
 */
export function compositeAdjustedSeries(
  seriesList: readonly (readonly AdjustedNav[])[],
  weights: readonly number[],
  label = '组合',
): AdjustedNav[] {
  if (seriesList.length !== weights.length) {
    throw new TypeError(`序列数 ${seriesList.length} 与权重数 ${weights.length} 不一致`)
  }
  if (seriesList.length === 0) return []
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new TypeError(`权重必须是非负有限数，收到：${weight}`)
    }
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  // 权重全为 0 时组合没有内容，除以 0 会得到 NaN 并污染后续所有指标
  if (!(total > 0)) throw new TypeError('权重之和必须为正')
  for (const series of seriesList) assertNavSeries(series, label)

  const dates = commonDates(seriesList)
  if (dates.length === 0) return []

  const valuesByDate = seriesList.map((series) => new Map(series.map((p) => [p.date, p.value])))
  const normalizedWeights = weights.map((weight) => weight / total)
  let index = 1
  const composite = [navConfirmed(index, dates[0]!)]
  for (let dateIndex = 1; dateIndex < dates.length; dateIndex += 1) {
    const previousDate = dates[dateIndex - 1]!
    const date = dates[dateIndex]!
    // 组合每期先按固定的截止日权重合成简单收益，再对组合收益复利。
    const returnForPeriod = valuesByDate.reduce((sum, values, i) => {
      const previous = values.get(previousDate)!
      return sum + normalizedWeights[i]! * ((values.get(date)! - previous) / previous)
    }, 0)
    index *= 1 + returnForPeriod
    composite.push(navConfirmed(index, date))
  }

  const result = composite.map(asAdjusted)
  assertNavSeries(result, label)
  return result
}

/** 所有序列共同拥有的日期，升序。 */
function commonDates(seriesList: readonly (readonly AdjustedNav[])[]): string[] {
  const counts = new Map<string, number>()
  for (const series of seriesList) {
    for (const point of series) counts.set(point.date, (counts.get(point.date) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, count]) => count === seriesList.length)
    .map(([date]) => date)
    .sort()
}

/**
 * 组合指数使用复权基金收益逐期加权，仍是分红再投口径。
 *
 * 品牌只在本模块内打、不导出：一旦导出，任意 `NavConfirmed` 都能被洗成
 * `AdjustedNav`，类型隔离立刻失去意义（与 `adjusted.ts` 同一约束）。
 */
const asAdjusted = (nav: NavConfirmed): AdjustedNav => nav as AdjustedNav
