/** 一条缓存记录：值 + 出处 + 两个时点 + 过期时刻。 */
export type CacheEntry<T> = {
  readonly value: T
  /** 数据来源标识（如 `'f10/lsjz'`），降级到备源时用它说明当前值从哪来 */
  readonly source: string
  /**
   * 数据本身的时点（`YYYY-MM-DD`）。
   *
   * @remarks 与 `capturedAt` 不同：净值的 `dataAsOf` 是最新净值日，可能是几天前抓的；
   * 报告期的 `dataAsOf` 是报告期末，远早于抓取时刻。二者必须分开存。
   */
  readonly dataAsOf: string
  /** 抓取时刻，带时区（如 `'2026-11-18T11:00:00+08:00'`） */
  readonly capturedAt: string
  /** 过期时刻，epoch 毫秒。是否过期由调用方判断——store 本身不看这个字段 */
  readonly expiresAt: number
}

/**
 * 缓存存储接口。
 *
 * @remarks `get` 与 `set` 都是异步的，因为将来换 SQLite 实现时它们是 IO；
 * 内存实现只是先把这个契约立住。
 */
export interface CacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>
  set<T>(key: string, entry: CacheEntry<T>): Promise<void>
  /** 原子地写入，且仅当已存 dataAsOf 不晚于新记录时成功。 */
  setIfNotOlder?<T>(key: string, entry: CacheEntry<T>): Promise<boolean>
}
