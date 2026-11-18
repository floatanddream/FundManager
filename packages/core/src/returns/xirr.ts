import { assertDate, daysBetween } from '@fundmanager/shared'
import { normalizeFlows, type CashFlow } from './cashflow.ts'

/** 一年按 365 天计，与 XIRR 的行业惯例一致（不按 365.25，否则与券商数字对不上）。 */
const DAYS_PER_YEAR = 365

/** 判定 npv 已足够接近 0 的阈值。再往下压会被浮点噪声主导，纯属浪费迭代。 */
const NPV_EPSILON = 1e-10

/** 牛顿法迭代上限。超出即认为不收敛，交二分法兜底。 */
const NEWTON_MAX_ITERATIONS = 100

/** 二分法迭代上限。二分每次折半，200 次足以把初始区间压到 1e-60 量级。 */
const BISECTION_MAX_ITERATIONS = 200

/** 二分法搜索区间。下界 -0.9999 而非 -1，因为 rate = -1 时分母为 0。 */
const RATE_LOWER_BOUND = -0.9999
/** 上界取 1000%：再高的年化没有实际意义，且容易把求根带偏。 */
const RATE_UPPER_BOUND = 10

/**
 * 取最早一笔的日期，作为贴现基准。
 *
 * 「距最早一笔的天数」是 XIRR 的公开定义，基准必须是数组里最早的日期而非首元素：
 * 乱序输入时首元素未必最早，用它会得到基准错误、数值却看着合理的 NPV。
 * 日期为 YYYY-MM-DD，字典序即时间序，可直接字符串比较。
 *
 * @returns 最早日期；flows 为空时返回 null
 * @throws {TypeError} 任一 date 非法或 amount 不是有限数
 */
function baseDate(flows: readonly CashFlow[]): string | null {
  let earliest: string | null = null
  for (const f of flows) {
    assertDate(f.date, 'CashFlow.date')
    if (!Number.isFinite(f.amount)) {
      throw new TypeError(`CashFlow.amount 必须是有限数，收到：${f.amount}`)
    }
    if (earliest === null || f.date < earliest) earliest = f.date
  }
  return earliest
}

/**
 * 净现值：把各笔现金流按天数贴现到最早一笔当日再求和。
 *
 * 基准取最早一笔而非首元素，故结果与输入顺序无关。
 *
 * @param rate 年化贴现率
 * @param flows 现金流，顺序任意
 * @returns 净现值。空数组返回 0
 * @throws {TypeError} 任一 date 非法或 amount 不是有限数
 */
export function npv(rate: number, flows: readonly CashFlow[]): number {
  const base = baseDate(flows)
  if (base === null) return 0
  return flows.reduce(
    (sum, f) => sum + f.amount / (1 + rate) ** (daysBetween(base, f.date) / DAYS_PER_YEAR),
    0,
  )
}

/**
 * npv 对 rate 的一阶导数，供牛顿法使用。
 *
 * 仅在 xirr 内部对归一后的现金流调用，此时首元素即最早一笔，基准与 npv 一致。
 */
function npvDerivative(rate: number, flows: readonly CashFlow[]): number {
  const first = flows[0]
  if (first === undefined) return 0
  return flows.reduce((sum, f) => {
    const t = daysBetween(first.date, f.date) / DAYS_PER_YEAR
    return sum - (t * f.amount) / (1 + rate) ** (t + 1)
  }, 0)
}

/**
 * 牛顿法求根。快，但从坏初值出发可能不收敛或跑向无意义的方向。
 *
 * @returns 收敛则返回解，否则返回 null（由二分法接手）
 */
function solveNewton(flows: readonly CashFlow[]): number | null {
  // 初值 0.1：多数基金持仓的年化收益落在这个量级附近
  let rate = 0.1
  for (let i = 0; i < NEWTON_MAX_ITERATIONS; i++) {
    const value = npv(rate, flows)
    if (Math.abs(value) < NPV_EPSILON) return rate

    const slope = npvDerivative(rate, flows)
    // 导数为 0 就无法定出下一步方向；非有限值说明已跑到数值边界外
    if (!Number.isFinite(slope) || slope === 0) return null

    const next = rate - value / slope
    // rate <= -1 会让 (1 + rate) 非正，贴现失去意义（且可能除零）
    if (!Number.isFinite(next) || next <= -1) return null
    // 步长已小于浮点分辨率，再迭代也不会变，直接接受
    if (Math.abs(next - rate) < 1e-12) return next
    rate = next
  }
  return null
}

/**
 * 二分法求根。比牛顿法慢，但只要有符号变化就必然收敛。
 *
 * @returns 区间内有解则返回近似解；两端同号（无解）返回 null
 */
function solveBisection(flows: readonly CashFlow[]): number | null {
  let lo = RATE_LOWER_BOUND
  let hi = RATE_UPPER_BOUND
  let fLo = npv(lo, flows)
  const fHi = npv(hi, flows)
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null
  // 两端同号说明区间内不存在零点，继续折半没有意义
  if (fLo * fHi > 0) return null

  for (let i = 0; i < BISECTION_MAX_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid, flows)
    if (Math.abs(fMid) < NPV_EPSILON) return mid
    // 零点必在被符号变化夹住的那一侧，据此收缩区间
    if (fLo * fMid < 0) {
      hi = mid
    } else {
      lo = mid
      fLo = fMid
    }
  }
  return (lo + hi) / 2
}

/**
 * 资金加权收益率（年化）。回答「我这笔钱实际赚了多少」，
 * 与时间加权（TWR）回答的「基金经理行不行」是两个不同问题。
 *
 * @param flows 现金流，顺序任意。amount 负数为投入，正数为收回
 * @returns 年化收益率；无解时返回 null
 * @throws {TypeError} 日期非法或金额不是有限数（调用方的 bug，须早暴露）
 */
export function xirr(flows: readonly CashFlow[]): number | null {
  const normalized = normalizeFlows(flows)

  // 只有一笔现金流构不成投资行为，谈不上收益率
  if (normalized.length < 2) return null

  // 全部同号意味着「只有投入没有收回」或反之——方程无解，不是算不出来，
  // 是这个问题的答案客观上不存在
  const hasNegative = normalized.some((f) => f.amount < 0)
  const hasPositive = normalized.some((f) => f.amount > 0)
  if (!hasNegative || !hasPositive) return null

  // 先试快的；牛顿法放弃时（返回 null）由二分法兜底，故用 ?? 而非 ||
  return solveNewton(normalized) ?? solveBisection(normalized)
}
