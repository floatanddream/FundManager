/**
 * 对账服务：用户声称的平台份额 vs 账本全量重推出来的份额。
 *
 * **只回报结论，绝不自动修正**（设计 §九 / `core/reconcile`）：不插入「调整」流水、
 * 不改任何一笔已有的记录。结论记进 `reconcile` 表，供 `GET .../reconcile/last` 回答
 * 「上次对得上是什么时候」。
 */
import { reconcile, type ReconcileResult } from '@fundmanager/core'
import type { Sourced } from '../envelope.ts'
import type { createLedgerRepository } from '../repository/ledgerRepository.ts'
import type { createReconcileRepository } from '../repository/reconcileRepository.ts'
import type { createTransactionRepository } from '../repository/transactionRepository.ts'

export type ReconcileDeps = {
  readonly transactionRepository: Pick<ReturnType<typeof createTransactionRepository>, 'listByFund'>
  /** 用来确认账本真实存在——见 `reconcileFund` 的第一道检查 */
  readonly ledgerRepository: Pick<ReturnType<typeof createLedgerRepository>, 'get'>
  readonly reconcileRepository: Pick<
    ReturnType<typeof createReconcileRepository>,
    'add' | 'lastMatchedAt'
  >
}

/** 一次对账：结论本身，加上它针对的是哪只基金、截止到哪一天 */
export type ReconcileView = ReconcileResult & {
  readonly fundCode: string
  /** 对账截止日，`YYYY-MM-DD` */
  readonly asOf: string
}

/** 上次对得上的日期 */
export type LastReconcile = {
  readonly fundCode: string
  /** 从未对得上（或从未对过账）时为 null */
  readonly lastMatchedOn: string | null
}

/** 当前时刻，带中国时区的 ISO 8601——与数据源层 `capturedAt` 同一格式 */
const capturedAtNow = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')

/** 中国时区的今天（`YYYY-MM-DD`） */
const todayInChina = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

/** 本地账本数据的信封：可信度由账本本身保证，故 `stale` 恒 false、无口径损失 */
const fromLedger = <T>(value: T, asOf: string, source: string): Sourced<T> => ({
  value,
  reason: null,
  source,
  dataAsOf: asOf,
  capturedAt: capturedAtNow(),
  stale: false,
  loss: null,
  provenance: [],
})

/**
 * 对账一只基金：全量重推，与用户声称的份额比对，并把结论记下来。
 *
 * @param opts.asOf 对账截止日，缺省为今天（中国时区）
 * @returns 是否一致、推导份额、差异、上次对得上的日期
 * @throws {TypeError} 账本不存在、声称份额非有限数、日期非法，或流水本身不可推导
 *   （超赎、同日 `sequence` 缺失/重复等）——后者说明账本已坏，由 `toHttpError` 翻译
 *
 * @remarks 账本里没有这只基金的流水时照常对账：推导份额为 0、通常对不上。那是
 *   有用的结论（「你说有 100 份，账上一笔没有」），不是查错了对象
 */
export async function reconcileFund(
  deps: ReconcileDeps,
  ledgerId: string,
  opts: {
    readonly fundCode: string
    readonly claimedShares: number
    /** 对账截止日，缺省为今天（中国时区） */
    readonly asOf?: string
  },
): Promise<Sourced<ReconcileView>> {
  // 账本不存在就拒绝。`reconcile` 表没有外键（单机本地库，最简优先），不查这一步的话
  // 一条对账结论会挂在不存在的 ledgerId 下成功落库——之后按账本查永远查不到它，
  // 而它又真实存在于库里，与 `addTransaction` 防的是同一类静默脏数据
  if ((await deps.ledgerRepository.get(ledgerId)) === null) {
    throw new TypeError(`账本 ${ledgerId} 不存在`)
  }

  const asOf = opts.asOf ?? todayInChina()
  const transactions = await deps.transactionRepository.listByFund(ledgerId, opts.fundCode)
  const lastMatchedAt = await deps.reconcileRepository.lastMatchedAt(ledgerId, opts.fundCode, asOf)

  const result = reconcile({
    transactions,
    ledgerId,
    fundCode: opts.fundCode,
    asOf,
    claimedShares: opts.claimedShares,
    lastMatchedAt,
  })

  // 记结论，不记「调整」：下一次对账仍从流水全量重推
  await deps.reconcileRepository.add(ledgerId, opts.fundCode, result, asOf)
  return fromLedger({ ...result, fundCode: opts.fundCode, asOf }, asOf, 'repository/reconcile')
}

/**
 * 上次对得上的日期。
 *
 * @returns `lastMatchedOn` 为 null 表示从未对得上——这是事实而非失败，故 `value`
 *   不为 null、`reason` 为空；前端据此显示「尚未对平」而不是报错
 * @throws {TypeError} 账本不存在——查询一个不存在的账本会静默给出「从未对得上」，
 *   把「账本写错了」伪装成有效结论
 */
export async function getLastReconcile(
  deps: ReconcileDeps,
  ledgerId: string,
  fundCode: string,
): Promise<Sourced<LastReconcile>> {
  if ((await deps.ledgerRepository.get(ledgerId)) === null) {
    throw new TypeError(`账本 ${ledgerId} 不存在`)
  }
  const lastMatchedOn = await deps.reconcileRepository.lastMatchedAt(ledgerId, fundCode)
  return fromLedger(
    { fundCode, lastMatchedOn },
    lastMatchedOn ?? todayInChina(),
    'repository/reconcile',
  )
}
