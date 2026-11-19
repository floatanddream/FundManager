import { expect, it } from 'vitest'
import { openDatabase } from '../db/client.ts'
import { createSqliteCacheStore } from './sqliteCacheStore.ts'

const entry = (value: unknown, expiresAt = 9999999999999) => ({
  value,
  source: 'f10/lsjz',
  dataAsOf: '2026-11-18',
  capturedAt: '2026-11-19T10:00:00+08:00',
  expiresAt,
})

it('存了能取回，信封字段一个不丢', async () => {
  const s = createSqliteCacheStore(openDatabase().db)
  const e = entry([1, 2])
  await s.set('nav:000001', e)
  expect(await s.get('nav:000001')).toEqual(e)
})

it('没存过取回 undefined', async () => {
  expect(await createSqliteCacheStore(openDatabase().db).get('nope')).toBeUndefined()
})

it('已过期仍能取回——降级要靠它拿旧值', async () => {
  const s = createSqliteCacheStore(openDatabase().db)
  await s.set('k', entry(1, 1))
  expect(await s.get('k')).toBeDefined()
})
