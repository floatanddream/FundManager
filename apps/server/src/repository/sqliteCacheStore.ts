import { eq } from 'drizzle-orm'
import type { CacheEntry, CacheStore } from '@fundmanager/datasource'
import type { AppDatabase } from '../db/client.ts'
import { cache } from '../db/schema.ts'

/**
 * `CacheStore` 的 SQLite 实现，语义与 `MemoryCacheStore` 逐字一致。
 *
 * @remarks **`get` 绝不判断过期。** 过期项正是降级时唯一的旧值来源，在这里按
 * `expiresAt` 过滤等于把数据源层的降级能力删掉。也**不做过期清理**——键的基数由
 * 数据源端点数量决定，是有界的。`expiresAt` 原样存回，交给调用方判断。
 */
export const createSqliteCacheStore = (db: AppDatabase): CacheStore => ({
  /** 取出记录，**无论是否过期**；未存过则 `undefined` */
  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const rows = await db.select().from(cache).where(eq(cache.key, key))
    const row = rows[0]
    if (row === undefined) return undefined
    // 键不进信封：CacheEntry 只有值 + 出处 + 时点 + 过期时刻
    const { key: _, value, ...entry } = row
    // 存进来时是 unknown，取出时按调用方声明的 T 还原——键与值类型的对应由调用方负责
    return { value: JSON.parse(value) as T, ...entry }
  },

  /** 写入或覆盖一条记录 */
  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const row = { key, ...entry, value: JSON.stringify(entry.value) }
    // 主键冲突即覆盖：onConflictDoUpdate 而不是先删后插，少一次 IO
    await db.insert(cache).values(row).onConflictDoUpdate({ target: cache.key, set: row })
  },
})
