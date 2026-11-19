import { expect, it } from 'vitest'
import type { LedgerTransaction, TransactionKind } from './types.ts'
import { derivePosition } from './position.ts'

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

it('份额按事件累计', () => {
  expect(
    derivePosition([tx('2026-01-05', 'subscribe', { sharesDelta: 1000 })], '000001', '2026-01-31')
      .shares,
  ).toBe(1000)
})

it('份额折算按比例乘，不是加减', () => {
  // 1000 份，折算比例 0.37094933 → 370.94933 份
  const p = derivePosition(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000 }),
      tx('2026-01-10', 'split', { splitRatio: 0.37094933 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(p.shares).toBeCloseTo(370.94933, 5)
})

it('截止日之后的流水不计入', () => {
  const p = derivePosition(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000 }),
      tx('2026-03-01', 'subscribe', { sharesDelta: 500 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(p.shares).toBe(1000)
})

it('待确认流水不算进持仓', () => {
  const p = derivePosition(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000 }),
      tx('2026-01-06', 'dividend_reinvest', { sharesDelta: 10, status: 'pending' }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(p.shares).toBe(1000)
})

it('只算这一只基金', () => {
  const other = { ...tx('2026-01-05', 'subscribe', { sharesDelta: 999 }), fundCode: '011609' }
  const p = derivePosition(
    [tx('2026-01-05', 'subscribe', { sharesDelta: 1000 }), other],
    '000001',
    '2026-01-31',
  )
  expect(p.shares).toBe(1000)
})
