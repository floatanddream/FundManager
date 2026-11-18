/**
 * 能力：持仓（按期）。
 *
 * 主源 `FundArchivesDatas?type=jjcc`。设计里的备源 `fundmobapi/FundMNInverstPosition`
 * **未接入本层**（本计划的端点族不含 fundmobapi），故目前是单源。
 *
 * `loss` 不是由降级产生的，而是**由数据本身的口径**决定的：`jjcc` 的季报块只披露前十大，
 * 半年报/年报块也可能被 `topline` 截断。是否完整由块尾链接文案判定（`isFullPortfolio`），
 * **不能按报告期类型判**（会高估）。这条直接决定 Review Focus #4——别让用户以为看到了全部。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import type { HoldingPeriod } from '../endpoints/fundArchives.ts'
import { jjccRequest, parseJjcc } from '../endpoints/fundArchives.ts'
import type { HttpClient } from '../http/client.ts'

import { fetchWithFallback } from './fetchWithFallback.ts'
import type { Fetched } from './types.ts'

const TTL_MS = 24 * 60 * 60 * 1000

export function holdings(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
  opts: { year?: number; month?: number } = {},
): Promise<Fetched<HoldingPeriod>> {
  const year = opts.year ?? new Date().getFullYear()
  const month = opts.month
  return fetchWithFallback<HoldingPeriod>({
    key: `holdings:${fundCode}:${year}:${month ?? ''}`,
    ttlMs: TTL_MS,
    cache,
    lossFor: coverageLoss,
    sources: [
      {
        name: 'FundArchivesDatas/jjcc',
        run: async () => {
          const { text } = await http.request(jjccRequest({ fundCode, year, month }))
          const period = selectPeriod(parseJjcc(text), month)
          return { value: period, dataAsOf: period.reportDate }
        },
      },
    ],
  })
}

/** 该期若非完整持仓，如实记口径损失——非完整有两种来源：季报前十大、被 topline 截断。 */
function coverageLoss(period: HoldingPeriod): string | null {
  return period.isFullPortfolio ? null : '仅前十大持仓：该报告期只披露了前十大重仓股，不是完整持仓'
}

/** 给 `month` 则取命中的那一期；否则取报告期最新的一期。 */
function selectPeriod(periods: readonly HoldingPeriod[], month: number | undefined): HoldingPeriod {
  if (month !== undefined) {
    const needle = `-${String(month).padStart(2, '0')}-`
    const matched = periods.find((p) => p.reportDate.includes(needle))
    if (matched !== undefined) return matched
  }
  return [...periods].sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0]!
}
