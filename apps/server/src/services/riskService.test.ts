import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { DataSourceError } from '@fundmanager/datasource'
import type { Fetched, FundDataSource, NavHistory, NavHistoryRow } from '@fundmanager/datasource'
import type { LedgerTransaction } from '@fundmanager/core'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'
import { createTransactionRepository } from '../repository/transactionRepository.ts'
import {
  getFundRisk,
  getPortfolioRisk,
  type PortfolioRiskDeps,
  type RiskDeps,
} from './riskService.ts'

/** 一行净值：单位净值、累计净值、事件 */
const row = (
  date: string,
  nav: number,
  accNav: number | null,
  event: NavHistoryRow['event'] = null,
): NavHistoryRow => ({ nav: navConfirmed(nav, date), accNav, growthRate: null, event })

const dividend = (perUnit: number) =>
  ({ kind: 'dividend', perUnit, per10Unit: null, description: `每份派现金${perUnit}元` }) as const

/** 数据源是降序的；这里按升序给，函数自行排序 */
const fetched = (
  rows: readonly NavHistoryRow[],
  o: { stale?: boolean; loss?: string | null } = {},
): Fetched<NavHistory> => ({
  value: { fundCode: '000001', rows: [...rows].reverse() },
  source: o.loss == null ? 'f10/lsjz' : 'pingzhongdata/Data_netWorthTrend',
  dataAsOf: rows.at(-1)?.nav.date ?? '2026-01-01',
  capturedAt: '2026-11-19T10:00:00+08:00',
  stale: o.stale ?? false,
  loss: o.loss ?? null,
})

/** 01-02 除息 1.5 → 1.4 并派现 0.1：未复权跌 6.67%，复权后持平 */
const dividendRows = [row('2026-01-01', 1.5, 1.5), row('2026-01-02', 1.4, 1.5, dividend(0.1))]

/** 有几天的普通净值序列，用于组合计算 */
const plainRows = (nav: number) =>
  ['2026-01-01', '2026-01-02', '2026-01-03'].map((date) => row(date, nav, nav))

/** 单基金风险只读 `navHistory`，按基金代码路由到不同序列 */
const source = (
  byFund: Readonly<Record<string, Fetched<NavHistory>>>,
): Pick<FundDataSource, 'navHistory'> => ({
  navHistory: async (fundCode) => {
    const hit = byFund[fundCode]
    if (hit === undefined) throw new Error(`测试未给 ${fundCode} 造净值`)
    return hit
  },
})

const riskDeps = (f: Fetched<NavHistory>): RiskDeps => ({ dataSource: source({ '000001': f }) })

const tx = (
  o: Partial<LedgerTransaction> & { date: string; fundCode: string },
): LedgerTransaction => ({
  id: `${o.fundCode}-${o.date}`,
  ledgerId: 'L1',
  kind: 'subscribe',
  sharesDelta: 100,
  splitRatio: null,
  amount: -100,
  status: 'confirmed',
  sequence: null,
  note: null,
  ...o,
})

const portfolioDeps = (
  txs: readonly LedgerTransaction[],
  byFund: Readonly<Record<string, Fetched<NavHistory>>>,
): PortfolioRiskDeps => ({
  transactionRepository: {
    listAll: async (ledgerId) => txs.filter((t) => t.ledgerId === ledgerId),
    listByFund: async (ledgerId, fundCode) =>
      txs.filter((t) => t.ledgerId === ledgerId && t.fundCode === fundCode),
  },
  dataSource: source(byFund),
})

it('风险指标基于复权序列：分红日不产生假回撤', async () => {
  const r = await getFundRisk(riskDeps(fetched(dividendRows)), '000001')
  // 未复权会在 01-02 造出 6.67% 的假回撤；复权后整条序列持平
  expect(r.maxDrawdown.value).toBeCloseTo(0, 10)
  expect(r.currentDrawdown.value).toBeCloseTo(0, 10)
})

it('adjusted 缺失（备源无事件）时 loss 必须说明，不能静默', async () => {
  const r = await getFundRisk(
    riskDeps(fetched(dividendRows, { loss: '丢失分红/拆分事件字段' })),
    '000001',
  )
  expect(r.maxDrawdown.loss).toContain('复权时缺分红')
  expect(r.annualizedVolatility.loss).toContain('复权时缺分红')
})

it('adjusted 为 null 时五项指标全为 null + reason；观测不足时也带原因', async () => {
  // 分红每份 0.1 但累计净值反推 0.3：toAdjustedSeries 拒绝猜，adjusted 为 null
  const conflict = [row('2026-01-01', 1.5, 1.5), row('2026-01-02', 1.4, 1.7, dividend(0.1))]
  const broken = await getFundRisk(riskDeps(fetched(conflict)), '000001')
  expect(
    [broken.annualizedVolatility, broken.maxDrawdown, broken.currentDrawdown].map((m) => m.value),
  ).toEqual([null, null, null])
  expect(broken.maxDrawdown.reason).toContain('无法取得复权净值')

  // 只有一个净值点：连日收益都没有，波动率无样本方差
  const short = await getFundRisk(riskDeps(fetched([row('2026-01-01', 1, 1)])), '000001')
  expect(short.annualizedVolatility.value).toBeNull()
  expect(short.annualizedVolatility.reason).toContain('观测不足')
})

it('组合回撤按市值加权合成：80% 的基金跌 50%、20% 的持平，组合回撤是 40% 不是 50%', async () => {
  const byFund = {
    '000001': fetched([row('2026-01-01', 1, 1), row('2026-01-02', 0.5, 0.5)]),
    '000002': fetched([row('2026-01-01', 1, 1), row('2026-01-02', 1, 1)]),
  }
  // 权重按截止日 01-02 的市值：160×0.5 : 20×1 = 80 : 20
  const txs = [
    tx({ fundCode: '000001', date: '2026-01-01', sharesDelta: 160, amount: -160 }),
    tx({ fundCode: '000002', date: '2026-01-01', sharesDelta: 20, amount: -20 }),
  ]
  const r = await getPortfolioRisk(portfolioDeps(txs, byFund), 'L1', { asOf: '2026-01-02' })
  expect(r.value!.members.map((m) => m.weight)).toEqual([0.8, 0.2])
  expect(r.value!.maxDrawdown.value).toBeCloseTo(0.4, 10)
})

it('组合为空返回 value: null + reason，不是空对象', async () => {
  const r = await getPortfolioRisk(portfolioDeps([], {}), 'L1')
  expect([r.value, r.reason]).toEqual([null, '该账本没有持仓'])
})

it('组合 stale 穿透：任一基金净值降级，组合信封就 stale', async () => {
  const stale = { ...fetched(plainRows(1)), stale: true }
  const txs = [tx({ fundCode: '000001', date: '2026-01-01' })]
  const r = await getPortfolioRisk(portfolioDeps(txs, { '000001': stale }), 'L1', {
    asOf: '2026-01-03',
  })
  expect([r.stale, r.value!.maxDrawdown.stale]).toEqual([true, true])
})

it('单只基金净值失败时其余基金仍参与组合，且 loss 点名缺失基金', async () => {
  const txs = ['000001', '000002'].map((fundCode) => tx({ fundCode, date: '2026-01-01' }))
  const base = portfolioDeps(txs, {})
  const dataSource: RiskDeps['dataSource'] = {
    navHistory: async (fundCode: string) => {
      if (fundCode === '000001') throw new DataSourceError('净值接口失败')
      return fetched(plainRows(1))
    },
  }
  const r = await getPortfolioRisk({ ...base, dataSource }, 'L1', { asOf: '2026-01-03' })
  expect(r.value?.members.map((member) => member.observations)).toEqual([0, 3])
  expect(r.loss).toContain('000001')
})

it('单基金风险路由不需要账本；坏基金代码是 400', async () => {
  const app = buildApp({
    db: openDatabase().db,
    dataSource: riskDeps(fetched(dividendRows)).dataSource as unknown as FundDataSource,
  })
  const ok = await app.inject({ method: 'GET', url: '/api/funds/000001/risk' })
  expect(ok.statusCode).toBe(200)
  expect(JSON.parse(ok.body)).toMatchObject({
    fundCode: '000001',
    maxDrawdown: { value: 0, reason: null, loss: null },
  })
  const bad = await app.inject({ method: 'GET', url: '/api/funds/abc/risk' })
  expect(bad.statusCode).toBe(400)
})

it('组合风险路由用账本里的流水与市值权重；没有流水的账本是 value: null', async () => {
  const { db } = openDatabase()
  const repo = createTransactionRepository(db)
  await repo.add(tx({ fundCode: '000001', date: '2026-01-01' }))
  const dataSource = source({
    '000001': fetched(plainRows(1)),
  }) as unknown as FundDataSource
  const app = buildApp({ db, dataSource })

  const body = JSON.parse(
    (await app.inject({ method: 'GET', url: '/api/ledgers/L1/portfolio/risk' })).body,
  )
  expect(body.value.members[0]).toMatchObject({ fundCode: '000001', weight: 1 })
  const empty = await app.inject({ method: 'GET', url: '/api/ledgers/L2/portfolio/risk' })
  expect(JSON.parse(empty.body).reason).toBe('该账本没有持仓')
})
