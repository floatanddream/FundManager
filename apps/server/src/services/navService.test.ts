import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import type { Fetched, FundDataSource, NavHistory, NavHistoryRow } from '@fundmanager/datasource'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'
import { getNav } from './navService.ts'

/** 一行净值：单位净值、累计净值（可缺）、事件 */
const row = (
  date: string,
  nav: number,
  accNav: number | null,
  event: NavHistoryRow['event'] = null,
): NavHistoryRow => ({ nav: navConfirmed(nav, date), accNav, growthRate: null, event })

const dividend = (perUnit: number) =>
  ({
    kind: 'dividend',
    perUnit,
    per10Unit: null,
    description: `每份派现金${perUnit}元`,
  }) as const

/** 升序造行，数据源本身是降序的；复权函数自行排序，故两侧口径一致 */
const history = (rows: readonly NavHistoryRow[]): NavHistory => ({
  fundCode: '000001',
  rows: [...rows].reverse(),
})

const fetched = (
  rows: readonly NavHistoryRow[],
  o: { stale?: boolean; loss?: string | null } = {},
): Fetched<NavHistory> => ({
  value: history(rows),
  source: o.loss == null ? 'f10/lsjz' : 'pingzhongdata/Data_netWorthTrend',
  dataAsOf: rows.at(-1)?.nav.date ?? '2026-01-01',
  capturedAt: '2026-11-19T10:00:00+08:00',
  stale: o.stale ?? false,
  loss: o.loss ?? null,
})

const deps = (
  f: Fetched<NavHistory>,
): { readonly dataSource: Pick<FundDataSource, 'navHistory'> } => ({
  dataSource: { navHistory: async () => f },
})

// 01-02 除息 1.5 → 1.4 并派现 0.1：未复权跌 6.67%，复权后持平
const dividendRows = [row('2026-01-01', 1.5, 1.5), row('2026-01-02', 1.4, 1.5, dividend(0.1))]

it('复权序列与原始序列口径不同，复权后分红日不再假跌', async () => {
  const r = await getNav(deps(fetched(dividendRows)), '000001')
  // 原始净值保持数据源口径（降序，最新在前）；复权序列为升序
  expect(r.nav.value!.rows[0]!.nav).toMatchObject({ date: '2026-01-02', value: 1.4 })
  expect(r.adjusted.value![1]!.value).toBeCloseTo(1.5, 10)
})

it('备源缺分红事件时 adjusted.loss 必须说明，不能静默给「复权」标签', async () => {
  const r = await getNav(deps(fetched(dividendRows, { loss: '丢失分红/拆分事件字段' })), '000001')
  expect(r.nav.loss).toContain('分红')
  expect(r.adjusted.loss).toContain('复权时缺分红')
  // 主源命中时 loss 为 null，不无端加说明
  expect((await getNav(deps(fetched(dividendRows)), '000001')).adjusted.loss).toBeNull()
})

it('stale 从数据源穿透到两个信封', async () => {
  const r = await getNav(deps(fetched(dividendRows, { stale: true })), '000001')
  expect([r.nav.stale, r.adjusted.stale]).toEqual([true, true])
})

it('复权失败不拖垮端点：adjusted 为 null 并带原因，原始净值仍可看', async () => {
  // 分红每份 0.1，但累计净值反推 0.3——toAdjustedSeries 拒绝猜
  const conflict = [row('2026-01-01', 1.5, 1.5), row('2026-01-02', 1.4, 1.7, dividend(0.1))]
  const r = await getNav(deps(fetched(conflict)), '000001')
  expect(r.nav.value!.rows).toHaveLength(2)
  expect(r.adjusted.value).toBeNull()
  expect(r.adjusted.reason).toContain('无法复权')
})

const injectNav = (url: string) =>
  buildApp({
    db: openDatabase().db,
    dataSource: deps(fetched(dividendRows)).dataSource as unknown as FundDataSource,
  }).inject({ method: 'GET', url })

it('净值路由不需要账本，信封字段齐全', async () => {
  const r = await injectNav('/api/funds/011609/nav')
  expect(r.statusCode).toBe(200)
  expect(JSON.parse(r.body)).toMatchObject({
    nav: { stale: false, loss: null, provenance: [] },
    adjusted: { value: expect.any(Array), reason: null },
  })
})

it('非法基金代码与倒置的区间被拒为 400，不打数据源', async () => {
  const bad = await injectNav('/api/funds/abc/nav')
  expect(bad.statusCode).toBe(400)
  const range = await injectNav('/api/funds/011609/nav?startDate=2026-02-01&endDate=2026-01-01')
  expect(range.statusCode).toBe(400)
  expect(JSON.parse(range.body).error).toContain('startDate')
})
