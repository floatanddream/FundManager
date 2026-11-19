import { approxEqual, navConfirmed } from '@fundmanager/shared'
import type { NavConfirmed } from '@fundmanager/shared'
import { assertNavSeries } from './series.ts'

/** 附在净值行上的分红/折算事件，与 `packages/datasource` 的 `NavEvent` 结构兼容。 */
export type NavSeriesEvent = {
  readonly kind: 'dividend' | 'split' | 'unknown'
  /** 分红：每份现金额；折算：1 份折成几份（接口 `FHFCZ`，含义仅有样本佐证）。缺失为 null */
  readonly perUnit: number | null
  /** 每 10 份数值，分红时作为 `perUnit` 的后备 */
  readonly per10Unit: number | null
  readonly description?: string
}

/** 复权函数的输入行，与 `NavHistoryRow` 结构兼容；顺序不限。 */
export type NavSeriesRow = {
  readonly nav: NavConfirmed
  /** 累计净值（`LJJZ`）；缺失为 null */
  readonly accNav: number | null
  readonly event: NavSeriesEvent | null
}

/** 净值与事件金额都是 4 位小数，两侧各自舍入后差不超过 ~2e-4。 */
const ACC_TOLERANCE = 1e-3

/** 事件对应的每份现金分红；换算不出正数时返回 null。 */
function dividendPerUnit(event: NavSeriesEvent): number | null {
  const perUnit = event.perUnit ?? (event.per10Unit !== null ? event.per10Unit / 10 : null)
  return perUnit !== null && perUnit > 0 ? perUnit : null
}

/**
 * 把「未复权单位净值 + 累计净值/分红事件」换算成分红再投口径的复权净值序列。
 *
 * **为什么必须复权**：分红除息日未复权单位净值会机械下跌（跌的正是分红 ÷ 前日净值），
 * 持有人实际没亏。直接拿未复权净值算日收益、波动率、最大回撤、相关性，每个指标都会
 * 「看着合理」地错——日收益被记成亏损、波动率被抬高、最大回撤凭空多出一次、
 * 相关性被压低。风险指标只接受本函数输出的序列。
 *
 * **推导**（持有 1 份，分红再投）：
 * 除息日前一单位净值为 P₋，除息日单位净值为 P，每份派现金 d。若把 d 当日按净值再投，
 * 除息日每份总价值 = P + d，故当日总收益 = (P + d)/P₋ − 1。
 * 复权序列取 A₀ = P₀、A_t = Aₜ₋₁ · (P_t + d_t)/Pₜ₋₁，即分红再投口径的净值指数。
 * 手算：P₋ = 1.5、P = 1.4、d = 0.1 → 当日收益 (1.4 + 0.1)/1.5 − 1 = 0（分红不造成亏损）；
 * 未复权则记成 1.4/1.5 − 1 ≈ −6.67%，凭空造出回撤。
 *
 * **累计净值的角色**：`LJJZ` 按「单位净值 + 每份累计分红」定义，无折算时满足
 * ΔLJJZ = ΔP + d，即 d = ΔLJJZ − ΔP。事件金额缺失（备源没有事件字段，一律 null）时用它反推；
 * 事件金额存在时用它交叉校验，矛盾超过舍入误差即抛错——不猜、不静默挑一个。
 *
 * **份额折算**：1 份折成 k 份、单位净值除以 k，持有人市值不变，当日市值 = P·k，
 * 当日总收益按 (P·k)/P₋ − 1，k 取事件的 `perUnit`。累计净值在折算日是否被同比例调整
 * 无法在本地数据上验证，故折算日**不做**累计净值交叉校验，只认事件比例。
 *
 * **降级与假设**：普通日与分红日只要至少一侧数据在场即可复权。
 * 未知事件（`kind: 'unknown'`）或缺金额的事件且无累计净值可反推时抛错，
 * 绝不按普通日静默处理——那会把分红记成亏损。
 *
 * @param rows 净值历史行，顺序不限，按日期升序输出；同一日期重复会由 assertNavSeries 拦下
 * @param fundCode 出错时用于定位的基金代码
 * @returns 复权后的确认净值序列，`value` 为复权净值指数，不是真实单位净值
 * @throws {TypeError} 事件无法解析、分红金额与累计净值矛盾，或序列本身非法
 */
export function toAdjustedSeries(
  rows: readonly NavSeriesRow[],
  fundCode = '该基金',
): NavConfirmed[] {
  if (rows.length === 0) return []
  const sorted = [...rows].sort((a, b) =>
    a.nav.date < b.nav.date ? -1 : a.nav.date > b.nav.date ? 1 : 0,
  )

  const first = sorted[0]!
  let prevNav = first.nav.value
  let prevAcc = first.accNav
  let prevAdjusted = first.nav.value
  const adjusted: NavConfirmed[] = [navConfirmed(first.nav.value, first.nav.date)]

  for (let i = 1; i < sorted.length; i++) {
    const row = sorted[i]!
    const nav = row.nav.value
    const acc = row.accNav
    const event = row.event
    // 累计净值反推的每份分红（ΔLJJZ − ΔP）；两侧都有累计净值才算得出，|值| 在容差内视作 0
    const implied = acc !== null && prevAcc !== null ? acc - prevAcc - (nav - prevNav) : null
    const impliedDividend = implied !== null && Math.abs(implied) > ACC_TOLERANCE ? implied : null
    const dividend = event?.kind === 'dividend' ? dividendPerUnit(event) : null
    const split = event?.kind === 'split' ? event.perUnit : null

    let ratio: number
    if (dividend !== null) {
      if (implied !== null && !approxEqual(dividend, implied, ACC_TOLERANCE)) {
        throw new TypeError(
          `${fundCode} ${row.nav.date} 的分红每份 ${dividend} 与累计净值反推的 ${implied} 不一致，无从判断哪一侧错，拒绝复权`,
        )
      }
      ratio = (nav + dividend) / prevNav
    } else if (split !== null && split > 0) {
      ratio = (nav * split) / prevNav
    } else if (event !== null) {
      // 有事件却既无金额/比例、也无累计净值可反推：按普通日处理会把分红记成亏损
      const description = event!.description ? `（${event!.description}）` : ''
      throw new TypeError(
        `${fundCode} ${row.nav.date} 的事件${description}缺少可用的金额或比例，且无累计净值可反推，无法复权`,
      )
    } else {
      // 分红日金额缺失时按累计净值反推；普通日 impliedDividend 为 0
      ratio = (nav + (impliedDividend ?? 0)) / prevNav
    }

    prevAdjusted *= ratio
    adjusted.push(navConfirmed(prevAdjusted, row.nav.date))
    prevNav = nav
    prevAcc = acc
  }

  assertNavSeries(adjusted)
  return adjusted
}
