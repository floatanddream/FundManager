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

it('买入把金额摊进成本', () => {
  const p = derivePosition(
    [tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000 })],
    '000001',
    '2026-01-31',
  )
  expect(p.cost).toBeCloseTo(1000, 6)
  expect(p.costPerShare).toBeCloseTo(1, 6)
})

it('赎回按比例结转，单位成本不变', () => {
  // 买 1000 份花 1000 元；赎回一半拿回 600 元 → 单位成本仍 1，已实现收益 100
  const p = derivePosition(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000 }),
      tx('2026-01-20', 'redeem', { sharesDelta: -500, amount: 600 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(p.shares).toBe(500)
  expect(p.cost).toBeCloseTo(500, 6)
  expect(p.costPerShare).toBeCloseTo(1, 6)
  expect(p.realizedGain).toBeCloseTo(100, 6)
})

it('现金分红记已实现收益，不冲成本', () => {
  const p = derivePosition(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000 }),
      tx('2026-01-20', 'dividend_cash', { sharesDelta: 0, amount: 50 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(p.cost).toBeCloseTo(1000, 6)
  expect(p.realizedGain).toBeCloseTo(50, 6)
})

it('红利再投按两步展开：先记已实现收益，再按再投净值买入', () => {
  // 另持有 500 份、单位成本 1；再投 100 份、再投净值 1.2 → 再投金额 120
  const p = derivePosition(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000 }),
      tx('2026-01-20', 'redeem', { sharesDelta: -500, amount: 500 }),
      tx('2026-01-25', 'dividend_reinvest', { sharesDelta: 100, amount: 120 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(p.shares).toBe(600)
  expect(p.cost).toBeCloseTo(620, 6) // 原 500 + 再投 120
  expect(p.realizedGain).toBeCloseTo(120, 6) // 分红那一笔
})

it('份额折算不改变成本，单位成本按反比例变', () => {
  const p = derivePosition(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000 }),
      tx('2026-01-10', 'split', { splitRatio: 0.5 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(p.shares).toBe(500)
  expect(p.cost).toBeCloseTo(1000, 6)
  expect(p.costPerShare).toBeCloseTo(2, 6)
})

it('没有买入记录时成本是 null，不编数字；之后有买入要能恢复', () => {
  // 只从某个时点开始记：先看到分红，成本未知
  const before = derivePosition(
    [
      tx('2026-01-10', 'dividend_cash', { sharesDelta: 0, amount: 50 }),
      tx('2026-01-15', 'split', { splitRatio: 0.5 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(before.cost).toBeNull()
  expect(before.costPerShare).toBeNull()
  expect(before.realizedGain).toBeCloseTo(50, 6) // 分红金额是已知的，照记

  const after = derivePosition(
    [
      tx('2026-01-10', 'dividend_cash', { sharesDelta: 0, amount: 50 }),
      tx('2026-01-20', 'subscribe', { sharesDelta: 100, amount: -120 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(after.cost).toBeCloseTo(120, 6)
})

it('全部赎回后成本归零，已实现收益留下；份额为 0 时单位成本是 null', () => {
  const p = derivePosition(
    [
      tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000 }),
      tx('2026-01-20', 'redeem', { sharesDelta: -1000, amount: 1100 }),
    ],
    '000001',
    '2026-01-31',
  )
  expect(p.shares).toBe(0)
  expect(p.cost).toBeCloseTo(0, 6)
  expect(p.costPerShare).toBeNull() // 除零无意义，不是 Infinity
  expect(p.realizedGain).toBeCloseTo(100, 6)
})
