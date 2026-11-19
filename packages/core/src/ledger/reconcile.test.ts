import { expect, it } from 'vitest'
import type { LedgerTransaction, TransactionKind } from './types.ts'
import { reconcile } from './reconcile.ts'

const tx = (
  date: string,
  kind: TransactionKind,
  o: { sharesDelta?: number; status?: 'confirmed' | 'pending'; ledgerId?: string } = {},
): LedgerTransaction => ({
  id: `${date}-${kind}`,
  ledgerId: o.ledgerId ?? 'L1',
  fundCode: '000001',
  date,
  kind,
  sharesDelta: o.sharesDelta ?? null,
  splitRatio: null,
  amount: 0,
  status: o.status ?? 'confirmed',
  note: null,
})

it('份额对得上就是 matched，差一点也算（容差而非 ===）', () => {
  const base = {
    // 另一个账本的 500 份不能算进来，否则 1000 会被推成 1500
    transactions: [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000 }),
      tx('2026-01-05', 'subscribe', { sharesDelta: 500, ledgerId: 'L2' }),
    ],
    ledgerId: 'L1',
    fundCode: '000001',
    asOf: '2026-01-31',
    lastMatchedAt: null,
  }
  const exact = reconcile({ ...base, claimedShares: 1000 })
  expect(exact.matched).toBe(true)
  expect(exact.derivedShares).toBe(1000)
  expect(exact.difference).toBe(0)
  expect(exact.lastMatchedOn).toBeNull()
  expect(reconcile({ ...base, claimedShares: 1000.0000000001 }).matched).toBe(true)
})

it('对不上时如实报差异，并给出上次对得上的日期；不修正任何东西', () => {
  const transactions = [
    tx('2026-01-05', 'subscribe', { sharesDelta: 1000 }),
    tx('2026-01-06', 'dividend_reinvest', { sharesDelta: 50, status: 'pending' }),
  ]
  const snapshot = structuredClone(transactions)
  const r = reconcile({
    transactions,
    ledgerId: 'L1',
    fundCode: '000001',
    asOf: '2026-01-31',
    claimedShares: 900,
    lastMatchedAt: '2026-01-04',
  })
  expect(r.matched).toBe(false)
  expect(r.difference).toBeCloseTo(100, 6)
  expect(r.claimedShares).toBe(900)
  expect(r.lastMatchedOn).toBe('2026-01-04')
  // 待确认流水不算进推导；函数是纯的，入参原样不动
  expect(r.derivedShares).toBe(1000)
  expect(transactions).toEqual(snapshot)
})

it('补录一笔早于上次对账日的流水也算得出来（全量重推）', () => {
  // 上次对账在 01-20，之后补录了一笔 01-10 的买入——增量实现会漏掉它
  const r = reconcile({
    transactions: [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000 }),
      tx('2026-01-10', 'subscribe', { sharesDelta: 200 }),
    ],
    ledgerId: 'L1',
    fundCode: '000001',
    asOf: '2026-01-31',
    claimedShares: 1200,
    lastMatchedAt: '2026-01-20',
  })
  expect(r.matched).toBe(true)
})
