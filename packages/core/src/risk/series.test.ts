import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { assertNavSeries, dailyReturns } from './series.ts'

/** 用数值数组与等距日期快速搭一条确认净值序列，日期从 2024-01-01 起逐日递增 */
const series = (values: readonly number[]): ReturnType<typeof navConfirmed>[] =>
  values.map((v, i) => navConfirmed(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

it('按 value_i / value_{i-1} - 1 计算日收益', () => {
  // 1 → 2 → 1 → 3：收益分别为 +100%、-50%、+200%
  expect(dailyReturns(series([1, 2, 1, 3]))).toEqual([1, -0.5, 2])
})

it('不足两点返回空数组', () => {
  expect(dailyReturns([])).toEqual([])
  expect(dailyReturns(series([1.5]))).toEqual([])
})

it('日期乱序或重复抛异常（Review Focus #1）', () => {
  // 乱序：第二点 01-01 早于第一点 01-02；重复：两点同日
  expect(() =>
    dailyReturns([navConfirmed(1, '2024-01-02'), navConfirmed(2, '2024-01-01')]),
  ).toThrow(TypeError)
  expect(() =>
    dailyReturns([navConfirmed(1, '2024-01-01'), navConfirmed(2, '2024-01-01')]),
  ).toThrow(TypeError)
})

it('净值非正或非有限数抛异常', () => {
  expect(() => dailyReturns(series([1, 0]))).toThrow(TypeError)
  expect(() => dailyReturns(series([1, -0.5]))).toThrow(TypeError)
  expect(() => dailyReturns(series([1, Number.NaN]))).toThrow(TypeError)
  expect(() => dailyReturns(series([1, Number.POSITIVE_INFINITY]))).toThrow(TypeError)
})

it('assertNavSeries 接受合法序列、拒绝非法日期', () => {
  expect(() => assertNavSeries(series([1, 1.5, 1.25]), 'test')).not.toThrow()
  // 绕过 navConfirmed 直接构造，模拟未走构造函数的数据
  expect(() => assertNavSeries([{ kind: 'nav', value: 1, date: '2024/01/01' }])).toThrow(TypeError)
})
