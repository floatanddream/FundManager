import type { ReconcileResult } from '@fundmanager/core'
import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.ts'
import { reconcile } from '../db/schema.ts'

export const createReconcileRepository = (db: AppDatabase) => ({
  /**
   * 记一条对账结论。
   *
   * @param asOf 对账截止的业务日期（`YYYY-MM-DD`），由调用方在调用 `reconcile()` 时传入。
   * 计划的签名 `add(ledgerId, fundCode, result)` 漏了它，但表里 `asOf` 是 NOT NULL、
   * `lastMatchedAt` 正按它排序，而 `result` 不带截止日——只能显式传。
   *
   * @remarks `difference` / `sinceDate` 不落库：它们描述的是这一次比对，全量重推即可复现。
   */
  async add(
    ledgerId: string,
    fundCode: string,
    result: ReconcileResult,
    asOf: string,
  ): Promise<void> {
    await db.insert(reconcile).values({
      id: randomUUID(),
      ledgerId,
      fundCode,
      asOf,
      claimedShares: result.claimedShares,
      derivedShares: result.derivedShares,
      matched: result.matched,
      note: null,
      createdAt: new Date().toISOString(),
    })
  },

  /**
   * 最近一条 `matched: true` 的截止日；从没对得上过则为 `null`。
   *
   * @remarks 对不上的记录不参与排序——它们不能当作「账是对的」的证据。
   */
  async lastMatchedAt(ledgerId: string, fundCode: string): Promise<string | null> {
    const rows = await db
      .select({ asOf: reconcile.asOf })
      .from(reconcile)
      .where(
        and(
          eq(reconcile.ledgerId, ledgerId),
          eq(reconcile.fundCode, fundCode),
          eq(reconcile.matched, true),
        ),
      )
      .orderBy(desc(reconcile.asOf))
      .limit(1)
    return rows[0]?.asOf ?? null
  },
})
