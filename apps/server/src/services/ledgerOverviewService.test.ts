import { expect, it } from 'vitest'
import type { LedgerTransaction } from '@fundmanager/core'
import type { Fetched, FundDataSource, NavHistory, NavHistoryRow } from '@fundmanager/datasource'
import { navConfirmed } from '@fundmanager/shared'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'
import { createLedgerRepository } from '../repository/ledgerRepository.ts'
import { createTransactionRepository } from '../repository/transactionRepository.ts'
import { getLedgerOverview } from './ledgerOverviewService.ts'

const previous = '2026-11-19'
const current = '2026-11-20'
const clock = new Date('2026-11-20T23:00:00+08:00')

/** 用公开代码构造合成交易，检查市值与现金流的归属。 */
function transaction(
  ledgerId: string,
  fundCode: string,
  date: string,
  options: Partial<LedgerTransaction> = {},
): LedgerTransaction {
  return {
    ledgerId,
    fundCode,
    date,
    id: `${fundCode}/${date}`,
    kind: 'subscribe',
    status: 'confirmed',
    amount: -100,
    sharesDelta: 100,
    splitRatio: null,
    sequence: null,
    note: null,
    ...options,
  }
}

/** 保持与真实数据源相同的未复权净值与事件格式。 */
function navRow(date: string, value: number, event: NavHistoryRow['event'] = null): NavHistoryRow {
  return { nav: navConfirmed(value, date), growthRate: null, accNav: null, event }
}

/** 真走 SQLite 及 Fastify 装配，外部净值用已知样本。 */
async function fixture(histories: Record<string, NavHistoryRow[]>) {
  const { db, sqlite } = openDatabase()
  const ledgerRepository = createLedgerRepository(db)
  const transactionRepository = createTransactionRepository(db)
  const id = await ledgerRepository.create('示例账本')
  const calls: string[] = []
  const dataSource = {
    async navHistory(code: string): Promise<Fetched<NavHistory>> {
      calls.push(code)
      const rows = histories[code] ?? []
      return {
        value: { fundCode: code, rows },
        source: 'fixture',
        dataAsOf: rows[0]?.nav.date ?? current,
        capturedAt: clock.toISOString(),
        stale: false,
        loss: null,
      }
    },
  }
  const app = buildApp({ db, dataSource: dataSource as FundDataSource })
  return {
    id,
    calls,
    app,
    add: transactionRepository.add,
    read: () =>
      getLedgerOverview({ ledgerRepository, transactionRepository, dataSource }, id, clock),
    async close() {
      await app.close()
      sqlite.close()
    },
  }
}

it('总览路由区分未知账本和零资产的空账本', async () => {
  const f = await fixture({})
  try {
    expect((await f.app.inject('/api/ledgers/unknown/overview')).statusCode).toBe(404)
    const response = await f.app.inject(`/api/ledgers/${f.id}/overview`)
    expect(response.statusCode).toBe(200)
    expect(response.json().value).toMatchObject({
      marketValue: { value: 0 },
      dailyGain: { value: null },
      positions: [],
    })
  } finally {
    await f.close()
  }
})

it('同一净值窗口汇总部分基金，同时计入当天的清仓收益', async () => {
  const f = await fixture({
    '000001': [navRow(current, 1.2), navRow(previous, 1)],
    '011609': [navRow(previous, 1)],
    '000011': [navRow(previous, 1)],
  })
  try {
    for (const code of ['000001', '011609', '000011'])
      await f.add(transaction(f.id, code, previous))
    await f.add(
      transaction(f.id, '000011', current, { kind: 'redeem', sharesDelta: -100, amount: 105 }),
    )
    const view = (await f.read())!.value!
    expect(view).toMatchObject({
      valuationDate: current,
      previousDate: previous,
      marketValue: { value: 120 },
      marketValueCoverage: { included: 1, total: 2 },
      dailyGainCoverage: { included: 2, total: 3 },
    })
    expect(view.dailyGain.value).toBeCloseTo(25)
    expect(view.positions.find((p) => p.fundCode === '011609')?.dailyGain.value).toBeNull()
    expect(view.positions.find((p) => p.fundCode === '000011')?.dailyGain.value).toBeCloseTo(5)
    expect(f.calls).toHaveLength(3)
  } finally {
    await f.close()
  }
})

it('没有匹配流水的除息先等待核对，同日确认分红后才计算收益', async () => {
  const f = await fixture({
    '000001': [
      navRow(current, 0.9, {
        kind: 'dividend',
        perUnit: 0.1,
        per10Unit: 1,
        description: '每份分红0.1元',
      }),
      navRow(previous, 1),
    ],
  })
  try {
    await f.add(transaction(f.id, '000001', previous))
    expect((await f.read())?.value?.dailyGain).toMatchObject({
      value: null,
      reason: expect.any(String),
    })
    await f.add(
      transaction(f.id, '000001', current, {
        kind: 'dividend_cash',
        sharesDelta: null,
        amount: 10,
      }),
    )
    expect((await f.read())?.value?.dailyGain.value).toBeCloseTo(0)
  } finally {
    await f.close()
  }
})
