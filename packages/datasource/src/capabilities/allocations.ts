/**
 * 能力：行业配置（基金维度）、资产配置、规模/份额时序。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import type { ScaleShareRow } from '../endpoints/fundArchives.ts'
import { gmbdRequest, parseGmbd } from '../endpoints/fundArchives.ts'
import { hypzRequest, parseHypz } from '../endpoints/f10.ts'
import type { IndustryQuarter } from '../endpoints/f10.ts'
import { parsePingzhongdata, pingzhongdataRequest } from '../endpoints/pingzhongdata.ts'
import type { CategorizedSeries } from '../endpoints/pingzhongdata.ts'
import type { HttpClient } from '../http/client.ts'

import { fetchWithFallback } from './fetchWithFallback.ts'
import type { Fetched, ScaleHistory, ScaleHistoryRow } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 行业配置（基金维度，国民经济行业分类）。
 * **无备源**——移动端只给个股维度（`push2.f127`），口径不同，不可相代。
 */
export function industryAllocation(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
  opts: { year?: number } = {},
): Promise<Fetched<readonly IndustryQuarter[]>> {
  const year = opts.year ?? new Date().getFullYear()
  return fetchWithFallback<readonly IndustryQuarter[]>({
    key: `industry:${fundCode}:${year}`,
    ttlMs: 7 * DAY_MS,
    cache,
    sources: [
      {
        name: 'f10/HYPZ',
        run: async () => {
          const { text } = await http.request(hypzRequest({ fundCode, year }))
          const quarters = parseHypz(text)
          // 响应按报告期降序，取最新一期的报告期作 dataAsOf；无数据年份省略，由内核回退到抓取日
          return { value: quarters, dataAsOf: quarters[0]?.reportDate }
        },
      },
    ],
  })
}

/**
 * 资产配置。**只有 `pingzhongdata` 源**——设计里的主源 `fundmobapi/FundMNAssetAllocationNew`
 * 未接入本层（本计划的端点族不含 fundmobapi）；降级关系实测「数值等价」。
 */
export function assetAllocation(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
): Promise<Fetched<CategorizedSeries>> {
  return fetchWithFallback<CategorizedSeries>({
    key: `assetAllocation:${fundCode}`,
    ttlMs: 7 * DAY_MS,
    cache,
    sources: [
      {
        name: 'pingzhongdata/Data_assetAllocation',
        run: async () => {
          const { text } = await http.request(pingzhongdataRequest(fundCode))
          const data = parsePingzhongdata(text)
          return { value: data.assetAllocation, dataAsOf: data.assetAllocation.categories.at(-1) }
        },
      },
    ],
  })
}

/**
 * 规模/份额时序。主源 `gmbd`（含份额与申赎流量），降级 `pingzhongdata` 规模走势
 * （**只有规模，无份额、无申赎流量**）。
 */
export function scaleHistory(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
): Promise<Fetched<ScaleHistory>> {
  return fetchWithFallback<ScaleHistory>({
    key: `scale:${fundCode}`,
    ttlMs: 7 * DAY_MS,
    cache,
    sources: [
      {
        name: 'FundArchivesDatas/gmbd',
        run: async () => {
          const { text } = await http.request(gmbdRequest({ fundCode }))
          const rows = parseGmbd(text).map(toScaleRow)
          return { value: { fundCode, rows }, dataAsOf: rows[0]?.reportDate }
        },
      },
      {
        name: 'pingzhongdata/Data_fluctuationScale',
        loss: '备源只有规模（期末净资产），无份额、无申赎流量',
        run: async () => {
          const { text } = await http.request(pingzhongdataRequest(fundCode))
          const data = parsePingzhongdata(text)
          // 走势按报告期升序，归一到与 gmbd 一致的降序（最新在前）
          const rows: ScaleHistoryRow[] = [...data.scaleHistory].reverse().map((p) => ({
            reportDate: p.reportDate,
            netAsset: p.netAsset,
            totalShares: null,
            purchase: null,
            redemption: null,
            navChangeRate: null,
          }))
          return { value: { fundCode, rows }, dataAsOf: rows[0]?.reportDate }
        },
      },
    ],
  })
}

/** `gmbd` 的表头列与归一类型同形，逐个字段搬运而不展开，避免顺序错位。 */
function toScaleRow(row: ScaleShareRow): ScaleHistoryRow {
  return {
    reportDate: row.reportDate,
    netAsset: row.netAsset,
    totalShares: row.totalShares,
    purchase: row.purchase,
    redemption: row.redemption,
    navChangeRate: row.navChangeRate,
  }
}
