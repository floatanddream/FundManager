import { expect, it } from 'vitest'
import { openDatabase } from '../db/client.ts'
import { createLedgerRepository } from './ledgerRepository.ts'

it('账本存了能取回，且能列全部', async () => {
  const ledger = createLedgerRepository(openDatabase().db)
  const id = await ledger.create('实盘')
  expect(await ledger.get(id)).toMatchObject({ id, name: '实盘', currency: 'CNY' })
  expect(await ledger.list()).toHaveLength(1)
})

it('不存在的账本返回 null', async () => {
  expect(await createLedgerRepository(openDatabase().db).get('nope')).toBeNull()
})
