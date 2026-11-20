export { normalizeFlows } from './returns/cashflow.ts'
export type { CashFlow } from './returns/cashflow.ts'
export { MultipleRootsError, npv, xirr } from './returns/xirr.ts'
export { timeWeightedReturn } from './returns/twr.ts'
export type { ValuationPoint } from './returns/twr.ts'
export { derivePosition } from './ledger/position.ts'
export { toCashFlows } from './ledger/cashflow.ts'
export type {
  LedgerPosition,
  LedgerTransaction,
  TransactionKind,
  TransactionStatus,
} from './ledger/types.ts'
export { reconcile } from './ledger/reconcile.ts'
export type { ReconcileInput, ReconcileResult } from './ledger/reconcile.ts'
export { dailyReturns } from './risk/series.ts'
export { toAdjustedSeries } from './risk/adjusted.ts'
export type { NavSeriesEvent, NavSeriesRow } from './risk/adjusted.ts'
export { annualizedVolatility, downsideDeviation } from './risk/volatility.ts'
export { currentDrawdown, drawdownRecoveryDays, maxDrawdown } from './risk/drawdown.ts'
export { rollingReturnDistribution } from './risk/rolling.ts'
export type { RollingReturnStats } from './risk/rolling.ts'
export { correlationMatrix } from './risk/correlation.ts'
export type { CorrelationResult } from './risk/correlation.ts'
export { compositeAdjustedSeries } from './risk/portfolio.ts'
