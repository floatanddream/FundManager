import { assertDate } from '@fundmanager/shared'
import type { AdjustedNav } from '@fundmanager/shared'

/**
 * 校验确认净值序列：日期合法且严格升序、净值有限且为正。
 *
 * 风险指标全部建立在这一前提上——乱序会让相邻日收益算错，
 * 非正净值会让回撤、相关性失去意义。与其让坏数据算出个像模像样的错数，
 * 不如在入口就拦住。
 *
 * @param series 待校验的序列
 * @param label 出错时用于定位的字段名，默认 `series`
 * @throws {TypeError} 任一 date 非法、净值非有限数或 <= 0，或日期未严格升序
 */
export function assertNavSeries(series: readonly AdjustedNav[], label = 'series'): void {
  for (let i = 0; i < series.length; i++) {
    const point = series[i]!
    assertDate(point.date, `${label}[${i}].date`)
    if (!Number.isFinite(point.value) || point.value <= 0) {
      throw new TypeError(`${label}[${i}] 的净值必须是有限正数，收到：${point.value}`)
    }
    // 'YYYY-MM-DD' 定长零填充，字符串比较即日期比较；等值即同日重复，同样非法
    if (i > 0 && point.date <= series[i - 1]!.date) {
      throw new TypeError(
        `${label} 必须按日期严格升序，第 ${i} 点 ${point.date} 未晚于前一点 ${series[i - 1]!.date}`,
      )
    }
  }
}

/**
 * 由确认净值序列求相邻日简单收益率：r_i = value_i / value_{i-1} - 1。
 *
 * 波动率、下行波动、相关性都以它为基。序列不足 2 点时没有收益可言，返回空数组。
 *
 * @param series 确认净值序列，须按日期严格升序
 * @returns 收益率数组，长度 = 序列长度 - 1；不足 2 点返回 `[]`
 * @throws {TypeError} 序列非法（见 assertNavSeries）
 */
export function dailyReturns(series: readonly AdjustedNav[]): number[] {
  assertNavSeries(series)
  const returns: number[] = []
  for (let i = 1; i < series.length; i++) {
    returns.push(series[i]!.value / series[i - 1]!.value - 1)
  }
  return returns
}
