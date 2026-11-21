import { and, eq, isNull } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.ts'
import { subscriptionDraft, transaction } from '../db/schema.ts'

export type SubscriptionDraft = { id: string; fundCode: string; orderDate: string; amount: number }

const columns = {
  id: subscriptionDraft.id,
  fundCode: subscriptionDraft.fundCode,
  orderDate: subscriptionDraft.orderDate,
  amount: subscriptionDraft.amount,
}

export const createSubscriptionRepository = (db: AppDatabase) => ({
  async add(ledgerId: string, draft: SubscriptionDraft) {
    await db
      .insert(subscriptionDraft)
      .values({ ...draft, ledgerId, createdAt: new Date().toISOString() })
  },

  async get(ledgerId: string, id: string) {
    const [entry] = await db
      .select({ draft: columns, date: transaction.date, sharesDelta: transaction.sharesDelta })
      .from(subscriptionDraft)
      .leftJoin(
        transaction,
        and(eq(transaction.id, subscriptionDraft.id), eq(transaction.ledgerId, ledgerId)),
      )
      .where(and(eq(subscriptionDraft.ledgerId, ledgerId), eq(subscriptionDraft.id, id)))
      .limit(1)
    return entry ?? null
  },

  /** 已确认流水与草稿同 ID，单次读取即可得到尚未入账的申购。 */
  async listPending(ledgerId: string): Promise<SubscriptionDraft[]> {
    return db
      .select(columns)
      .from(subscriptionDraft)
      .leftJoin(
        transaction,
        and(eq(transaction.id, subscriptionDraft.id), eq(transaction.ledgerId, ledgerId)),
      )
      .where(and(eq(subscriptionDraft.ledgerId, ledgerId), isNull(transaction.id)))
      .orderBy(subscriptionDraft.createdAt)
  },
})
