/**
 * 能力：财务指标、换手率、全量基金代码表。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import { cwzbRequest, jjhslRequest, parseCwzb, parseJjhsl } from '../endpoints/f10.ts'
import type { FinancialReport, TurnoverRow } from '../endpoints/f10.ts'
import { fundcodeRequest, parseFundCodeList } from '../endpoints/fundcode.ts'
import type { FundCodeEntry } from '../endpoints/fundcode.ts'
import type { HttpClient } from '../http/client.ts'

import { fetchWithFallback } from './fetchWithFallback.ts'
import type { Fetched, TurnoverResult } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const TURNOVER_PAGE_SIZE = 5
/** 换手率每页 5 条、半年度一条，50 页足够覆盖全部历史。 */
const MAX_PAGES = 50

/** 财务指标（列式字典归一后的按报告期行）。**无备源**。 */
export function financials(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
  opts: { year?: number } = {},
): Promise<Fetched<FinancialReport>> {
  const year = opts.year ?? new Date().getFullYear()
  return fetchWithFallback<FinancialReport>({
    key: `financials:${fundCode}:${year}`,
    ttlMs: 30 * DAY_MS,
    cache,
    sources: [
      {
        name: 'f10/GetArrayCwzb',
        run: async () => {
          const { text } = await http.request(cwzbRequest({ fundCode, year }))
          const report = parseCwzb(text)
          return { value: report, dataAsOf: report.periods[0]?.reportDate }
        },
      },
    ],
  })
}

/** 换手率（翻页取全）。**无备源**。只取首页会把历史静默截断成 5 条。 */
export function turnover(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
): Promise<Fetched<TurnoverResult>> {
  return fetchWithFallback<TurnoverResult>({
    key: `turnover:${fundCode}`,
    ttlMs: 30 * DAY_MS,
    cache,
    sources: [
      {
        name: 'f10/JJHSL',
        run: async () => {
          const rows: TurnoverRow[] = []
          for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex++) {
            const { text } = await http.request(
              jjhslRequest({ fundCode, pageIndex, pageSize: TURNOVER_PAGE_SIZE }),
            )
            const page = parseJjhsl(text)
            rows.push(...page.rows)
            const totalPages = Math.ceil(page.totalCount / page.pageSize)
            if (pageIndex >= totalPages || page.rows.length === 0) break
          }
          return { value: { rows }, dataAsOf: rows[0]?.reportDate }
        },
      },
    ],
  })
}

/** 全量基金代码表。**无备源**。无天然时点，`dataAsOf` 取抓取日。 */
export function fundCodes(
  http: HttpClient,
  cache: CacheStore,
): Promise<Fetched<readonly FundCodeEntry[]>> {
  return fetchWithFallback<readonly FundCodeEntry[]>({
    key: 'fundCodes',
    ttlMs: 7 * DAY_MS,
    cache,
    sources: [
      {
        name: 'fundcode_search',
        run: async () => {
          const { text } = await http.request(fundcodeRequest())
          return { value: parseFundCodeList(text) }
        },
      },
    ],
  })
}
