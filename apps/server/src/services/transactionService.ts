/**
 * 录入服务：一笔流水在落库前先用 `derivePosition` 试算一遍。
 *
 * **坏数据不能先入库再等推导时炸**（Review Focus #4）：同日的 `sequence` 冲突、超赎
 * 一旦存进去，之后每条持仓 / 收益 / 风险路由都会在推导时抛错，而用户看不出是哪一笔
 * 录错了。试算通过才写，库里的流水始终是可推导的。
 *
 * Service 不写算式（§二 规则 1）：份额、成本、超赎判定全部由 `core/derivePosition` 给。
 */
import { randomUUID } from 'node:crypto'
import type { createLedgerRepository } from '../repository/ledgerRepository.ts'
import { derivePosition, type LedgerTransaction, type TransactionKind } from '@fundmanager/core'
import type { Sourced } from '../envelope.ts'
import type { createTransactionRepository } from '../repository/transactionRepository.ts'

export type TransactionDeps = {
  readonly transactionRepository: Pick<
    ReturnType<typeof createTransactionRepository>,
    'addAtomically'
  >
  /** 用来确认账本真实存在——见 `addTransaction` 的第一道检查 */
  readonly ledgerRepository: Pick<ReturnType<typeof createLedgerRepository>, 'get'>
}

/**
 * 路由解析出来的、尚未落库的一笔流水。
 *
 * `id` 由本服务生成；手工录入一律是 `confirmed`——`pending` 是数据源拉到、待用户确认的
 * 分红/折算，那条确认流程不在本任务里。
 */
export type NewTransaction = {
  readonly fundCode: string
  /** 业务日期，`YYYY-MM-DD` */
  readonly date: string
  readonly kind: TransactionKind
  /** 份额增减量；缺了由 `derivePosition` 报错并翻译成「这笔记账缺少份额」 */
  readonly sharesDelta: number | null
  /** 折算比例；仅 `split` 需要 */
  readonly splitRatio: number | null
  /** 流向账本为正，申购为负（见 `LedgerTransaction` 的说明） */
  readonly amount: number
  /** 同一天多笔时必填，见 `LedgerTransaction.sequence` */
  readonly sequence: number | null
  readonly note: string | null
}

/** 当前时刻，带中国时区的 ISO 8601——与数据源层 `capturedAt` 同一格式 */
const capturedAtNow = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')

/** 本地账本数据的信封：可信度由账本本身保证、由对账守，故 `stale` 恒 false、无口径损失 */
const fromLedger = <T>(value: T, asOf: string): Sourced<T> => ({
  value,
  reason: null,
  source: 'repository/transaction',
  dataAsOf: asOf,
  capturedAt: capturedAtNow(),
  stale: false,
  loss: null,
  provenance: [],
})

/**
 * 录入一笔流水：先与已有流水一起试算，通过了才写库。
 *
 * @param input 已经过路由层格式校验的流水（数字、日期、kind）
 * @returns 落库后的流水（含生成的 `id`）
 * @throws {TypeError} 试算失败——超赎、同日缺/重 `sequence`、缺必填份额等，
 *   由统一的 `toHttpError` 翻译成可操作的中文；此时**不写库**
 */
export async function addTransaction(
  deps: TransactionDeps,
  ledgerId: string,
  input: NewTransaction,
): Promise<Sourced<LedgerTransaction>> {
  const transaction: LedgerTransaction = {
    ...input,
    id: randomUUID(),
    ledgerId,
    status: 'confirmed',
  }
  // 账本不存在就拒绝。表里没有外键（单机本地库，最简优先），不查这一步的话
  // 一笔流水会挂在一个不存在的 ledgerId 下成功落库：之后按账本查永远查不到它，
  // 而它又真实存在于库里——典型的静默脏数据
  if ((await deps.ledgerRepository.get(ledgerId)) === null) {
    throw new TypeError(`账本 ${ledgerId} 不存在`)
  }

  deps.transactionRepository.addAtomically(transaction, (existing) =>
    validateTransactionHistory(existing, transaction),
  )
  return fromLedger(transaction, input.date)
}

/** 从补录日期试算到历史末尾，保证新流水也不会破坏后续推导。 */
export function validateTransactionHistory(
  history: LedgerTransaction[],
  transaction: LedgerTransaction,
): void {
  const asOf = history.reduce(
    (latest, row) => (row.date > latest ? row.date : latest),
    transaction.date,
  )
  derivePosition(history, transaction.ledgerId, transaction.fundCode, asOf)
}
