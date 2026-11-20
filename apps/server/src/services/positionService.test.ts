import { expect, it } from 'vitest'
import type { LedgerTransaction } from '@fundmanager/core'
import { navConfirmed } from '@fundmanager/shared'
import type { Fetched, FundDataSource, NavHistory, NavHistoryRow } from '@fundmanager/datasource'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'
import { createTransactionRepository } from '../repository/transactionRepository.ts'
import { getFundPosition, listPositions, type PositionDeps } from './positionService.ts'

/** 01-02 除息 1.5 → 1.4 并派现 0.1：未复权跌 6.67%，复权后持平 */
const row = (
  date: string,
  nav: number,
  accNav: number | null,
  event: NavHistoryRow['event'] = null,
): NavHistoryRow => ({ nav: navConfirmed(nav, date), accNav, growthRate: null, event })

const fetched = (rows: readonly NavHistoryRow[]): Fetched<NavHistory> => ({
  value: { fundCode: '000001', rows: [...rows].reverse() },
  source: 'f10/lsjz',
  dataAsOf: rows.at(-1)!.nav.date,
  capturedAt: '2026-11-19T10:00:00+08:00',
  stale: false,
  loss: null,
})

const tx = (o: Partial<LedgerTransaction> & { date: string }): LedgerTransaction => ({
  id: `${o.date}-${o.kind ?? 'subscribe'}`,
  ledgerId: 'L1',
  fundCode: '000001',
  kind: 'subscribe',
  sharesDelta: null,
  splitRatio: null,
  amount: 0,
  status: 'confirmed',
  sequence: null,
  note: null,
  ...o,
})

const buy = tx({ date: '2026-01-01', kind: 'subscribe', sharesDelta: 100, amount: -150 })
// 成本未知的那一类：只有现金分红，从没有买入记录
const dividendOnly = tx({ date: '2026-01-02', kind: 'dividend_cash', amount: 10 })

const deps = (txs: readonly LedgerTransaction[]): PositionDeps => ({
  transactionRepository: {
    listAll: async (ledgerId) => txs.filter((t) => t.ledgerId === ledgerId),
    listByFund: async (ledgerId, fundCode) =>
      txs.filter((t) => t.ledgerId === ledgerId && t.fundCode === fundCode),
  },
  dataSource: {
    navHistory: async () => fetched([row('2026-01-01', 1.5, 1.5), row('2026-01-02', 1.4, 1.5)]),
  },
})

it('市值用未复权净值 × 份额：1.4 × 100 = 140，不是复权后的 150', async () => {
  const [p] = (await listPositions(deps([buy]), 'L1', { asOf: '2026-01-02' })).value!
  expect(p!.shares).toBe(100)
  expect(p!.marketValue.value).toBeCloseTo(140, 6)
  // 成本 150，浮亏 10
  expect(p!.cost.value).toBeCloseTo(150, 6)
  expect(p!.costPerShare.value).toBeCloseTo(1.5, 6)
  expect(p!.unrealizedGain.value).toBeCloseTo(-10, 6)
})

it('成本未知时 cost / costPerShare / 浮动盈亏全部 null 并带原因，不编 0', async () => {
  const [p] = (await listPositions(deps([dividendOnly]), 'L1', { asOf: '2026-01-02' })).value!
  expect([p!.cost.value, p!.costPerShare.value, p!.unrealizedGain.value]).toEqual([
    null,
    null,
    null,
  ])
  expect([p!.cost.reason, p!.unrealizedGain.reason]).toEqual([
    expect.stringContaining('成本未知'),
    expect.stringContaining('成本未知'),
  ])
  // 份额与已实现收益仍照常给：没有成本也能看账
  expect([p!.shares, p!.realizedGain]).toEqual([0, 10])
})

it('两个账本买同一只基金各算各的，份额不合并', async () => {
  const other = { ...buy, id: 'L2-buy', ledgerId: 'L2', sharesDelta: 50 }
  const [l1] = (await listPositions(deps([buy, other]), 'L1', { asOf: '2026-01-02' })).value!
  const [l2] = (await listPositions(deps([buy, other]), 'L2', { asOf: '2026-01-02' })).value!
  expect([l1!.shares, l2!.shares]).toEqual([100, 50])
})

it('单只基金：账本里没有它的流水时返回 null，而不是 0 份额', async () => {
  expect(await getFundPosition(deps([buy]), 'L1', '000002', { asOf: '2026-01-02' })).toBeNull()
  const p = await getFundPosition(deps([buy]), 'L1', '000001', { asOf: '2026-01-02' })
  expect(p!.value!.shares).toBe(100)
})

it('账本没有流水时返回空列表（200 语义），不是 null', async () => {
  const r = await listPositions(deps([]), 'L1')
  expect([r.value, r.reason, r.stale]).toEqual([[], null, false])
})

it('净值降级时 stale / loss 穿透到持仓，不被吞掉', async () => {
  const d = deps([buy])
  d.dataSource.navHistory = async () => ({
    ...fetched([row('2026-01-01', 1.5, 1.5), row('2026-01-02', 1.4, 1.5)]),
    stale: true,
    loss: '丢失分红/拆分事件字段',
  })
  const [p] = (await listPositions(d, 'L1', { asOf: '2026-01-02' })).value!
  expect([p!.marketValue.stale, p!.marketValue.loss]).toEqual([true, '丢失分红/拆分事件字段'])
})

// 路由层：真库（`:memory:`）+ 假数据源，断言信封、404 与 400
const appWith = async (txs: readonly LedgerTransaction[]) => {
  const { db } = openDatabase()
  const repo = createTransactionRepository(db)
  for (const t of txs) await repo.add(t)
  return buildApp({ db, dataSource: deps(txs).dataSource as unknown as FundDataSource })
}

it('持仓路由返回逐行带口径的信封；没有流水的基金是 404，坏代码是 400', async () => {
  const a = await appWith([buy])
  const list = await a.inject({ method: 'GET', url: '/api/ledgers/L1/positions' })
  expect(list.statusCode).toBe(200)
  const body = JSON.parse(list.body)
  expect(body.value[0]).toMatchObject({ fundCode: '000001', marketValue: { value: 140 } })
  expect(body.stale).toBe(false)

  const missing = await a.inject({ method: 'GET', url: '/api/ledgers/L1/positions/000002' })
  expect(missing.statusCode).toBe(404)
  const bad = await a.inject({ method: 'GET', url: '/api/ledgers/L1/positions/abc' })
  expect(bad.statusCode).toBe(400)
})
