/** 流水类型。现金分红与红利再投对成本、份额的影响完全不同，故分开记（设计 §七）。 */
export type TransactionKind =
  'subscribe' | 'redeem' | 'dividend_cash' | 'dividend_reinvest' | 'split' | 'fee'

/**
 * 流水状态。推导只吃 `confirmed`；`pending` 是数据源拉到、尚待用户确认的
 * 分红/折算（计划 5），它们进持仓会让账静默出错。
 */
export type TransactionStatus = 'confirmed' | 'pending'

/**
 * 一笔账本流水。持仓、成本、份额一律由已确认流水推导，不单独存状态。
 *
 * `amount` 的符号约定是**流向账本为正**：赎回、现金分红、红利再投的金额为正；
 * 申购、费用为负。
 *
 * `sharesDelta` 与 `splitRatio` 量纲不同、互斥使用：前者是份额增减量，
 * 后者是折算**比例**（`1:0.3709` 存 `0.37094933`）。合并成一列会让
 * 实现者把折算当增减量，份额与成本立刻全错（设计 §七）。
 */
export type LedgerTransaction = {
  readonly id: string
  readonly ledgerId: string
  readonly fundCode: string
  /** 业务日期，只许 `YYYY-MM-DD`（§8.2） */
  readonly date: string
  readonly kind: TransactionKind
  /** 份额增减量；`split` 时为 null */
  readonly sharesDelta: number | null
  /** 份额折算比例；非 `split` 时为 null */
  readonly splitRatio: number | null
  /** 流向账本为正，见上 */
  readonly amount: number
  readonly status: TransactionStatus
  readonly note: string | null
}

/**
 * 某只基金在 `asOf` 的持仓推导结果。
 *
 * `cost` / `costPerShare` 为 null 表示**成本未知**（流水中没有买入记录），
 * 此时只能做风险跟踪、不显示个人盈亏——绝不编一个数（§6、设计 §八）。
 */
export type LedgerPosition = {
  readonly fundCode: string
  readonly asOf: string
  readonly shares: number
  /** 总成本；未知时为 null */
  readonly cost: number | null
  /** 单位成本；未知时为 null */
  readonly costPerShare: number | null
  /** 已实现收益（赎回结转 + 现金分红），与浮动盈亏分开 */
  readonly realizedGain: number
}
