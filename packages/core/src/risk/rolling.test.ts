import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { rollingReturnDistribution } from './rolling.ts'

/** 从 2024-01-01 起逐日递增地搭一条确认净值序列 */
const series = (values: readonly number[]): ReturnType<typeof navConfirmed>[] =>
  values.map((v, i) => navConfirmed(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

it('[1, 2, 1, 1, 1, 2] 持有 2 天的窗口、亏损概率与分位数', () => {
  // 起点 01-01..01-04 各有一个 2 天后的窗口：收益 0, -0.5, 0, 1；01-05、01-06 之后无 ≥2 天观测 → 4 个窗口
  const stats = rollingReturnDistribution(series([1, 2, 1, 1, 1, 2]), 2)
  expect(stats).not.toBeNull()
  expect(stats!.holdingDays).toBe(2)
  expect(stats!.windows).toBe(4)
  expect(stats!.lossProbability).toBeCloseTo(0.25, 10) // 仅 -0.5 一个亏损
  expect(stats!.meanReturn).toBeCloseTo(0.125, 10) // (0 - 0.5 + 0 + 1) / 4
  expect(stats!.medianReturn).toBeCloseTo(0, 10)
  expect(stats!.minReturn).toBeCloseTo(-0.5, 10)
  expect(stats!.maxReturn).toBeCloseTo(1, 10)
  // 升序 [-0.5, 0, 0, 1]，type-7 插值 h=(4-1)*p
  expect(stats!.p05).toBeCloseTo(-0.425, 10) // -0.5 + 0.15 × 0.5
  expect(stats!.p25).toBeCloseTo(-0.125, 10) // -0.5 + 0.75 × 0.5
  expect(stats!.p75).toBeCloseTo(0.25, 10) // 0 + 0.25 × 1
  expect(stats!.p95).toBeCloseTo(0.85, 10) // 0 + 0.85 × 1
})

it('跨缺失交易日按日期取首个足够远的观测（Review Focus #5）', () => {
  // 日期 01-01、01-05、01-06（缺 01-02..01-04）。持有 2 天：
  // 起点 01-01 的首个「≥ 2 天后」观测是 01-05（距 4 天）→ 收益 2/1-1 = +100%
  // 起点 01-05 只差 01-06（1 天），不足 2 天 → 无窗口
  // 若误按索引取第 2 个点，起点 01-01 会落在 01-06（值 4）→ 收益 +300%，与预期不符
  const dates = ['2024-01-01', '2024-01-05', '2024-01-06']
  const s = [1, 2, 4].map((v, i) => navConfirmed(v, dates[i]!))
  const stats = rollingReturnDistribution(s, 2)!
  expect(stats.windows).toBe(1)
  expect(stats.maxReturn).toBeCloseTo(1, 10) // 起点 01-01 → 01-05
})

it('无可用窗口 → null', () => {
  expect(rollingReturnDistribution(series([1, 2, 3]), 30)).toBeNull()
})

it('holdingDays 非正整数抛异常', () => {
  expect(() => rollingReturnDistribution(series([1, 2, 3]), 0)).toThrow(TypeError)
  expect(() => rollingReturnDistribution(series([1, 2, 3]), -5)).toThrow(TypeError)
  expect(() => rollingReturnDistribution(series([1, 2, 3]), 1.5)).toThrow(TypeError)
})

it('日期乱序抛异常（Review Focus #1）', () => {
  const s = [navConfirmed(1, '2024-01-02'), navConfirmed(2, '2024-01-01')]
  expect(() => rollingReturnDistribution(s, 1)).toThrow(TypeError)
})
