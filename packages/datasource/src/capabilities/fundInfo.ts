/**
 * 能力：基金概况（`profile`）、分红折算（`dividends`）、公告（`announcements`）。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import {
  fhggRequest,
  jjggRequest,
  lsjzRequest,
  parseFhgg,
  parseJjgg,
  parseLsjz,
} from '../endpoints/f10.ts'
import type { AnnouncementPage, NavRow } from '../endpoints/f10.ts'
import { fhspRequest, jbgkRequest, parseFhsp, parseJbgk } from '../endpoints/htmlPages.ts'
import type {
  DividendRecord,
  DividendSplitPage,
  FundProfilePage,
  SplitRecord,
} from '../endpoints/htmlPages.ts'
import type { HttpClient } from '../http/client.ts'

import { fetchWithFallback } from './fetchWithFallback.ts'
import type { Fetched } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 基金概况。**无备源**——移动端 `FundMNBasicInformation`/`FundMNDetailInformation`
 * 实测都不含「业绩比较基准 / 跟踪标的」这两项。
 */
export function profile(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
): Promise<Fetched<FundProfilePage>> {
  return fetchWithFallback({
    key: `profile:${fundCode}`,
    ttlMs: 7 * DAY_MS,
    cache,
    sources: [
      {
        name: 'jbgk',
        // 概况无天然时点，dataAsOf 交给内核取抓取日
        run: async () => {
          const { text } = await http.request(jbgkRequest(fundCode))
          return { value: parseJbgk(text) }
        },
      },
    ],
  })
}

/**
 * 分红 + 份额折算。主源 `fhsp` HTML（两张表，字段齐全），
 * 降级 `f10/lsjz` 的分红/折算字段——JSON 版缺权益登记日与发放日。
 */
export function dividends(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
): Promise<Fetched<DividendSplitPage>> {
  return fetchWithFallback<DividendSplitPage>({
    key: `dividends:${fundCode}`,
    ttlMs: DAY_MS,
    cache,
    sources: [
      {
        name: 'fhsp',
        run: async () => {
          const { text } = await http.request(fhspRequest(fundCode))
          const page = parseFhsp(text)
          return { value: page, dataAsOf: latestEventDate(page) }
        },
      },
      {
        name: 'f10/lsjz',
        loss: 'JSON 版缺权益登记日与发放日（来自 lsjz 分红/折算字段）',
        run: async () => {
          // lsjz 分页，降级只需近段事件，取一页即可；loss 已声明日期的缺失
          const { text } = await http.request(lsjzRequest({ fundCode, pageIndex: 1, pageSize: 50 }))
          const page = parseLsjz(text)
          const value = eventsToDividendSplit(page.rows)
          return { value, dataAsOf: latestEventDate(value) }
        },
      },
    ],
  })
}

/** 公告。主源 `f10/JJGG`（全部），降级 `f10/FHGG`（只有分红公告）。 */
export function announcements(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
  opts: { pageSize?: number } = {},
): Promise<Fetched<AnnouncementPage>> {
  const pageSize = opts.pageSize ?? 20
  return fetchWithFallback({
    key: `announcements:${fundCode}:${pageSize}`,
    ttlMs: DAY_MS,
    cache,
    sources: [
      {
        name: 'f10/JJGG',
        run: async () => {
          const { text } = await http.request(jjggRequest({ fundCode, pageIndex: 1, pageSize }))
          const page = parseJjgg(text)
          return { value: page, dataAsOf: page.items[0]?.publishDate }
        },
      },
      {
        name: 'f10/FHGG',
        loss: '备源只有分红公告，缺少其余公告类型',
        run: async () => {
          const { text } = await http.request(fhggRequest({ fundCode, pageIndex: 1, pageSize }))
          const page = parseFhgg(text)
          return { value: page, dataAsOf: page.items[0]?.publishDate }
        },
      },
    ],
  })
}

/** 分红折算页里最近的一个事件日；没有任何事件时省略（由内核回退到抓取日）。 */
function latestEventDate(page: DividendSplitPage): string | undefined {
  const dates: string[] = []
  for (const d of page.dividends) {
    for (const date of [d.recordDate, d.exDate, d.payDate]) if (date !== null) dates.push(date)
  }
  for (const s of page.splits) if (s.splitDate !== null) dates.push(s.splitDate)
  return dates.sort().at(-1)
}

/**
 * 把 lsjz 净流行上的事件转成 `DividendSplitPage` 形状。
 *
 * `kind` 为 `'unknown'` 的事件（`FHFCBZ` 取值未穷举）**跳过**——不猜它是分红还是拆分，
 * 猜错就是把折算当分红记。loss 已声明本源的字段缺失。
 */
function eventsToDividendSplit(rows: readonly NavRow[]): DividendSplitPage {
  const dividends: DividendRecord[] = []
  const splits: SplitRecord[] = []
  for (const row of rows) {
    const event = row.event
    if (event === null || event.kind === 'unknown') continue
    const year = Number(row.date.slice(0, 4))
    if (event.kind === 'dividend') {
      dividends.push({
        year,
        recordDate: null,
        exDate: row.date,
        per10Units: event.per10Unit ?? (event.perUnit !== null ? event.perUnit * 10 : 0),
        payDate: null,
      })
    } else {
      splits.push({
        year,
        splitDate: row.date,
        kind: event.description || '份额折算',
        ratio: { from: 1, to: event.perUnit ?? 0 },
      })
    }
  }
  return { dividends, splits }
}
