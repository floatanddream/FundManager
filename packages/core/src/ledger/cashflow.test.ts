import { expect, it } from 'vitest'
import type { LedgerTransaction, TransactionKind } from './types.ts'
import { toCashFlows } from './cashflow.ts'

const tx = (
  date: string,
  kind: TransactionKind,
  o: {
    sharesDelta?: number
    splitRatio?: number
    amount?: number
    status?: 'confirmed' | 'pending'
  } = {},
): LedgerTransaction => ({
  id: `${date}-${kind}`,
  ledgerId: 'L1',
  fundCode: '000001',
  date,
  kind,
  sharesDelta: o.sharesDelta ?? null,
  splitRatio: o.splitRatio ?? null,
  amount: o.amount ?? 0,
  status: o.status ?? 'confirmed',
  note: null,
})

it('只导出真正进出账本的钱，按日期升序', () => {
  const flows = toCashFlows(
    [
      tx('2026-01-20', 'redeem', { sharesDelta: -500, amount: 600 }),
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000 }),
      tx('2026-01-25', 'dividend_cash', { sharesDelta: 0, amount: 50 }),
    ],
    '000001',
  )
  expect(flows).toEqual([
    { date: '2026-01-05', amount: -1000 },
    { date: '2026-01-20', amount: 600 },
    { date: '2026-01-25', amount: 50 },
  ])
})

it('红利再投与份额折算没有外部现金流', () => {
  expect(
    toCashFlows(
      [
        tx('2026-01-25', 'dividend_reinvest', { sharesDelta: 100, amount: 120 }),
        tx('2026-01-26', 'split', { splitRatio: 0.5 }),
      ],
      '000001',
    ),
  ).toEqual([])
})

it('待确认流水与其他基金的流水不进现金流', () => {
  const other = {
    ...tx('2026-01-06', 'subscribe', { sharesDelta: 999, amount: -999 }),
    fundCode: '011609',
  }
  const flows = toCashFlows(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000, status: 'pending' }),
      other,
      tx('2026-01-07', 'subscribe', { sharesDelta: 10, amount: -10 }),
    ],
    '000001',
  )
  expect(flows).toEqual([{ date: '2026-01-07', amount: -10 }])
})
