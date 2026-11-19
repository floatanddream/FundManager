/**
 * 能力：净值历史。三源降级链：
 * 主源 `f10/lsjz`（含分红/拆分事件）→ `pingzhongdata` 的净值走势 → 移动端 `fundmobapi/FundMNHisNetList`。
 *
 * 后两环都**不含分红/拆分事件字段**，故各自在 `loss` 里写明；数值本身等价。
 *
 * **日期区间**：只有主源能在请求里带区间；后两环总是整段返回，故降级后由 `withinRange` 在本地裁剪，
 * 保证三条链拿到的时间窗一致（否则备源会把区间外的行也交出去）。
 * 缓存键**含区间**——否则先取窄区间再取全量会拿到被截断的历史且毫无信号。
 */
import { navConfirmed } from '@fundmanager/shared'

import type { CacheStore } from '../cache/cacheStore.ts'
import { lsjzRequest, parseLsjz } from '../endpoints/f10.ts'
import { hisNetListRequest, parseMobHisNetList } from '../endpoints/fundmobapi.ts'
import { parsePingzhongdata, pingzhongdataRequest } from '../endpoints/pingzhongdata.ts'
import type { HttpClient } from '../http/client.ts'
import { DataSourceError } from '../http/errors.ts'

import { fetchWithFallback } from './fetchWithFallback.ts'
import type { Fetched, NavHistory, NavHistoryRow } from './types.ts'

const TTL_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 20
/**
 * 翻页上限。实测每页 20 条、每年约 250 个交易日，200 页（4000 条）约覆盖 16 年。
 *
 * **只取首页会把「净值历史」静默截断成 20 天**（Review Focus #5）；而历史更长的老基金
 * 会在 200 页处触顶——触顶时**必须报错**，绝不能把缺少头部的历史当全量交出去
 * （波动率、最大回撤、滚动收益全建立在这条序列上）。窄区间查询不受此限。
 */
const MAX_PAGES = 200

/** 日期是否落在 `[startDate, endDate]` 内（两端含）；`YYYY-MM-DD` 按字典序与日历序一致，可直接比较。 */
function withinRange(date: string, startDate?: string, endDate?: string): boolean {
  if (startDate !== undefined && date < startDate) return false
  if (endDate !== undefined && date > endDate) return false
  return true
}

export function navHistory(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<Fetched<NavHistory>> {
  return fetchWithFallback<NavHistory>({
    // 区间**必须**进键：否则先取窄区间、再在同 TTL 内取全量会命中前者，静默拿到被截断的历史
    key: `nav:${fundCode}:${opts.startDate ?? ''}:${opts.endDate ?? ''}`,
    ttlMs: TTL_MS,
    cache,
    sources: [
      {
        name: 'f10/lsjz',
        run: async () => {
          const rows: NavHistoryRow[] = []
          // 只在「取到最后一页」时才可能为真；触顶 MAX_PAGES 或中途遇到空页退出时保持 false
          let complete = false
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
            // 空页但还没到 totalPages：上游声明的总量没取够，同样不可当全量
            if (pageIndex >= totalPages) {
              complete = true
              break
            }
            if (page.rows.length === 0) break
          }
          // 触顶退出时历史被截断（老基金约 5900 条 > 4000）。截断的序列会让波动率、
          // 最大回撤、滚动收益全部建立在缺了头部的历史上，而返回值看不出任何异常——
          // 故**抛错，让降级链换到能给全量的来源**（pingzhongdata 不分页），
          // 而不是带着 `loss` 把半截数据往下交
          if (!complete) {
            throw new DataSourceError(
              `f10/lsjz 净值历史超过 ${MAX_PAGES * PAGE_SIZE} 条，已达分页上限（${fundCode}）：` +
                `继续取会静默截断历史。请缩小日期区间（startDate/endDate）后重试`,
            )
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
          // pingzhongdata 走势按升序，归一到与 lsjz 一致的降序（最新在前）；
          // 本端点不认日期区间（总是整段返回），故在本地裁剪到调用方要的区间
          const rows: NavHistoryRow[] = data.navTrend
            .map((p) => ({
              nav: navConfirmed(p.nav, p.date),
              accNav: accByDate.get(p.date) ?? null,
              growthRate: p.equityReturn,
              event: null,
            }))
            .reverse()
            .filter((row) => withinRange(row.nav.date, opts.startDate, opts.endDate))
          if (rows.length === 0)
            throw new DataSourceError(`pingzhongdata 无符合请求区间的净值（${fundCode}）`)
          return { value: { fundCode, rows }, dataAsOf: rows[0]!.nav.date }
        },
      },
      {
        name: 'fundmobapi/FundMNHisNetList',
        loss: '净值数值等价，但丢失分红/拆分事件字段（来自 fundmobapi/FundMNHisNetList）',
        run: async () => {
          // 同样翻页取全——本端点分页，只取首页会把历史静默截断（Review Focus #5）。
          // 本端点同样不认日期区间，故一并按区间裁剪
          const rows: NavHistoryRow[] = []
          // 与主源同义：只有取到 totalPages 声明的最后一页才算全量（见主源处注释）
          let complete = false
          for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex++) {
            const { text } = await http.request(
              hisNetListRequest({ fundCode, pageIndex, pageSize: PAGE_SIZE }),
            )
            const page = parseMobHisNetList(text)
            for (const row of page.rows) {
              if (row.nav !== null && withinRange(row.date, opts.startDate, opts.endDate)) {
                rows.push({
                  nav: navConfirmed(row.nav, row.date),
                  accNav: row.accNav,
                  growthRate: row.growthRate,
                  // 本端点无分红/拆分字段
                  event: null,
                })
              }
            }
            const totalPages = Math.ceil(page.totalCount / PAGE_SIZE)
            if (pageIndex >= totalPages) {
              complete = true
              break
            }
            if (page.rows.length === 0) break
          }
          // 本端点是降级链的最后一环，抛错即全链失败——但这仍好过把被截断的历史当全量交出去
          if (!complete) {
            throw new DataSourceError(
              `fundmobapi/FundMNHisNetList 净值历史超过 ${MAX_PAGES * PAGE_SIZE} 条，已达分页上限（${fundCode}）：` +
                `继续取会静默截断历史。请缩小日期区间（startDate/endDate）后重试`,
            )
          }
          if (rows.length === 0) {
            throw new DataSourceError(
              `fundmobapi/FundMNHisNetList 无符合请求区间的净值（${fundCode}）：基金代码可能不存在或打错`,
            )
          }
          return { value: { fundCode, rows }, dataAsOf: rows[0]!.nav.date }
        },
      },
    ],
  })
}
