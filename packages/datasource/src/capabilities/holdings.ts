/**
 * 能力：持仓（按期）。
 *
 * 主源 `FundArchivesDatas?type=jjcc`，降级到移动端 `fundmobapi/FundMNInverstPosition`。
 *
 * `loss` 有**两种不同成因**，文案必须能区分（本文件的核心）：
 * 1. 主源命中但该期本就非全量（季报前十大、或被 `topline` 截断）——「**这次取到的就是前十大**」；
 * 2. 主源失败、降到移动端接口——「**主源挂了，备源只给前十大**」。
 *
 * 混成一句话会让「是不是降级了」答不上来——`stale` 只管数据旧不旧、不管口径弱不弱。
 * 主源的口径由块尾链接文案判定（`isFullPortfolio`），**不能按报告期类型判**（会高估）。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import type { HoldingPeriod, HoldingRow } from '../endpoints/fundArchives.ts'
import { jjccRequest, parseJjcc } from '../endpoints/fundArchives.ts'
import { inverstPositionRequest, parseInverstPosition } from '../endpoints/fundmobapi.ts'
import type { HttpClient } from '../http/client.ts'
import { DataSourceError } from '../http/errors.ts'

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
      {
        name: 'fundmobapi/FundMNInverstPosition',
        // 与主源的 lossFor 文案必须可区分：这句是「主源挂了」的信号，主源那句是「这次本来就只有前十大」
        loss: '主源 FundArchivesDatas/jjcc 失败，已降级到移动端 FundMNInverstPosition：它只提供前十大持仓（且无持股数、持仓市值），不是该期的真实覆盖',
        run: async () => {
          const { text } = await http.request(inverstPositionRequest(fundCode))
          const pos = parseInverstPosition(text)
          if (pos.stocks.length === 0) {
            // 响应合理但无股票持仓——不当成功（否则与 `jjcc` 空集合一样，会把「解析失败」伪装成「没有持仓」）
            throw new DataSourceError(
              `fundmobapi/FundMNInverstPosition 未返回股票持仓（${fundCode}）：可能该基金不持有股票或代码有误`,
            )
          }
          const period: HoldingPeriod = {
            reportDate: pos.reportDate,
            // 该接口本就只给前十大，永远不是完整持仓
            isFullPortfolio: false,
            holdings: pos.stocks.map(toHoldingRow),
          }
          return { value: period, dataAsOf: pos.reportDate }
        },
      },
    ],
  })
}

/** 该期若非完整持仓，如实记口径损失——非完整有两种来源：季报前十大、被 topline 截断。 */
function coverageLoss(period: HoldingPeriod): string | null {
  return period.isFullPortfolio ? null : '仅前十大持仓：该报告期只披露了前十大重仓股，不是完整持仓'
}

/**
 * 移动端持仓行 → 归一持仓行。
 *
 * `shares` / `marketValue` 该接口**不提供**，一律 `null`（不是 0——0 会被当成「持有零股」）。
 * 该接口另带的个股行业与增减持方向暂不进入 `HoldingRow`（当前契约没有这两列），保留在端点层。
 */
function toHoldingRow(
  row: { stockCode: string; stockName: string; navRatio: number | null },
  index: number,
): HoldingRow {
  return {
    rank: index + 1,
    stockCode: row.stockCode,
    stockName: row.stockName,
    navRatio: row.navRatio,
    shares: null,
    marketValue: null,
  }
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
