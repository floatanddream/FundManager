/**
 * XIRR 服务：这只基金在该账本里的资金加权年化收益率。
 *
 * **期末市值 = 未复权单位净值 × 份额**（设计 §四.1）：现金分红已经作为一笔正现金流
 * 进入 `toCashFlows`，若期末再用复权净值，同一笔分红就是算两次，收益率虚高。
 *
 * 现金流顺序固定：`toCashFlows` → **`normalizeFlows`** → 末尾追加期末市值 → `xirr`。
 * `normalizeFlows` 不能省：同一天一进一出相抵的流水不是现金流，留着会让 `xirr`
 * 误以为「至少两笔」而去解一个没有意义的方程。
 */
import {
  MultipleRootsError,
  derivePosition,
  normalizeFlows,
  toCashFlows,
  xirr,
  type CashFlow,
  type LedgerTransaction,
} from '@fundmanager/core'
import type { FundDataSource } from '@fundmanager/datasource'
import { fromDerived, type Sourced } from '../envelope.ts'
import type { createTransactionRepository } from '../repository/transactionRepository.ts'
import { getNav } from './navService.ts'

export type ReturnDeps = {
  readonly transactionRepository: Pick<ReturnType<typeof createTransactionRepository>, 'listByFund'>
  readonly dataSource: Pick<FundDataSource, 'navHistory'>
}

/** 一只基金在该账本里的收益画像。`shares` / `cashFlows` 账本内生，不带口径 */
export type FundReturn = {
  readonly fundCode: string
  /** 计算截止日，`YYYY-MM-DD` */
  readonly asOf: string
  readonly shares: number
  /** 期末所用**未复权**单位净值（不是复权净值） */
  readonly endNav: Sourced<number>
  /** 期末市值 = 未复权净值 × 份额；净值取不到时为 null */
  readonly endValue: Sourced<number>
  /** 资金加权年化收益率（小数）；算不出来时 `value` 为 null、原因见 `reason` */
  readonly xirr: Sourced<number>
  /** 纳入求解的现金流：同日已合并，末笔为期末市值 */
  readonly cashFlows: readonly CashFlow[]
}

const NAV_MISSING = '净值历史里没有截止日当天及以前的净值，无法确定期末市值'
const NO_CONFIRMED = '该基金在账本里没有已确认的流水，无法计算收益率'
const NOT_ENOUGH = '现金流不足：至少需要一笔投入与一笔收回才能算年化收益率'

/** 中国时区的今天（`YYYY-MM-DD`） */
const todayInChina = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

/**
 * 净值信封保留出处与降级信息，只把时点改成**实际用到的那一行**。
 *
 * 数据源给的 `dataAsOf` 是整段历史的最新日期；本服务取的是截止日及以前的那一行，
 * 两者在回看历史时不相等。不改成实际行日就等于把旧净值标成新净值（反目标 A3）。
 */
const atNavDate = <T>(envelope: Sourced<T>, date: string): Sourced<T> => ({
  ...envelope,
  dataAsOf: date,
})

/**
 * 求解年化收益率。多解是**正常的数据形态**，不是计算失败：此时不给单一数字。
 *
 * @returns 收益率与不可用原因；两者恰有一个非 null
 */
const solve = (flows: readonly CashFlow[], transactions: readonly LedgerTransaction[]) => {
  try {
    const value = xirr(flows)
    if (value !== null) return { value, reason: null }
    const hasConfirmed = transactions.some((t) => t.status === 'confirmed')
    return { value: null, reason: hasConfirmed ? NOT_ENOUGH : NO_CONFIRMED }
  } catch (error) {
    if (!(error instanceof MultipleRootsError)) throw error
    // 多解不能被冒成 500：用户需要知道「这个数不唯一」，而不是系统故障
    return { value: null, reason: error.message }
  }
}

/**
 * 一只基金在该账本里的 XIRR。
 *
 * @param opts.asOf 计算截止日，缺省为今天（中国时区）；截止日之后的流水不参与
 * @returns 该基金在账本里一笔流水都没有时为 `null`（路由据此回 404：查错了对象）；
 *   净值缺失或现金流不足时 `endValue` / `xirr` 为 `value: null` + `reason`，**不是 0**
 *
 * @remarks 已全部赎回的基金照常返回：期末市值为 0，收益率由流水本身给出。
 */
export async function getFundReturn(
  deps: ReturnDeps,
  ledgerId: string,
  fundCode: string,
  opts: { readonly asOf?: string } = {},
): Promise<Sourced<FundReturn> | null> {
  const asOf = opts.asOf ?? todayInChina()
  const transactions = await deps.transactionRepository.listByFund(ledgerId, fundCode)
  if (transactions.length === 0) return null

  // 份额与现金流用同一个截止日，否则期末市值会配上一段截止日之后的流水
  const upTo = transactions.filter((t) => t.date <= asOf)
  const shares = derivePosition(transactions, ledgerId, fundCode, asOf).shares

  // 只要未复权的 `nav`；`adjusted` 是风险指标的事
  const { nav } = await getNav(deps, fundCode)
  const latest = nav.value?.rows.find((row) => row.nav.date <= asOf) ?? null
  const navInput = latest === null ? nav : atNavDate(nav, latest.nav.date)
  const endNav = fromDerived(latest?.nav.value ?? null, latest === null ? NAV_MISSING : null, [
    navInput,
  ])
  const endValue = fromDerived(
    latest === null ? null : shares * latest.nav.value,
    latest === null ? NAV_MISSING : null,
    [navInput],
  )

  const flows: CashFlow[] = [...normalizeFlows(toCashFlows(upTo, ledgerId, fundCode))]
  // 已全部赎回时期末市值为 0；`xirr` 内部会再归一一次，零金额那一笔自然被剔除
  if (endValue.value !== null) flows.push({ date: asOf, amount: endValue.value })

  // 期末市值都不知道时现金流不完整，不能拿剩下的流水凑一个收益率
  const rate = endValue.value === null ? { value: null, reason: NAV_MISSING } : solve(flows, upTo)

  const view: FundReturn = {
    fundCode,
    asOf,
    shares,
    endNav,
    endValue,
    xirr: fromDerived(rate.value, rate.reason, [endValue]),
    cashFlows: flows,
  }
  return fromDerived(view, null, [endValue])
}
