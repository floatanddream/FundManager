import type { LedgerTransaction, TransactionKind } from '@fundmanager/core'
import { expect, it } from 'vitest'
import { openDatabase } from '../db/client.ts'
import { createLedgerRepository } from './ledgerRepository.ts'
import { createTransactionRepository } from './transactionRepository.ts'

const tx = (
  date: string,
  kind: TransactionKind,
  o: { sharesDelta?: number; amount?: number; status?: 'confirmed' | 'pending' } = {},
): LedgerTransaction => ({
  id: `${date}-${kind}`,
  ledgerId: 'L1',
  fundCode: '000001',
  date,
  kind,
  sharesDelta: o.sharesDelta ?? null,
  splitRatio: null,
  amount: o.amount ?? 0,
  status: o.status ?? 'confirmed',
  note: null,
})

const fresh = () => {
  const { db } = openDatabase()
  return { db, ledger: createLedgerRepository(db), txs: createTransactionRepository(db) }
}

it('流水按基金取回，含 pending 的（过滤是推导层的事）', async () => {
  const { ledger, txs } = fresh()
  const id = await ledger.create('实盘')
  await txs.add({
    ...tx('2026-01-05', 'subscribe', { sharesDelta: 1000, amount: -1000 }),
    ledgerId: id,
  })
  await txs.add({
    ...tx('2026-01-06', 'dividend_cash', { amount: 50, status: 'pending' }),
    ledgerId: id,
  })

  const rows = await txs.listByFund(id, '000001')
  expect(rows).toHaveLength(2)
  // 字段一个不丢——Drizzle 按列位置解码，漏一列就会静默变 undefined
  expect(rows[0]).toEqual({
    id: '2026-01-05-subscribe',
    ledgerId: id,
    fundCode: '000001',
    date: '2026-01-05',
    kind: 'subscribe',
    sharesDelta: 1000,
    splitRatio: null,
    amount: -1000,
    status: 'confirmed',
    note: null,
  })
})

it('listAll 只取本账本的流水', async () => {
  const { ledger, txs } = fresh()
  const id = await ledger.create('实盘')
  const other = await ledger.create('模拟')
  await txs.add({ ...tx('2026-01-05', 'subscribe', { sharesDelta: 1000 }), ledgerId: id })
  await txs.add({ ...tx('2026-01-06', 'subscribe', { sharesDelta: 200 }), ledgerId: other })
  expect((await txs.listAll(id)).map((t) => t.ledgerId)).toEqual([id])
})

it('能改状态（待确认 → 已确认）', async () => {
  const { ledger, txs } = fresh()
  const id = await ledger.create('实盘')
  await txs.add({
    ...tx('2026-01-06', 'dividend_cash', { amount: 50, status: 'pending' }),
    ledgerId: id,
  })
  await txs.setStatus('2026-01-06-dividend_cash', 'confirmed')
  expect((await txs.listByFund(id, '000001'))[0]!.status).toBe('confirmed')
})
