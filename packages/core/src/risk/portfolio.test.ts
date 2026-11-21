import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import type { AdjustedNav } from '@fundmanager/shared'
import { compositeAdjustedSeries } from './portfolio.ts'

/** 造一个已复权的确认净值点。风险函数的输入必须是复权口径，故测试里统一经这里构造。 */
const adj = (v: number, date: string): AdjustedNav =>
  navConfirmed(v, date) as unknown as AdjustedNav

/** 从 2024-01-01 起逐日递增地搭一条序列 */
const series = (values: readonly number[]): AdjustedNav[] =>
  values.map((v, i) => adj(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

it('按权重合成收益：量级不同的基金也能相加', () => {
  // 一只先涨 100% 再跌 50%，另一只持平；等权逐期复利后 = 1.5 × 0.75 = 1.125。
  const c = compositeAdjustedSeries([series([1, 2, 1]), series([4, 4, 4])], [0.5, 0.5])
  expect(c.map((p) => p.value)).toEqual([1, 1.5, 1.125])
})

it('逐期按权重加权收益并复利，不把截止日权重误作固定份额', () => {
  // 权重 80:20。A 先涨 100% 后跌 50%，B 持平；组合逐期收益 +80%、-40%，终值 1.08。
  const c = compositeAdjustedSeries([series([1, 2, 1]), series([1, 1, 1])], [0.8, 0.2])
  expect(c.map((p) => p.value)).toEqual([1, 1.8, 1.08])
})

it('权重不必归一：3:1 与 0.75:0.25 结果相同', () => {
  const a = series([1, 2])
  const b = series([1, 1])
  const values = (ws: readonly number[]) => compositeAdjustedSeries([a, b], ws).map((p) => p.value)
  expect(values([3, 1])).toEqual(values([0.75, 0.25]))
  expect(values([3, 1])[1]).toBeCloseTo(1.75, 10)
})

it('只取共同日期；某只基金多出的日期不进组合', () => {
  const longer = [...series([1, 2, 3]), adj(4, '2024-01-04')]
  const shorter = series([1, 1, 1])
  expect(compositeAdjustedSeries([longer, shorter], [1, 1]).map((p) => p.date)).toEqual([
    '2024-01-01',
    '2024-01-02',
    '2024-01-03',
  ])
})

it('系列与权重对不上、权重为负或和为 0 时抛异常，不静默给 NaN', () => {
  const s = series([1, 2])
  expect(() => compositeAdjustedSeries([s], [1, 1])).toThrow(TypeError)
  expect(() => compositeAdjustedSeries([s], [-1])).toThrow(TypeError)
  expect(() => compositeAdjustedSeries([s], [0])).toThrow(TypeError)
})
