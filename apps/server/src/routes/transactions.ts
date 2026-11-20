/**
 * 流水与对账路由（账本内，设计 §六）：流水是因为你持有才存在的记录，路径带 `ledgerId`。
 *
 * 只做参数校验与调 Service，不写算式（§二 规则 1）。校验失败一律抛 `TypeError`，
 * 由统一错误处理器翻译成可操作的中文——`TypeError` 原文不会直接出现在响应里。
 */
import type { FastifyInstance } from 'fastify'
import type { TransactionKind } from '@fundmanager/core'
import { assertDate } from '@fundmanager/shared'
import {
  addTransaction,
  type NewTransaction,
  type TransactionDeps,
} from '../services/transactionService.ts'
import {
  getLastReconcile,
  reconcileFund,
  type ReconcileDeps,
} from '../services/reconcileService.ts'

export type TransactionRouteDeps = TransactionDeps & ReconcileDeps

/** 公募基金代码均为 6 位数字；格式不对在入口拦下，不让上游用「查无此基金」当成功 */
const FUND_CODE = /^\d{6}$/

const KINDS: readonly TransactionKind[] = [
  'subscribe',
  'redeem',
  'dividend_cash',
  'dividend_reinvest',
  'split',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * 校验基金代码。
 *
 * @throws {TypeError} 不是 6 位数字——走统一错误翻译成 400
 */
const assertFundCode = (fundCode: string): string => {
  if (!FUND_CODE.test(fundCode)) {
    throw new TypeError(`基金代码必须是 6 位数字，收到「${fundCode}」`)
  }
  return fundCode
}

/**
 * 可选数字字段：缺省为 null。传了就必须是有限数——`NaN` / 字符串会被后续推导
 * 静默吞成 `NaN` 份额，必须在入口拦下。
 */
const optionalNumber = (value: unknown, field: string): number | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} 必须是数字，收到「${String(value)}」`)
  }
  return value
}

/**
 * 必填数字字段。缺了说清缺的是哪个——「缺少份额」之类的提示决定用户能不能自己修。
 */
const requiredNumber = (value: unknown, field: string, missing: string): number => {
  if (value === undefined || value === null) throw new TypeError(missing)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} 必须是数字，收到「${String(value)}」`)
  }
  return value
}

/** 各流水类型的中文名，用于把符号错误说成用户读得懂的话 */
const KIND_LABELS: Readonly<Record<TransactionKind, string>> = {
  subscribe: '申购',
  redeem: '赎回',
  dividend_cash: '现金分红',
  dividend_reinvest: '红利再投',
  split: '份额折算',
}

/**
 * 按 `kind` 校验符号：份额增减、折算比例、金额的符号各有业务含义，填反了不会在
 * 推导时炸，只会静默算出反向的账（赎回加仓、申购得到负成本、折算把份额变负）。
 *
 * @throws {TypeError} 符号与 `kind` 矛盾
 */
const assertSigns = (t: NewTransaction): void => {
  const label = KIND_LABELS[t.kind]
  if (
    (t.kind === 'subscribe' || t.kind === 'dividend_reinvest') &&
    t.sharesDelta !== null &&
    t.sharesDelta <= 0
  ) {
    throw new TypeError(`${label}的 sharesDelta 必须为正（份额增加），收到「${t.sharesDelta}」`)
  }
  if (t.kind === 'redeem' && t.sharesDelta !== null && t.sharesDelta >= 0) {
    throw new TypeError(`赎回的 sharesDelta 必须为负（份额减少），收到「${t.sharesDelta}」`)
  }
  if (t.kind === 'split' && t.splitRatio !== null && t.splitRatio <= 0) {
    throw new TypeError(`份额折算的 splitRatio 必须为正，收到「${t.splitRatio}」`)
  }
  // 金额流向账本为正：申购是钱离开账本，恒负；赎回与分红是钱回到账本，非负
  if (t.kind === 'subscribe' && t.amount >= 0) {
    throw new TypeError(`申购的 amount 必须为负（钱流出账本），收到「${t.amount}」`)
  }
  if (
    (t.kind === 'redeem' || t.kind === 'dividend_cash' || t.kind === 'dividend_reinvest') &&
    t.amount < 0
  ) {
    throw new TypeError(`${label}的 amount 必须为非负（钱流入账本），收到「${t.amount}」`)
  }
}

/**
 * 解析录入流水的请求体。
 *
 * `sequence` 由前端显式给（设计 §十四：同日顺序不能靠入参顺序）；同日多笔却没给时
 * `derivePosition` 会报错并被翻译成「同一天有多笔流水，需要指定先后顺序」。
 *
 * @throws {TypeError} 缺必填字段、类型不对、日期非法、未知 `kind`、符号与 `kind` 矛盾
 */
export const parseNewTransaction = (body: unknown): NewTransaction => {
  if (!isRecord(body)) throw new TypeError('请求体必须是一个 JSON 对象')
  const { fundCode, date, kind } = body
  if (typeof fundCode !== 'string' || fundCode === '') {
    throw new TypeError('这笔记账缺少基金代码')
  }
  if (typeof date !== 'string' || date === '') throw new TypeError('这笔记账缺少日期')
  if (typeof kind !== 'string' || !KINDS.includes(kind as TransactionKind)) {
    throw new TypeError(`这笔记账的流水类型无法识别，应为 ${KINDS.join(' / ')}`)
  }
  const sequence = optionalNumber(body.sequence, 'sequence')
  if (sequence !== null && (!Number.isInteger(sequence) || sequence < 0)) {
    throw new TypeError(`sequence 必须是非负整数，收到「${String(body.sequence)}」`)
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    throw new TypeError('note 必须是字符串')
  }
  const parsed: NewTransaction = {
    fundCode: assertFundCode(fundCode),
    date: assertDate(date, 'date'),
    kind: kind as TransactionKind,
    sharesDelta: optionalNumber(body.sharesDelta, 'sharesDelta'),
    splitRatio: optionalNumber(body.splitRatio, 'splitRatio'),
    amount: requiredNumber(body.amount, 'amount', '这笔记账缺少金额'),
    sequence,
    note: (body.note as string | null | undefined) ?? null,
  }
  assertSigns(parsed)
  return parsed
}

/** 解析对账请求体：声称份额是该基金当前的实际份额 */
const parseReconcile = (
  body: unknown,
): { readonly fundCode: string; readonly claimedShares: number; readonly asOf?: string } => {
  if (!isRecord(body)) throw new TypeError('请求体必须是一个 JSON 对象')
  const { fundCode, claimedShares, asOf } = body
  if (typeof fundCode !== 'string' || fundCode === '') {
    throw new TypeError('对账缺少基金代码')
  }
  return {
    fundCode: assertFundCode(fundCode),
    claimedShares: requiredNumber(claimedShares, 'claimedShares', '对账缺少你实际持有的份额'),
    asOf: asOf === undefined || asOf === null ? undefined : assertDate(String(asOf), 'asOf'),
  }
}

export function registerTransactionRoutes(app: FastifyInstance, deps: TransactionRouteDeps): void {
  app.post<{ Params: { ledgerId: string } }>(
    '/api/ledgers/:ledgerId/transactions',
    async (request, reply) => {
      const result = await addTransaction(
        deps,
        request.params.ledgerId,
        parseNewTransaction(request.body),
      )
      return reply.code(201).send(result)
    },
  )

  app.post<{ Params: { ledgerId: string } }>(
    '/api/ledgers/:ledgerId/reconcile',
    async (request) => {
      const { fundCode, claimedShares, asOf } = parseReconcile(request.body)
      return reconcileFund(deps, request.params.ledgerId, { fundCode, claimedShares, asOf })
    },
  )

  app.get<{ Params: { ledgerId: string }; Querystring: { fundCode?: unknown } }>(
    '/api/ledgers/:ledgerId/reconcile/last',
    async (request) => {
      // 对账按基金进行，「上次对得上」必须指明是哪只基金，否则无从回答
      const fundCode = request.query.fundCode
      if (typeof fundCode !== 'string' || fundCode === '') {
        throw new TypeError('查询上次对账日期需要 fundCode（对账按基金进行）')
      }
      return getLastReconcile(deps, request.params.ledgerId, assertFundCode(fundCode))
    },
  )
}
