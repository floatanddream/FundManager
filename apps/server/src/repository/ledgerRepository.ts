import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.ts'
import { ledger } from '../db/schema.ts'

/** 账本。字段与 `schema.ts` 的 `ledger` 表一致 */
export type Ledger = typeof ledger.$inferSelect

/**
 * 账本存取。
 *
 * @remarks 方法都返回 `Promise`，尽管 `node:sqlite` 是同步的：这一层将来可能换成
 * 异步实现（文件库、远程），调用方不该因为实现细节改签名。
 */
export const createLedgerRepository = (db: AppDatabase) => ({
  /** 建账本并返回生成的 id；`currency` 走列默认值 CNY */
  async create(name: string): Promise<string> {
    const id = randomUUID()
    // 时间戳由 Repository 层给（`openDatabase` 不读时钟），ISO 8601
    await db.insert(ledger).values({ id, name, createdAt: new Date().toISOString() })
    return id
  },

  async get(id: string): Promise<Ledger | null> {
    const rows = await db.select().from(ledger).where(eq(ledger.id, id))
    return rows[0] ?? null
  },

  async list(): Promise<Ledger[]> {
    return db.select().from(ledger).orderBy(ledger.createdAt)
  },
})
