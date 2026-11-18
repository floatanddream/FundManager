import { expect, it } from 'vitest'
import type { ValuationPoint } from './twr.ts'
import { timeWeightedReturn } from './twr.ts'

const pt = (date: string, value: number, flow = 0): ValuationPoint => ({ date, value, flow })

it('中途追加投入不干扰收益率', () => {
  // 期初 1000；中途追加 200 后市值 1200（本期收益 0）；期末 1320（本期收益 +10%）。
  // 追加的钱不计入收益——这正是 TWR 相对「收益 ÷ 投入」的意义。
  const points = [pt('2024-01-01', 1000), pt('2024-07-01', 1200, 200), pt('2025-01-01', 1320)]
  expect(timeWeightedReturn(points)).toBeCloseTo(0.1, 10)
})

it('无现金流时退化为简单收益率', () => {
  expect(timeWeightedReturn([pt('2024-01-01', 1000), pt('2025-01-01', 1100)])).toBeCloseTo(0.1, 10)
})

it('两个子区间连乘', () => {
  const points = [pt('2024-01-01', 1000), pt('2024-07-01', 1100), pt('2025-01-01', 1210)]
  expect(timeWeightedReturn(points)).toBeCloseTo(0.21, 10)
})

it('无解情形一律返回 null', () => {
  expect(timeWeightedReturn([])).toBeNull() // 一个点都没有
  expect(timeWeightedReturn([pt('2024-01-01', 1000)])).toBeNull() // 只有起点
  expect(timeWeightedReturn([pt('2024-01-01', 0), pt('2025-01-01', 1100)])).toBeNull() // 初始市值为 0
  const withdrawn = [pt('2024-01-01', 100), pt('2024-07-01', 50, -100)]
  expect(timeWeightedReturn(withdrawn)).toBeNull() // 取出后分母仍非正
})

it('日期非法抛异常', () => {
  const bad = [pt('2024-01-01', 1000), pt('2024-13-01', 1100)]
  expect(() => timeWeightedReturn(bad)).toThrow(TypeError)
})
