import { describe, expect, it } from 'vitest'
import type { ValuationPoint } from './twr.ts'
import { timeWeightedReturn } from './twr.ts'

describe('TWR 时间加权收益', () => {
  it('中途追加投入不干扰收益率', () => {
    // 期初 1000；中途追加 200 后市值 1200（本期收益 0）；
    // 期末 1320（本期收益 +10%）。追加的钱被正确剔除——这正是 TWR 相对
    // 「收益÷投入」的意义所在。
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2024-07-01', value: 1200, flow: 200 },
      { date: '2025-01-01', value: 1320, flow: 0 },
    ]
    expect(timeWeightedReturn(points)).toBeCloseTo(0.1, 10)
  })

  it('无现金流时退化为简单收益率', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2025-01-01', value: 1100, flow: 0 },
    ]
    expect(timeWeightedReturn(points)).toBeCloseTo(0.1, 10)
  })

  it('两个子区间连乘', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2024-07-01', value: 1100, flow: 0 },
      { date: '2025-01-01', value: 1210, flow: 0 },
    ]
    expect(timeWeightedReturn(points)).toBeCloseTo(0.21, 10)
  })

  it('初始市值为 0 → null，不产生 Infinity（Review Focus #5）', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 0, flow: 0 },
      { date: '2025-01-01', value: 1100, flow: 0 },
    ]
    expect(timeWeightedReturn(points)).toBeNull()
  })

  it('取出后分母仍非正 → null', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 100, flow: 0 },
      { date: '2024-07-01', value: 50, flow: -100 },
    ]
    expect(timeWeightedReturn(points)).toBeNull()
  })

  it('点数不足 → null', () => {
    expect(timeWeightedReturn([])).toBeNull()
    expect(timeWeightedReturn([{ date: '2024-01-01', value: 1000, flow: 0 }])).toBeNull()
  })

  it('日期非法抛异常', () => {
    const points: ValuationPoint[] = [
      { date: '2024-01-01', value: 1000, flow: 0 },
      { date: '2024-13-01', value: 1100, flow: 0 },
    ]
    expect(() => timeWeightedReturn(points)).toThrow(TypeError)
  })
})
