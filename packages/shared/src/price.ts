import { assertDate } from './date.ts'

/**
 * T-1 确认净值：基金公司收盘后公布。收益与风险计算**只能**用这个。
 *
 * **`value` 的口径**：进入收益/风险计算时必须是**复权净值（分红再投）**，
 * 由 `@fundmanager/core` 的 `toAdjustedSeries` 从净值历史换算得到。
 * 数据源给的 `nav` 是**未复权单位净值**（`DWJZ`），分红除息日会机械下跌，
 * 直接映射进本类型再算风险会在分红日造出假亏损与假回撤。
 */
export type NavConfirmed = {
  readonly kind: 'nav'
  /** 复权净值（分红再投口径）；原始单位净值须先经 toAdjustedSeries 换算 */
  readonly value: number
  /** YYYY-MM-DD */
  readonly date: string
}

/** 盘中估值：由跟踪指数涨跌推算。**仅供参考，不得参与收益计算。** */
export type NavEstimate = {
  readonly kind: 'estimate'
  readonly value: number
  /** ISO 时间戳，非业务日期，不做 YYYY-MM-DD 校验 */
  readonly asOf: string
  /** 推算所依据的指数，如「上证科创板50成份指数」 */
  readonly basis: string
}

/** 场内成交价：含折溢价，与净值不等。 */
export type MarketPrice = {
  readonly kind: 'price'
  readonly value: number
  /** ISO 时间戳，非业务日期，不做 YYYY-MM-DD 校验 */
  readonly asOf: string
}

export type AnyPrice = NavConfirmed | NavEstimate | MarketPrice

/**
 * 构造确认净值。
 *
 * @param value 单位净值
 * @param date 净值日期，YYYY-MM-DD
 * @returns 确认净值对象
 * @throws {TypeError} date 不是合法的 YYYY-MM-DD
 */
export function navConfirmed(value: number, date: string): NavConfirmed {
  return { kind: 'nav', value, date: assertDate(date, 'navConfirmed.date') }
}

/** 构造盘中估值。asOf 是 ISO 时间戳，不做 YYYY-MM-DD 校验。 */
export function navEstimate(value: number, asOf: string, basis: string): NavEstimate {
  return { kind: 'estimate', value, asOf, basis }
}

/** 构造场内成交价。asOf 是 ISO 时间戳，不做 YYYY-MM-DD 校验。 */
export function marketPrice(value: number, asOf: string): MarketPrice {
  return { kind: 'price', value, asOf }
}

/** 窄化判定：是否为确认净值。收益与风险计算的前置守卫。 */
export function isConfirmed(p: AnyPrice): p is NavConfirmed {
  return p.kind === 'nav'
}
