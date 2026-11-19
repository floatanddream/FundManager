import type { LedgerTransaction, TransactionStatus } from '@fundmanager/core'
import { and, eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.ts'
import { transaction as transactionTable } from '../db/schema.ts'

/** 只取 `LedgerTransaction` 有的列；`source` / `createdAt` 是实现细节，不对外 */
const columns = {
  id: transactionTable.id,
  ledgerId: transactionTable.ledgerId,
  fundCode: transactionTable.fundCode,
  date: transactionTable.date,
  kind: transactionTable.kind,
  sharesDelta: transactionTable.sharesDelta,
  splitRatio: transactionTable.splitRatio,
  amount: transactionTable.amount,
  status: transactionTable.status,
  note: transactionTable.note,
}

export const createTransactionRepository = (db: AppDatabase) => ({
  async add(tx: LedgerTransaction): Promise<void> {
    await db.insert(transactionTable).values({
      ...tx,
      // `source` 不在 `LedgerTransaction` 里，也不能绑 undefined（node:sqlite 会抛）
      source: null,
      createdAt: new Date().toISOString(),
    })
  },

  /**
   * 某账本下某只基金的全部流水，按业务日期升序。
   *
   * @remarks **不按 `status` 过滤。** 过滤是推导层（`core/ledger`）的责任，Repository
   * 只管存取。两处都过滤会让「待确认」的流水在上层凭空消失，用户再也看不到该确认什么。
   */
  async listByFund(ledgerId: string, fundCode: string): Promise<LedgerTransaction[]> {
    return db
      .select(columns)
      .from(transactionTable)
      .where(and(eq(transactionTable.ledgerId, ledgerId), eq(transactionTable.fundCode, fundCode)))
      .orderBy(transactionTable.date)
  },

  /** 某账本的全部流水（所有基金），按业务日期升序 */
  async listAll(ledgerId: string): Promise<LedgerTransaction[]> {
    return db
      .select(columns)
      .from(transactionTable)
      .where(eq(transactionTable.ledgerId, ledgerId))
      .orderBy(transactionTable.date)
  },

  /** 改状态。目前只用于「待确认 → 已确认」，但不对方向做限制 */
  async setStatus(id: string, status: TransactionStatus): Promise<void> {
    await db.update(transactionTable).set({ status }).where(eq(transactionTable.id, id))
  },
})
