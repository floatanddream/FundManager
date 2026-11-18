import { expect, it } from 'vitest'
import { MemoryCacheStore } from './memoryCache.ts'

const entry = (expiresAt: number) => ({
  value: [1, 2],
  source: 'f10/lsjz',
  dataAsOf: '2026-11-17',
  capturedAt: '2026-11-18T11:00:00+08:00',
  expiresAt,
})

it('存了能取回，原样不丢字段', async () => {
  const s = new MemoryCacheStore()
  await s.set('nav:000001', entry(9999999999999))
  expect(await s.get('nav:000001')).toEqual(entry(9999999999999))
})

it('没存过取回 undefined', async () => {
  expect(await new MemoryCacheStore().get('nope')).toBeUndefined()
})

it('已过期仍能取回——降级正是要靠它拿旧值', async () => {
  const s = new MemoryCacheStore()
  await s.set('nav:000001', entry(1)) // 1970 年就过期了
  expect(await s.get('nav:000001')).toBeDefined()
})
