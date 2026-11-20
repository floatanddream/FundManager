import { expect, it } from 'vitest'
import type { LedgerTransaction } from '@fundmanager/core'
import { navConfirmed } from '@fundmanager/shared'
import type { Fetched, FundDataSource, NavHistory, NavHistoryRow } from '@fundmanager/datasource'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'
import { createTransactionRepository } from '../repository/transactionRepository.ts'
import { getFundReturn, type ReturnDeps } from './returnService.ts'

const row = (date: string, nav: number, accNav: number | null): NavHistoryRow => ({
  nav: navConfirmed(nav, date),
  accNav,
  growthRate: null,
  event: null,
})

const fetched = (
  rows: readonly NavHistoryRow[],
  o: { stale?: boolean; loss?: string | null } = {},
): Fetched<NavHistory> => ({
  value: { fundCode: '000001', rows: [...rows].reverse() },
  source: 'f10/lsjz',
  dataAsOf: rows.at(-1)!.nav.date,
  capturedAt: '2026-11-19T10:00:00+08:00',
  stale: o.stale ?? false,
  loss: o.loss ?? null,
})

const deps = (txs: readonly LedgerTransaction[], nav = navRows()): ReturnDeps => ({
  transactionRepository: {
    listByFund: async (ledgerId, fundCode) =>
      txs.filter((t) => t.ledgerId === ledgerId && t.fundCode === fundCode),
  },
  dataSource: { navHistory: async () => fetched(nav) },
})

const tx = (o: Partial<LedgerTransaction> & { date: string }): LedgerTransaction => ({
  id: `${o.date}-${o.kind ?? 'subscribe'}-${o.sequence ?? 0}`,
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

/** 2025-06-30 现金分红 0.1：未复权 1.1，复权价 1.2 */
const navRows = () => [
  row('2025-01-01', 1.0, 1.0),
  row('2025-06-30', 1.1, 1.2),
  row('2025-12-31', 1.2, 1.3),
]

/** 买 100 份花 100，中途现金分红 10，期末未复权 1.2 → 市值 120（不是复权的 130.9） */
const buyAndDividend = [
  tx({ date: '2025-01-01', sharesDelta: 100, amount: -100 }),
  tx({ date: '2025-06-30', kind: 'dividend_cash', amount: 10 }),
]

it('期末市值取未复权净值 × 份额——分红已作为现金流计入，用复权净值会算两次', async () => {
  const r = await getFundReturn(deps(buyAndDividend), 'L1', '000001', { asOf: '2025-12-31' })
  expect(r!.value!.endValue.value).toBeCloseTo(120, 6)
  // 复权末值 1.309 会得 130.9，多出的正是已单列的那 10 元分红重复
  expect(r!.value!.xirr.value).toBeCloseTo(0.3158280900627446, 8)
  expect(r!.value!.cashFlows.at(-1)).toEqual({ date: '2025-12-31', amount: 120 })
})

it('现金流先过 normalizeFlows：同日进出一相抵就不算现金流，不足两笔时给 null + 原因', async () => {
  const netted = tx({ date: '2025-01-01', kind: 'dividend_cash', amount: 100, sequence: 1 })
  const buy = { ...buyAndDividend[0]!, sequence: 0 }
  const r = await getFundReturn(deps([buy, netted]), 'L1', '000001', { asOf: '2025-12-31' })
  // 归一后只剩期末市值一笔，无解；不是把 0 当答案
  expect(r!.value!.xirr.value).toBeNull()
  expect(r!.value!.xirr.reason).toContain('现金流不足')
})

it('多解时捕获 MultipleRootsError，翻译成可读原因而不是 500', async () => {
  const flows = [
    tx({ date: '2021-01-01', sharesDelta: 1000, amount: -1000 }),
    tx({ date: '2022-01-01', kind: 'redeem', sharesDelta: -1000, amount: 3600 }),
    tx({ date: '2023-01-01', sharesDelta: 4290, amount: -4310 }),
  ]
  // 期末市值 4290 × 0.4 = 1716 → 现金流 -1000 / +3600 / -4310 / +1716，三个正根
  const r = await getFundReturn(
    deps(flows, [row('2021-01-01', 1, 1), row('2024-01-01', 0.4, 0.4)]),
    'L1',
    '000001',
    { asOf: '2024-01-01' },
  )
  expect(r!.value!.xirr.value).toBeNull()
  expect(r!.value!.xirr.reason).toContain('多个解')
})

it('净值缺失或账本没有该基金：null + 原因 / null，而不是 0', async () => {
  const noNav = await getFundReturn(
    deps(buyAndDividend, [row('2026-06-01', 1.2, 1.2)]),
    'L1',
    '000001',
    { asOf: '2025-12-31' },
  )
  expect(noNav!.value!.endValue.value).toBeNull()
  expect(noNav!.value!.xirr.reason).toContain('净值')
  expect(await getFundReturn(deps(buyAndDividend), 'L1', '000002')).toBeNull()
})

it('净值降级时 stale / loss 穿透；dataAsOf 是实际用到的那一行，不是整段历史的最新日', async () => {
  const d = deps(buyAndDividend)
  d.dataSource.navHistory = async () =>
    fetched(navRows(), { stale: true, loss: '丢失分红/拆分事件字段' })
  const r = await getFundReturn(d, 'L1', '000001', { asOf: '2025-06-30' })
  expect([r!.value!.endValue.stale, r!.stale, r!.value!.xirr.value !== null]).toEqual([
    true,
    true,
    true,
  ])
  expect([r!.value!.endValue.dataAsOf, r!.value!.endNav.value]).toEqual(['2025-06-30', 1.1])
})

// 路由层：真库（`:memory:`）+ 假数据源
const appWith = async (txs: readonly LedgerTransaction[]) => {
  const { db } = openDatabase()
  const repo = createTransactionRepository(db)
  for (const t of txs) await repo.add(t)
  return buildApp({ db, dataSource: deps(txs).dataSource as unknown as FundDataSource })
}

it('收益路由返回信封；账本里没有这只基金是 404，坏代码是 400', async () => {
  const a = await appWith(buyAndDividend)
  const ok = await a.inject({ method: 'GET', url: '/api/ledgers/L1/funds/000001/return' })
  expect(ok.statusCode).toBe(200)
  expect(JSON.parse(ok.body).value.endValue).toMatchObject({ value: 120, stale: false })

  const missing = await a.inject({ method: 'GET', url: '/api/ledgers/L1/funds/000002/return' })
  expect(missing.statusCode).toBe(404)
  const bad = await a.inject({ method: 'GET', url: '/api/ledgers/L1/funds/abc/return' })
  expect(bad.statusCode).toBe(400)
})
