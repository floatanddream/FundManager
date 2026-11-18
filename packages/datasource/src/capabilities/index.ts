/**
 * 能力层的**唯一装配点**（设计 §1 的缝）。
 *
 * 上层只见 `FundDataSource` 接口，不感知具体端点；换源只改这里（把某个方法换成别的实现）。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import type { HttpClient } from '../http/client.ts'

import { assetAllocation, industryAllocation, scaleHistory } from './allocations.ts'
import { financials, fundCodes, turnover } from './financials.ts'
import { announcements, dividends, profile } from './fundInfo.ts'
import { holdings } from './holdings.ts'
import { dailyKline, quotes, sectorMembers, stockIndustry } from './market.ts'
import { navHistory } from './navHistory.ts'
import type { FundDataSource } from './types.ts'

/**
 * 用给定的 HTTP 内核与缓存装配一个数据源。
 *
 * @param deps `http` 是共享内核（含限流/退避/解码），`cache` 是 `CacheStore`（现在内存实现）
 */
export function createFundDataSource(deps: {
  http: HttpClient
  cache: CacheStore
}): FundDataSource {
  const { http, cache } = deps
  return {
    navHistory: (fundCode, opts) => navHistory(http, cache, fundCode, opts),
    profile: (fundCode) => profile(http, cache, fundCode),
    holdings: (fundCode, opts) => holdings(http, cache, fundCode, opts),
    industryAllocation: (fundCode, opts) => industryAllocation(http, cache, fundCode, opts),
    assetAllocation: (fundCode) => assetAllocation(http, cache, fundCode),
    scaleHistory: (fundCode) => scaleHistory(http, cache, fundCode),
    dividends: (fundCode) => dividends(http, cache, fundCode),
    announcements: (fundCode, opts) => announcements(http, cache, fundCode, opts),
    financials: (fundCode, opts) => financials(http, cache, fundCode, opts),
    turnover: (fundCode) => turnover(http, cache, fundCode),
    fundCodes: () => fundCodes(http, cache),
    quotes: (symbols) => quotes(http, symbols),
    dailyKline: (query) => dailyKline(http, query),
    stockIndustry: (stockCode) => stockIndustry(http, cache, stockCode),
    sectorMembers: (fs, opts) => sectorMembers(http, cache, fs, opts),
  }
}
