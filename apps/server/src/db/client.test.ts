import { eq } from 'drizzle-orm'
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

it('查不到行时 get 返回 undefined，不是全 undefined 的空壳对象', async () => {
  // Drizzle 的 mapGetResult 只判 `!row`，适配器若把「没有」回成 [] 就会解出空壳对象，
  // `?? null` 与 `?.` 都拦不住（findFirst / db.query.* 同样中招）
  const { db } = openDatabase()
  expect(await db.select().from(ledger).where(eq(ledger.id, 'nope')).get()).toBeUndefined()
  expect(await db.query.ledger.findFirst()).toBeUndefined()
})
