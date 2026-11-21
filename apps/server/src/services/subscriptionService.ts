import { randomUUID } from 'node:crypto'
import { subscriptionShares, type LedgerTransaction } from '@fundmanager/core'
import { DataSourceError, type FundDataSource } from '@fundmanager/datasource'
import type { createLedgerRepository } from '../repository/ledgerRepository.ts'
import type { createTransactionRepository } from '../repository/transactionRepository.ts'
import type {
  createSubscriptionRepository,
  SubscriptionDraft,
} from '../repository/subscriptionRepository.ts'
import { validateTransactionHistory } from './transactionService.ts'

type NewDraft = Omit<SubscriptionDraft, 'id'>
type QuoteInput = { navDate: string; fee: number }
type ConfirmInput = { navDate: string; fee?: number; shares?: number; sequence: number | null }

export type SubscriptionDeps = {
  ledgerRepository: Pick<ReturnType<typeof createLedgerRepository>, 'get'>
  subscriptionRepository: ReturnType<typeof createSubscriptionRepository>
  transactionRepository: Pick<
    ReturnType<typeof createTransactionRepository>,
    'confirmSubscriptionAtomically'
  >
  dataSource: Pick<FundDataSource, 'navHistory'>
}

const today = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

export async function listSubscriptions(deps: SubscriptionDeps, ledgerId: string) {
  if (!(await deps.ledgerRepository.get(ledgerId))) return null
  return deps.subscriptionRepository.listPending(ledgerId)
}

/** 保存原始申购信息，等成交信息齐备后才写正式流水。 */
export async function createSubscription(
  deps: SubscriptionDeps,
  ledgerId: string,
  input: NewDraft,
) {
  if (input.orderDate > today()) throw new TypeError('交易日期不能晚于今天')
  if (!(await deps.ledgerRepository.get(ledgerId))) return null
  const draft = { id: randomUUID(), ...input }
  await deps.subscriptionRepository.add(ledgerId, draft)
  return draft
}

function validateNavDate(draft: SubscriptionDraft, navDate: string): void {
  if (navDate < draft.orderDate || navDate > today())
    throw new TypeError('净值日期须在交易日期与今天之间')
}

/** 只用确切日期的确认净值，取不到或缓存已过期时保留草稿。 */
async function calculateQuote(
  deps: SubscriptionDeps,
  draft: SubscriptionDraft,
  { navDate, fee }: QuoteInput,
) {
  if (fee >= draft.amount) throw new TypeError('申购费必须小于申购金额')
  const unavailable = (reason: string) => ({ shares: null, nav: null, navDate, reason })
  try {
    const fetched = await deps.dataSource.navHistory(draft.fundCode, {
      startDate: navDate,
      endDate: navDate,
    })
    if (fetched.stale) return unavailable('该日期的净值缓存已过期，请稍后重试')
    const nav = fetched.value.rows.find(
      (row) => row.nav.date === navDate && row.nav.kind === 'nav',
    )?.nav
    if (!nav || nav.value <= 0)
      return unavailable('该日期暂无可用的确认净值，请稍后重试或填写平台回单份额')
    return {
      shares: subscriptionShares(draft.amount, fee, nav),
      nav: nav.value,
      navDate,
      reason: null,
    }
  } catch (error) {
    if (!(error instanceof DataSourceError)) throw error
    return unavailable('暂时无法取得该日期的确认净值，请稍后重试或填写平台回单份额')
  }
}

export async function quoteSubscription(
  deps: SubscriptionDeps,
  ledgerId: string,
  id: string,
  input: QuoteInput,
) {
  const entry = await deps.subscriptionRepository.get(ledgerId, id)
  if (!entry) return null
  validateNavDate(entry.draft, input.navDate)
  return calculateQuote(deps, entry.draft, input)
}

/** 重试返回库中原流水。回单路径在无基金净值时仍能确认。 */
export async function confirmSubscription(
  deps: SubscriptionDeps,
  ledgerId: string,
  id: string,
  input: ConfirmInput,
) {
  const entry = await deps.subscriptionRepository.get(ledgerId, id)
  if (!entry) return null
  const { draft } = entry
  const confirmed = (date: string, sharesDelta: number) => ({
    id,
    fundCode: draft.fundCode,
    date,
    sharesDelta,
    status: 'confirmed' as const,
  })
  if (entry.date !== null && entry.sharesDelta !== null)
    return confirmed(entry.date, entry.sharesDelta)

  const { navDate, fee, sequence } = input
  validateNavDate(draft, navDate)
  let shares = input.shares
  if (shares === undefined) {
    if (fee === undefined) throw new TypeError('请填写实际申购费，免手续费填 0')
    const quote = await calculateQuote(deps, draft, { navDate, fee })
    if (quote.shares === null) throw new TypeError(quote.reason)
    shares = quote.shares
  }
  const transaction: LedgerTransaction = {
    id,
    ledgerId,
    fundCode: draft.fundCode,
    date: navDate,
    kind: 'subscribe',
    sharesDelta: shares,
    splitRatio: null,
    amount: -draft.amount,
    status: 'confirmed',
    sequence,
    note: null,
  }
  const saved = deps.transactionRepository.confirmSubscriptionAtomically(transaction, (existing) =>
    validateTransactionHistory(existing, transaction),
  )
  if (saved.sharesDelta === null) throw new Error('已确认的申购流水缺少份额')
  return confirmed(saved.date, saved.sharesDelta)
}
