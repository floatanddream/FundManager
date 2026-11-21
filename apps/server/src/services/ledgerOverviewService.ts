import {
  calculateDailyGain,
  calculateHoldingGain,
  calculateHoldingGainRate,
  derivePosition,
  matchesDailyGainEvents,
  positionChangedAfter,
  positionMarketValue,
  sumKnownAmounts,
  type LedgerPosition,
  type LedgerTransaction,
} from '@fundmanager/core'
import { DataSourceError, type FundDataSource, type NavHistory } from '@fundmanager/datasource'
import { approxEqual } from '@fundmanager/shared'
import { fromDerived, fromFetched, type Sourced } from '../envelope.ts'
import type { createLedgerRepository } from '../repository/ledgerRepository.ts'
import type { createTransactionRepository } from '../repository/transactionRepository.ts'
import { navFetchFailure } from './navService.ts'
import type { PositionView } from './positionService.ts'

export type OverviewDeps = {
  ledgerRepository: Pick<ReturnType<typeof createLedgerRepository>, 'get'>
  transactionRepository: Pick<ReturnType<typeof createTransactionRepository>, 'listAll'>
  dataSource: Pick<FundDataSource, 'navHistory'>
}

type OverviewPosition = PositionView & {
  dailyGain: Sourced<number>
  holdingGainRate: Sourced<number>
}

type Coverage = { included: number; total: number }

export type LedgerOverview = {
  valuationDate: string | null
  previousDate: string | null
  marketValue: Sourced<number>
  dailyGain: Sourced<number>
  marketValueCoverage: Coverage
  dailyGainCoverage: Coverage
  positions: OverviewPosition[]
}

type FundLedger = {
  code: string
  transactions: LedgerTransaction[]
  position: LedgerPosition
}

const NAV_MISSING = '暂无对应日期的确认净值'
const WAITING = '持仓已变动，等待对应净值'
const MISSING_WINDOW = '暂无可比较的两个确认净值日'
const EVENT_UNVERIFIED = '待核对分红或份额折算'
const DATE_NOT_APPLICABLE = '该收益区间无持仓或资金变动'
const UNKNOWN_COST = '成本未知'

/** 按中国时区取本次账本查询的日期和来源记录，供无外部行情的数字使用。 */
function ledgerSignal(clock: Date): Sourced<null> {
  const iso = new Date(clock.getTime() + 8 * 60 * 60 * 1000).toISOString()
  return {
    value: null,
    reason: null,
    source: 'repository/transaction',
    dataAsOf: iso.slice(0, 10),
    capturedAt: iso.replace(/\.\d{3}Z$/, '+08:00'),
    stale: false,
    loss: null,
    provenance: [],
  }
}

/** 只有外部取数失败需要降级，编程错误仍交给应用错误处理器。 */
async function loadNav(
  deps: OverviewDeps,
  code: string,
  today: string,
  historicalEnd?: string,
): Promise<Sourced<NavHistory>> {
  // 用上月月初作为稳定缓存键，避免老基金的全量历史触发上游分页上限。
  const [year, month] = (historicalEnd ?? today).split('-').map(Number)
  const startDate = new Date(Date.UTC(year!, month! - 2, 1)).toISOString().slice(0, 10)
  try {
    return fromFetched(
      await deps.dataSource.navHistory(code, { startDate, endDate: historicalEnd }),
    )
  } catch (error) {
    if (!(error instanceof DataSourceError)) throw error
    return navFetchFailure(code, today, error)
  }
}

/** 一次总览只使用一对净值日，不能逐只基金各选一个“最新日”后直接相加。 */
function chooseWindow(histories: readonly Sourced<NavHistory>[], through: string) {
  const dates = new Set<string>()
  for (const history of histories) {
    for (const { nav } of history.value?.rows ?? []) {
      if (nav.date <= through) dates.add(nav.date)
    }
  }
  const [valuationDate = null, previousDate = null] = [...dates].sort().reverse()
  return { valuationDate, previousDate }
}

/** 已清仓基金若属于收益观察窗口，仍须计入总览覆盖分母。 */
function hasDailyExposure(
  fund: FundLedger,
  ledgerId: string,
  previousDate: string,
  valuationDate: string,
) {
  if (fund.transactions.some((tx) => tx.date > previousDate && tx.date <= valuationDate))
    return true
  return !approxEqual(
    derivePosition(fund.transactions, ledgerId, fund.code, previousDate).shares,
    0,
  )
}

/** 由一份确认净值历史同时组装当前持仓和区间收益。 */
function makePosition(
  fund: FundLedger,
  ledgerId: string,
  ledger: Sourced<null>,
  nav: Sourced<NavHistory> | undefined,
  valuationDate: string | null,
  previousDate: string | null,
  hasExposure: boolean,
): OverviewPosition {
  const { shares, realizedGain, cost, costPerShare } = fund.position
  const isHeld = !approxEqual(shares, 0)
  const rows = nav?.value?.rows ?? []
  const latest = rows.find((row) => row.nav.date === valuationDate)?.nav
  const previous = rows.find((row) => row.nav.date === previousDate)?.nav
  const latestInput = nav && latest ? { ...nav, dataAsOf: latest.date } : nav
  const marketInput = latestInput ?? ledger
  let marketValue = fromDerived<number>(0, null, [ledger])
  if (isHeld) {
    if (!latest) {
      marketValue = fromDerived<number>(null, nav?.reason ?? NAV_MISSING, [marketInput])
    } else if (
      positionChangedAfter(fund.transactions, ledgerId, fund.code, latest.date, ledger.dataAsOf)
    ) {
      marketValue = fromDerived<number>(null, WAITING, [marketInput])
    } else {
      marketValue = fromDerived(positionMarketValue(shares, latest), null, [marketInput])
    }
  }
  const gain = calculateHoldingGain(marketValue.value, cost)
  const gainReason = cost === null ? UNKNOWN_COST : marketValue.reason
  const rate = calculateHoldingGainRate(gain, cost)
  const rateReason = rate !== null ? null : (gainReason ?? '成本不为正，无法计算持有收益率')
  let dailyGain = fromDerived<number>(null, DATE_NOT_APPLICABLE, [ledger])
  if (hasExposure) {
    if (!valuationDate || !previousDate) {
      dailyGain = fromDerived<number>(null, MISSING_WINDOW, [nav ?? ledger])
    } else if (!nav?.value || nav.loss) {
      // 备源可能没有分红和折算字段，日收益不能假定当期无事件。
      dailyGain = fromDerived<number>(null, nav?.reason ?? '净值事件数据不完整', [nav ?? ledger])
    } else {
      const base = {
        ledgerId,
        fundCode: fund.code,
        transactions: fund.transactions,
        previousDate,
        valuationDate,
      }
      const observations = rows.filter(
        (row) => row.nav.date > previousDate && row.nav.date <= valuationDate,
      )
      const input = { ...nav, dataAsOf: valuationDate }
      const gainValue = calculateDailyGain({
        ...base,
        previousNav: previous ?? null,
        latestNav: latest ?? null,
      })
      if (gainValue === null) {
        dailyGain = fromDerived<number>(null, NAV_MISSING, [nav])
      } else if (!matchesDailyGainEvents(base, observations)) {
        dailyGain = fromDerived<number>(null, EVENT_UNVERIFIED, [input])
      } else {
        dailyGain = fromDerived(gainValue, null, [input])
      }
    }
  }

  return {
    fundCode: fund.code,
    shares,
    realizedGain,
    asOf: ledger.dataAsOf,
    marketValue,
    dailyGain,
    cost: fromDerived<number>(cost, cost === null ? UNKNOWN_COST : null, [ledger]),
    costPerShare: fromDerived<number>(
      costPerShare,
      costPerShare === null ? (cost === null ? UNKNOWN_COST : '份额为零') : null,
      [ledger],
    ),
    unrealizedGain: fromDerived<number>(gain, gainReason, [marketValue]),
    holdingGainRate: fromDerived<number>(rate, rateReason, [marketValue]),
  }
}

/**
 * 读取账本的统一估值窗口、资产与当日收益。按基金复用一次确认净值历史。
 *
 * @param clock 可注入的查询时刻，统一按中国时区截断流水和净值。
 * @returns 未知账本返回 null；部分可用金额由覆盖字段说明。
 * @throws {TypeError} 账本流水不合法。
 */
export async function getLedgerOverview(
  deps: OverviewDeps,
  ledgerId: string,
  clock: Date = new Date(),
): Promise<Sourced<LedgerOverview> | null> {
  if (!(await deps.ledgerRepository.get(ledgerId))) return null
  const ledger = ledgerSignal(clock)
  const today = ledger.dataAsOf
  const transactionsByFund = new Map<string, LedgerTransaction[]>()
  for (const tx of await deps.transactionRepository.listAll(ledgerId)) {
    if (tx.status !== 'confirmed' || tx.date > today) continue
    const fundTransactions = transactionsByFund.get(tx.fundCode)
    if (fundTransactions) fundTransactions.push(tx)
    else transactionsByFund.set(tx.fundCode, [tx])
  }
  const funds = Array.from(transactionsByFund, ([code, transactions]) => ({
    code,
    transactions,
    position: derivePosition(transactions, ledgerId, code, today),
  }))
  const held = funds.filter((fund) => !approxEqual(fund.position.shares, 0))
  const lastRedemption =
    held.length === 0
      ? funds
          .flatMap((fund) => fund.transactions)
          .filter((tx) => tx.kind === 'redeem')
          .map((tx) => tx.date)
          .sort()
          .at(-1)
      : undefined
  const anchors = lastRedemption
    ? funds.filter((fund) =>
        fund.transactions.some((tx) => tx.kind === 'redeem' && tx.date === lastRedemption),
      )
    : held
  const histories = new Map<string, Sourced<NavHistory>>()
  /** 清仓的历史净值只在参与本期时补取，不让老持仓拖慢总览。 */
  async function fetchHistory(fund: FundLedger) {
    if (!histories.has(fund.code)) {
      histories.set(fund.code, await loadNav(deps, fund.code, today, lastRedemption))
    }
  }
  await Promise.all(anchors.map(fetchHistory))
  const { valuationDate, previousDate } = chooseWindow(
    [...histories.values()],
    lastRedemption ?? today,
  )
  const dailyFunds =
    previousDate && valuationDate
      ? funds.filter((fund) => hasDailyExposure(fund, ledgerId, previousDate, valuationDate))
      : anchors
  const dailyCodes = new Set(dailyFunds.map((fund) => fund.code))
  await Promise.all(dailyFunds.map(fetchHistory))
  const positions = funds.map((fund) =>
    makePosition(
      fund,
      ledgerId,
      ledger,
      histories.get(fund.code),
      valuationDate,
      previousDate,
      dailyCodes.has(fund.code),
    ),
  )
  const marketInputs = positions
    .filter((position) => !approxEqual(position.shares, 0))
    .map((p) => p.marketValue)
  const dailyInputs = positions.filter((p) => dailyCodes.has(p.fundCode)).map((p) => p.dailyGain)
  const market = sumKnownAmounts(
    marketInputs.map((input) => input.value),
    marketInputs.length ? null : 0,
  )
  const daily = sumKnownAmounts(
    dailyInputs.map((input) => input.value),
    null,
  )
  const marketValue = fromDerived<number>(
    market.value,
    market.value === null ? '暂无可计价的持仓' : null,
    marketInputs.length ? marketInputs : [ledger],
  )
  const dailyGain = fromDerived<number>(
    daily.value,
    daily.value !== null
      ? null
      : !previousDate
        ? MISSING_WINDOW
        : (dailyInputs.find((input) => input.reason)?.reason ?? '暂无可计算的当日收益'),
    dailyInputs.length ? dailyInputs : [ledger],
  )
  return fromDerived(
    {
      valuationDate,
      previousDate,
      marketValue,
      dailyGain,
      positions,
      marketValueCoverage: market.coverage,
      dailyGainCoverage: daily.coverage,
    },
    null,
    [marketValue, dailyGain],
  )
}
