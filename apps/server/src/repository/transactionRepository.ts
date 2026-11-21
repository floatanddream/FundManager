import type { DatabaseSync } from 'node:sqlite'
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
  sequence: transactionTable.sequence,
  note: transactionTable.note,
}

/** 持有 SQLite 写锁时试算、调整旧序号并写入。 */
function insertValidated(
  sqlite: DatabaseSync,
  tx: LedgerTransaction,
  validate: (existing: LedgerTransaction[]) => void,
): void {
  const existing = sqlite
    .prepare(
      `
    SELECT id, ledgerId, fundCode, date, kind, sharesDelta, splitRatio, amount, status, sequence, note
    FROM "transaction"
    WHERE ledgerId = ? AND fundCode = ?
    ORDER BY date, sequence
  `,
    )
    .all(tx.ledgerId, tx.fundCode) as LedgerTransaction[]
  const sameDay = existing.filter((row) => row.date === tx.date && row.status === 'confirmed')
  const legacy = sameDay.length === 1 && sameDay[0]?.sequence === null ? sameDay[0] : undefined
  if (legacy && tx.sequence === 0) {
    throw new TypeError('同日已有旧流水未设置顺序号；请将新流水 sequence 设为 1 或更大')
  }
  // 只有调用方明确给出正序号时，才把同日唯一的旧流水保留为首笔。
  const assignFirst = legacy && tx.sequence !== null && tx.sequence > 0
  const candidate = assignFirst
    ? existing.map((row) => (row.id === legacy.id ? { ...row, sequence: 0 } : row))
    : existing
  validate([...candidate, tx])
  if (assignFirst)
    sqlite
      .prepare('UPDATE "transaction" SET sequence = 0 WHERE id = ? AND sequence IS NULL')
      .run(legacy.id)
  sqlite
    .prepare(
      `
    INSERT INTO "transaction"
    (id, ledgerId, fundCode, date, kind, sharesDelta, splitRatio, amount, status, sequence, source, note, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `,
    )
    .run(
      tx.id,
      tx.ledgerId,
      tx.fundCode,
      tx.date,
      tx.kind,
      tx.sharesDelta,
      tx.splitRatio,
      tx.amount,
      tx.status,
      tx.sequence,
      tx.note,
      new Date().toISOString(),
    )
}

export const createTransactionRepository = (db: AppDatabase) => ({
  /**
   * 先在同一写事务中试算，校验通过后才调整旧序号并录入。所有连接共用 SQLite 写锁。
   *
   * @throws {TypeError} 流水试算失败，或新流水的序号与旧流水补录规则冲突。
   */
  addAtomically(tx: LedgerTransaction, validate: (existing: LedgerTransaction[]) => void): void {
    db.atomic((sqlite) => insertValidated(sqlite, tx, validate))
  },

  /** 在同一写锁下用草稿 ID 入账。竞争请求总是返回先提交的流水。 */
  confirmSubscriptionAtomically(
    tx: LedgerTransaction,
    validate: (existing: LedgerTransaction[]) => void,
  ): LedgerTransaction {
    return db.atomic((sqlite) => {
      const saved = sqlite
        .prepare(
          'SELECT ' +
            Object.keys(columns).join(', ') +
            ' FROM "transaction" WHERE id = ? AND ledgerId = ?',
        )
        .get(tx.id, tx.ledgerId) as LedgerTransaction | undefined
      if (saved) return saved
      insertValidated(sqlite, tx, validate)
      return tx
    })
  },
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
      .orderBy(transactionTable.date, transactionTable.sequence)
  },

  /** 某账本的全部流水（所有基金），按业务日期升序 */
  async listAll(ledgerId: string): Promise<LedgerTransaction[]> {
    return db
      .select(columns)
      .from(transactionTable)
      .where(eq(transactionTable.ledgerId, ledgerId))
      .orderBy(transactionTable.date, transactionTable.sequence)
  },

  /** 改状态。目前只用于「待确认 → 已确认」，但不对方向做限制 */
  async setStatus(id: string, status: TransactionStatus): Promise<void> {
    await db.update(transactionTable).set({ status }).where(eq(transactionTable.id, id))
  },
})
