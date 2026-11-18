import type { CacheEntry, CacheStore } from './cacheStore.ts'

/**
 * `CacheStore` 的内存实现。
 *
 * @remarks **`get` 绝不判断过期。** 过期与否是 capability 层的事，这里只负责存。
 * 理由：过期项正是降级时唯一的旧值来源，在这里按 `expiresAt` 删掉等于把降级能力删掉。
 * 也正因如此，本实现**不做过期清理**——键的基数由数据源端点数量决定，是有界的。
 */
export class MemoryCacheStore implements CacheStore {
  private readonly store = new Map<string, CacheEntry<unknown>>()

  /**
   * 取出记录，**无论是否过期**。
   *
   * @returns 未存过则 `undefined`；存过则原样返回整条记录（含过期项）
   */
  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    // 这里存进来时是 unknown，取出时按调用方声明的 T 还原——键与值类型的对应由调用方负责
    return this.store.get(key) as CacheEntry<T> | undefined
  }

  /** 写入或覆盖一条记录 */
  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    this.store.set(key, entry)
  }
}
