import type { ReconcileResult } from '@fundmanager/core'
import { expect, it } from 'vitest'
import { openDatabase } from '../db/client.ts'
import { createLedgerRepository } from './ledgerRepository.ts'
import { createReconcileRepository } from './reconcileRepository.ts'

const result = (matched: boolean, claimedShares: number): ReconcileResult => ({
  matched,
  derivedShares: 1000,
  claimedShares,
  difference: 1000 - claimedShares,
  sinceDate: null,
})

it('没对过账时 lastMatchedAt 是 null', async () => {
  const { db } = openDatabase()
  const id = await createLedgerRepository(db).create('实盘')
  expect(await createReconcileRepository(db).lastMatchedAt(id, '000001')).toBeNull()
})

it('lastMatchedAt 取对得上的记录里最晚的截止日，对不上的不算', async () => {
  const { db } = openDatabase()
  const id = await createLedgerRepository(db).create('实盘')
  const repo = createReconcileRepository(db)
  // 插入顺序与截止日顺序不同，确认按 asOf 排序而不是按写入顺序
  await repo.add(id, '000001', result(true, 1000), '2026-02-10')
  await repo.add(id, '000001', result(false, 900), '2026-03-10')
  await repo.add(id, '000001', result(true, 1000), '2026-01-10')
  expect(await repo.lastMatchedAt(id, '000001')).toBe('2026-02-10')
  // 别的基金互不影响
  expect(await repo.lastMatchedAt(id, '011609')).toBeNull()
})
