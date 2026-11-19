import { expect, it } from 'vitest'
import { openDatabase } from './client.ts'
import { ledger } from './schema.ts'

it('建表并跑得通一条 SQL', async () => {
  const { db, sqlite } = openDatabase()
  sqlite
    .prepare('INSERT INTO ledger (id, name, createdAt) VALUES (?, ?, ?)')
    .run('L1', '实盘', '2026-11-19T10:00:00+08:00')
  expect(sqlite.prepare('SELECT name FROM ledger WHERE id = ?').get('L1')).toEqual({ name: '实盘' })
  // 走一遍 Drizzle：适配器若漏了 setReturnArrays，这里会解出 undefined 而不报错
  expect((await db.select().from(ledger))[0]).toMatchObject({
    id: 'L1',
    name: '实盘',
    currency: 'CNY',
  })
})

it('重复打开是幂等的（表已存在不报错）', () => {
  const a = openDatabase()
  a.sqlite.close()
  expect(() => openDatabase()).not.toThrow()
})
