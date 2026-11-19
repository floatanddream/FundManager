import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import type { AdjustedNav } from '@fundmanager/shared'
import { correlationMatrix } from './correlation.ts'

/** 造一个已复权的确认净值点。风险函数的输入必须是复权口径，故测试里统一经这里构造。 */
const adj = (v: number, date: string): AdjustedNav =>
  navConfirmed(v, date) as unknown as AdjustedNav

/** 按给定日期与数值搭一条确认净值序列 */
const series = (dates: readonly string[], values: readonly number[]): AdjustedNav[] =>
  values.map((v, i) => adj(v, dates[i]!))

const D = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']

// A 的日收益 +50%, -50%, +50%, -50%；B 恰为其相反数
const A = series(D, [1, 1.5, 0.75, 1.125, 0.5625])
const B = series(D, [1, 0.5, 0.75, 0.375, 0.5625])

it('相同序列相关系数为 1，相反序列为 -1', () => {
  const same = correlationMatrix([
    A,
    series(
      D,
      A.map((p) => p.value),
    ),
  ])
  expect(same!.matrix[0]![0]).toBe(1)
  expect(same!.matrix[1]![1]).toBe(1)
  expect(same!.matrix[0]![1]).toBeCloseTo(1, 10)
  expect(same!.observations).toBe(4)
  expect(same!.maxGapDays).toBe(1)

  const opposite = correlationMatrix([A, B])!
  expect(opposite.matrix[0]![1]).toBeCloseTo(-1, 10)
  expect(opposite.matrix[1]![0]).toBeCloseTo(-1, 10)
})

it('只取共同日期，非重叠部分被丢弃', () => {
  // C 的日期整体后移一天（01-02..01-06），共同日期只剩 4 个 → 3 个对齐收益
  const C = series(
    ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06'],
    [1, 1.5, 0.75, 1.125, 0.5625],
  )
  const result = correlationMatrix([A, C])!
  expect(result.observations).toBe(3)
  expect(result.matrix).toHaveLength(2)
  expect(result.matrix[0]![1]).toBeCloseTo(-1, 10)
})

it('maxGapDays 暴露跨停牌的多日区间收益', () => {
  // 01-01 → 01-08 中间无共同日期：这段 7 天累计收益被当成一日收益
  const gapped = series(['2024-01-01', '2024-01-08', '2024-01-09'], [1, 1.5, 0.75])
  const result = correlationMatrix([
    gapped,
    series(['2024-01-01', '2024-01-08', '2024-01-09'], [1, 0.5, 0.75]),
  ])!
  expect(result.maxGapDays).toBe(7)
})

it('window 限制只取最近若干个观测', () => {
  expect(correlationMatrix([A, B], { window: 2 })!.observations).toBe(2)
})

it('无法计算时返回 null（序列不足、共同日期不足、零方差）', () => {
  const flat = series(D, [1, 1, 1, 1, 1])
  // 零方差 → 整矩阵返回 null，不返回 NaN（Review Focus #3）
  expect(correlationMatrix([A, flat])).toBeNull()
  expect(correlationMatrix([A])).toBeNull()
  expect(correlationMatrix([])).toBeNull()
  // 共同日期只有 01-01、02-01 两点，不足 2 个收益观测
  expect(correlationMatrix([A, series(['2024-01-01', '2024-02-01'], [1, 2])])).toBeNull()
})

it('序列日期乱序抛异常（Review Focus #1）', () => {
  const bad = [adj(1, '2024-01-02'), adj(2, '2024-01-01')]
  expect(() => correlationMatrix([A, bad])).toThrow(TypeError)
})

it('window 非法抛异常', () => {
  expect(() => correlationMatrix([A, B], { window: 1 })).toThrow(TypeError)
  expect(() => correlationMatrix([A, B], { window: 2.5 })).toThrow(TypeError)
})
