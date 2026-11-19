import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import type { AdjustedNav } from '@fundmanager/shared'
import { toAdjustedSeries } from './adjusted.ts'
import type { NavSeriesRow } from './adjusted.ts'
import { maxDrawdown } from './drawdown.ts'

/** 造一行净值历史：净值、累计净值（可缺）、分红/折算事件 */
const row = (
  date: string,
  nav: number,
  accNav: number | null,
  event: NavSeriesRow['event'] = null,
): NavSeriesRow => ({ nav: navConfirmed(nav, date), accNav, event })

const dividend = (perUnit: number) => ({ kind: 'dividend', perUnit, per10Unit: null }) as const
const split = (perUnit: number) => ({ kind: 'split', perUnit, per10Unit: null }) as const
const values = (series: readonly { value: number }[]) => series.map((p) => p.value)

it('分红日不复权造成假回撤，复权后没有', () => {
  // 01-02 除息：1.5 → 1.4 并派现 0.1；01-03 净值回升到 1.47。累计净值 1.5 → 1.5 → 1.57
  const rows = [
    row('2024-01-01', 1.5, 1.5),
    row('2024-01-02', 1.4, 1.5, dividend(0.1)),
    row('2024-01-03', 1.47, 1.57),
  ]
  // 未复权的裸序列现在**编译期**就进不了风险函数——这正是品牌类型要的效果。
  // 这里显式 cast 只是为了保留数值对照，证明「如果不拦，会错多少」。
  const raw = rows.map((r) => r.nav) as unknown as AdjustedNav[]
  expect(maxDrawdown(raw)).toBeCloseTo(0.0667, 3) // 1.5 → 1.4 的假回撤
  const adjusted = toAdjustedSeries(rows)
  // 手算：(1.4+0.1)/1.5 = 1，再 1.47/1.4 = 1.05
  expect(values(adjusted).slice(0, 2)).toEqual([1.5, 1.5])
  expect(values(adjusted)[2]).toBeCloseTo(1.575, 12)
  expect(maxDrawdown(adjusted)).toBe(0)
})

it('折算日按比例还原持有人市值', () => {
  expect(
    values(toAdjustedSeries([row('2024-01-01', 2, null), row('2024-01-02', 1, null, split(2))])),
  ).toEqual([2, 2])
})

it('事件缺失时用累计净值反推分红', () => {
  expect(values(toAdjustedSeries([row('2024-01-01', 1, 1), row('2024-01-02', 1, 1.05)]))).toEqual([
    1, 1.05,
  ])
})

it('perUnit 与 per10Unit 口径不一致时抛错', () => {
  const rows = [
    row('2024-01-01', 1.5, 1.5),
    row('2024-01-02', 1.4, 1.5, { kind: 'dividend', perUnit: 0.1, per10Unit: 2 }),
  ]
  expect(() => toAdjustedSeries(rows, '011609')).toThrow('per10Unit=2')
})

it('分红金额与累计净值矛盾、或事件无从解析时抛错，不猜', () => {
  const conflict = [row('2024-01-01', 1.5, 1.5), row('2024-01-02', 1.4, 1.7, dividend(0.1))]
  expect(() => toAdjustedSeries(conflict, '011609')).toThrow('011609 2024-01-02')
  const unknown = [
    row('2024-01-01', 1, null),
    row('2024-01-02', 1, null, { kind: 'unknown', perUnit: null, per10Unit: null }),
  ]
  expect(() => toAdjustedSeries(unknown)).toThrow(TypeError)
})
