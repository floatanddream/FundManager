/**
 * 能力：行业配置（基金维度）、资产配置、规模/份额时序。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import type { ScaleShareRow } from '../endpoints/fundArchives.ts'
import { gmbdRequest, parseGmbd } from '../endpoints/fundArchives.ts'
import { hypzRequest, parseHypz } from '../endpoints/f10.ts'
import type { IndustryQuarter } from '../endpoints/f10.ts'
import type { MobAssetAllocationRow } from '../endpoints/fundmobapi.ts'
import { assetAllocationRequest, parseMobAssetAllocation } from '../endpoints/fundmobapi.ts'
import { parsePingzhongdata, pingzhongdataRequest } from '../endpoints/pingzhongdata.ts'
import type { CategorizedSeries } from '../endpoints/pingzhongdata.ts'
import type { HttpClient } from '../http/client.ts'
import { DataSourceError } from '../http/errors.ts'

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
 * 资产配置。主源移动端 `fundmobapi/FundMNAssetAllocationNew`（结构化 JSON、带明确报告期），
 * 降级 `pingzhongdata.Data_assetAllocation`。
 *
 * 两处**不完全等价**，虽设计记为「等价」，但那是就股票/债券/现金三项数值而言：
 * - 主源多一个「其他」占比（备源没有）→ 记进 `loss`；
 * - 主源实测**只返回最新一个报告期**，备源给多期历史——这反而意味着降级到备源会拿到更多期。
 *
 * 备源还有个更深的坑（不在本任务处理）：`pingzhongdata.Data_assetAllocation` 的内容**随基金类型变**
 * ——货币基金处它装的是「期间申购/期间赎回/总份额」，不是资产占比。此时主源通常可用（不会降级），
 * 故暂不特殊处理，但排障时要记得这一点。
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
        name: 'fundmobapi/FundMNAssetAllocationNew',
        run: async () => {
          const { text } = await http.request(assetAllocationRequest(fundCode))
          const rows = parseMobAssetAllocation(text)
          if (rows.length === 0) {
            // 空不是「没有资产配置」，而是取数失败——否则会盖过备源、又给不出数据
            throw new DataSourceError(
              `fundmobapi/FundMNAssetAllocationNew 返回空资产配置（${fundCode}）`,
            )
          }
          return { value: toAssetAllocationSeries(rows), dataAsOf: rows[0]!.reportDate }
        },
      },
      {
        name: 'pingzhongdata/Data_assetAllocation',
        loss: '备源无「其他」占比（其他类资产）',
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
 * 移动端资产配置行 → `CategorizedSeries`（与备源同一套系列名，便于上层换源不改）。
 *
 * 占比为 `--`（接口的无值占位）时取 `0`——对占比而言「无此值」就是「不持有该类资产」；
 * `净资产` 为 `null` 则抛，净资产没有「0」这个合理读法，宁可降级也不给错值。
 */
function toAssetAllocationSeries(rows: readonly MobAssetAllocationRow[]): CategorizedSeries {
  for (const row of rows) {
    if (row.netAsset === null) {
      throw new DataSourceError(
        `fundmobapi/FundMNAssetAllocationNew ${row.reportDate} 的净资产为空，数据不完整`,
      )
    }
  }
  const ratio = (value: number | null): number => value ?? 0
  return {
    categories: rows.map((r) => r.reportDate),
    series: [
      { name: '股票占净比', data: rows.map((r) => ratio(r.stockRatio)) },
      { name: '债券占净比', data: rows.map((r) => ratio(r.bondRatio)) },
      { name: '现金占净比', data: rows.map((r) => ratio(r.cashRatio)) },
      { name: '其他占净比', data: rows.map((r) => ratio(r.otherRatio)) },
      { name: '净资产', data: rows.map((r) => r.netAsset!) },
    ],
  }
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
