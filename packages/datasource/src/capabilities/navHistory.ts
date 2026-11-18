/**
 * 能力：净值历史。主源 `f10/lsjz`（含分红/拆分事件），降级 `pingzhongdata` 的净值走势。
 */
import { navConfirmed } from '@fundmanager/shared'

import type { CacheStore } from '../cache/cacheStore.ts'
import { lsjzRequest, parseLsjz } from '../endpoints/f10.ts'
import { parsePingzhongdata, pingzhongdataRequest } from '../endpoints/pingzhongdata.ts'
import type { HttpClient } from '../http/client.ts'
import { DataSourceError } from '../http/errors.ts'

import { fetchWithFallback } from './fetchWithFallback.ts'
import type { Fetched, NavHistory, NavHistoryRow } from './types.ts'

const TTL_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 20
/**
 * 翻页上限。实测每页 20 条、每年约 250 个交易日，200 页足够覆盖 10 年——
 * **只取首页会把「净值历史」静默截断成 20 天**（Review Focus #5）。
 */
const MAX_PAGES = 200

export function navHistory(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<Fetched<NavHistory>> {
  return fetchWithFallback<NavHistory>({
    key: `nav:${fundCode}`,
    ttlMs: TTL_MS,
    cache,
    sources: [
      {
        name: 'f10/lsjz',
        run: async () => {
          const rows: NavHistoryRow[] = []
          for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex++) {
            const { text } = await http.request(
              lsjzRequest({
                fundCode,
                pageIndex,
                pageSize: PAGE_SIZE,
                startDate: opts.startDate,
                endDate: opts.endDate,
              }),
            )
            const page = parseLsjz(text)
            for (const row of page.rows) {
              // 净值缺失的行构不成 NavConfirmed；跳过它（无值行不是错，但也不许造出脏值）
              if (row.nav !== null) {
                rows.push({
                  nav: navConfirmed(row.nav, row.date),
                  accNav: row.accNav,
                  growthRate: row.growthRate,
                  event: row.event,
                })
              }
            }
            const totalPages = Math.ceil(page.totalCount / page.pageSize)
            if (pageIndex >= totalPages || page.rows.length === 0) break
          }
          // 空列表不是「该基金没有净值」，而是「代码不存在/打错」——接口对两者都给空数组，不得当成功
          if (rows.length === 0) {
            throw new DataSourceError(
              `f10/lsjz 返回空净值列表（${fundCode}）：基金代码可能不存在或打错`,
            )
          }
          return { value: { fundCode, rows }, dataAsOf: rows[0]!.nav.date }
        },
      },
      {
        name: 'pingzhongdata/Data_netWorthTrend',
        loss: '净值数值等价，但丢失分红/拆分事件字段（来自 pingzhongdata 走势）',
        run: async () => {
          const { text } = await http.request(pingzhongdataRequest(fundCode))
          const data = parsePingzhongdata(text)
          const accByDate = new Map(data.accNavTrend.map((p) => [p.date, p.accNav]))
          // pingzhongdata 走势按升序，归一到与 lsjz 一致的降序（最新在前）
          const rows: NavHistoryRow[] = data.navTrend
            .map((p) => ({
              nav: navConfirmed(p.nav, p.date),
              accNav: accByDate.get(p.date) ?? null,
              growthRate: p.equityReturn,
              event: null,
            }))
            .reverse()
          if (rows.length === 0)
            throw new DataSourceError(`pingzhongdata 净值走势为空（${fundCode}）`)
          return { value: { fundCode, rows }, dataAsOf: rows[0]!.nav.date }
        },
      },
    ],
  })
}
