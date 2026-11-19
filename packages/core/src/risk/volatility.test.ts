import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import type { AdjustedNav } from '@fundmanager/shared'
import { annualizedVolatility, downsideDeviation } from './volatility.ts'

/** 造一个已复权的确认净值点。风险函数的输入必须是复权口径，故测试里统一经这里构造。 */
const adj = (v: number, date: string): AdjustedNav =>
  navConfirmed(v, date) as unknown as AdjustedNav

/** 从 2024-01-01 起逐日递增地搭一条确认净值序列 */
const series = (values: readonly number[]): AdjustedNav[] =>
  values.map((v, i) => adj(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

// 日收益恰为 [0.5, 0, -0.5]，全是二进制精确值，可手算
const sample = series([1, 1.5, 1.5, 0.75])
const rising = series([1, 1.5, 2.25])

it('年化波动率 = 日收益样本标准差 × √年化因子', () => {
  // 样本方差 = (0.25 + 0 + 0.25) / 2 = 0.25 → 标准差 0.5
  expect(annualizedVolatility(sample)).toBeCloseTo(0.5 * Math.sqrt(252), 10)
  expect(annualizedVolatility(sample, { periodsPerYear: 1 })).toBeCloseTo(0.5, 10)
})

it('恒定收益率序列波动率为 0', () => {
  expect(annualizedVolatility(rising)).toBe(0)
})

it('收益观测不足 2 个返回 null 而非 0（Review Focus #2）', () => {
  expect(annualizedVolatility([])).toBeNull()
  expect(annualizedVolatility(series([1]))).toBeNull()
  expect(annualizedVolatility(series([1, 2]))).toBeNull()
  expect(downsideDeviation([])).toBeNull()
  expect(downsideDeviation(series([1]))).toBeNull()
  expect(downsideDeviation(series([1, 1.5]))).toBeNull()
})

it('下行波动只惩罚低于目标的收益，分母为全部观测数', () => {
  // target 0：只有 -0.5 计入 → 0.25 / 3 × 252 = 21
  expect(downsideDeviation(sample)).toBeCloseTo(Math.sqrt(21), 10)
  // target 0.5：相对目标偏差 0、-0.5、-1.0 → 1.25 / 3 × 252 = 105
  expect(downsideDeviation(sample, { target: 0.5 })).toBeCloseTo(Math.sqrt(105), 10)
  // 收益全程不低于目标：无下行偏差
  expect(downsideDeviation(rising)).toBe(0)
})

it('非法选项参数抛异常', () => {
  expect(() => annualizedVolatility(sample, { periodsPerYear: 0 })).toThrow(TypeError)
  expect(() => annualizedVolatility(sample, { periodsPerYear: -1 })).toThrow(TypeError)
  expect(() => downsideDeviation(sample, { target: Number.NaN })).toThrow(TypeError)
})
