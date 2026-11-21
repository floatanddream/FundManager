import { expect, it } from 'vitest'

import { MemoryCacheStore } from '../cache/memoryCache.ts'
import { BusinessCodeError, DataSourceError } from '../http/errors.ts'
import { fetchWithFallback } from './fetchWithFallback.ts'

/** 成功源：返回固定值；多带的 source 字段被忽略 */
const ok = (value: number) => async () => ({ value, source: 'main', dataAsOf: '2026-11-17' })
const boom = async (): Promise<never> => {
  throw new Error('主源挂了')
}

it('主源成功：不标 stale，loss 为 null', async () => {
  const r = await fetchWithFallback({ key: 'k', ttlMs: 0, sources: [{ name: 'main', run: ok(1) }] })
  expect(r).toMatchObject({ value: 1, source: 'main', stale: false, loss: null })
})

it('主源挂了走备源，loss 记下失去了什么', async () => {
  const r = await fetchWithFallback({
    key: 'k',
    ttlMs: 0,
    sources: [
      { name: 'main', run: boom },
      { name: 'backup', run: ok(2), loss: '仅前十大' },
    ],
  })
  expect(r).toMatchObject({ value: 2, source: 'backup', loss: '仅前十大' })
})

it('全链失败且缓存有旧值：返回旧值并标 stale', async () => {
  const cache = new MemoryCacheStore()
  await cache.set('k', {
    value: 9,
    source: 'main',
    dataAsOf: '2026-11-10',
    capturedAt: '2026-11-11T10:00:00+08:00',
    expiresAt: 1, // 1970 年就过期了
  })
  const r = await fetchWithFallback({
    key: 'k',
    ttlMs: 1000,
    sources: [{ name: 'main', run: boom }],
    cache,
  })
  expect(r).toMatchObject({ value: 9, stale: true, dataAsOf: '2026-11-10' })
})

it('TTL 未过期的缓存命中不算 stale', async () => {
  const cache = new MemoryCacheStore()
  const now = () => new Date('2026-11-18T10:00:00+08:00')
  await cache.set('k', {
    value: 7,
    source: 'main',
    dataAsOf: '2026-11-17',
    capturedAt: '2026-11-18T09:00:00+08:00',
    expiresAt: now().getTime() + 60_000, // 还没过期
  })
  const r = await fetchWithFallback({
    key: 'k',
    ttlMs: 60_000,
    sources: [{ name: 'main', run: boom }],
    cache,
    now,
  })
  expect(r).toMatchObject({ value: 7, stale: false })
})

it('全链失败且缓存无值：抛，不得返回空值', async () => {
  const cache = new MemoryCacheStore()
  await expect(
    fetchWithFallback({ key: 'k', ttlMs: 1000, sources: [{ name: 'main', run: boom }], cache }),
  ).rejects.toThrow(DataSourceError)
})

it('全链均为业务码失败：错误信息给出可操作提示（缺 Referer / UA 被拒）', async () => {
  const businessFail = async (): Promise<never> => {
    throw new BusinessCodeError('业务码 -999')
  }
  await expect(
    fetchWithFallback({
      key: 'k',
      ttlMs: 0,
      sources: [
        { name: 'a', run: businessFail },
        { name: 'b', run: businessFail },
      ],
    }),
  ).rejects.toThrow(/Referer.*UA|UA.*Referer/)
})

it('净值单调保护：较旧主源继续尝试备源；全源倒退时保留缓存并标 stale', async () => {
  const cache = new MemoryCacheStore()
  await cache.set('nav', {
    value: 3,
    source: 'last',
    dataAsOf: '2026-11-18',
    capturedAt: '2026-11-19T08:00:00+08:00',
    expiresAt: 1,
  })
  const r = await fetchWithFallback({
    key: 'nav',
    ttlMs: 1000,
    cache,
    monotonicDataAsOf: true,
    sources: [
      { name: 'old-primary', run: async () => ({ value: 1, dataAsOf: '2026-11-17' }) },
      { name: 'newer-backup', run: async () => ({ value: 4, dataAsOf: '2026-11-19' }) },
    ],
  })
  expect(r).toMatchObject({ value: 4, source: 'newer-backup', stale: false })
  const latest = await cache.get<number>('nav')
  await cache.set('nav', { ...latest!, expiresAt: 1 })
  const stale = await fetchWithFallback({
    key: 'nav',
    ttlMs: 1000,
    cache,
    monotonicDataAsOf: true,
    sources: [{ name: 'old-only', run: async () => ({ value: 2, dataAsOf: '2026-11-17' }) }],
  })
  expect(stale).toMatchObject({ value: 4, dataAsOf: '2026-11-19', stale: true })
})

it('并发净值回写按 dataAsOf 保护，晚返回的旧响应不能覆盖新缓存', async () => {
  const cache = new MemoryCacheStore()
  let releaseOld!: () => void
  const oldWait = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  const old = fetchWithFallback({
    key: 'race',
    ttlMs: 1000,
    cache,
    monotonicDataAsOf: true,
    sources: [
      {
        name: 'old',
        run: async () => {
          await oldWait
          return { value: 1, dataAsOf: '2026-11-17' }
        },
      },
    ],
  })
  const fresh = await fetchWithFallback({
    key: 'race',
    ttlMs: 1000,
    cache,
    monotonicDataAsOf: true,
    sources: [{ name: 'fresh', run: async () => ({ value: 2, dataAsOf: '2026-11-18' }) }],
  })
  releaseOld()
  const older = await old
  expect(fresh.value).toBe(2)
  expect(older).toMatchObject({ value: 2, dataAsOf: '2026-11-18', stale: true })
  expect((await cache.get<number>('race'))?.value).toBe(2)
})

it('净值缓存按写入时 TTL 限龄，旧 24h expiresAt 不会命中', async () => {
  const cache = new MemoryCacheStore()
  const now = new Date('2026-11-20T20:00:00+08:00')
  await cache.set('nav', {
    value: 1,
    source: 'old',
    dataAsOf: '2026-11-19',
    capturedAt: '2026-11-19T20:00:00+08:00',
    expiresAt: now.getTime() + 60_000_000,
  })
  const result = await fetchWithFallback({
    key: 'nav',
    ttlMs: 30 * 60 * 1000,
    cache,
    monotonicDataAsOf: true,
    now: () => now,
    sources: [{ name: 'fresh', run: async () => ({ value: 2, dataAsOf: '2026-11-20' }) }],
  })
  expect(result).toMatchObject({ value: 2, source: 'fresh', stale: false })
})
