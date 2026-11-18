/**
 * 能力：实时行情、日 K 线、个股行业分类、板块成分股。
 *
 * 行情与 K 线**不缓存**（`noCache`）——它们天然带时点，缓存只会给出陈旧值。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import { fqklineRequest, parseFqkline, parseQt, qtRequest } from '../endpoints/gtimg.ts'
import type { DailyKline, FqklineQuery, Quote } from '../endpoints/gtimg.ts'
import {
  clistRequest,
  parseSectorMembers,
  parseStockIndustry,
  stockRequest,
} from '../endpoints/push2.ts'
import type { SectorMember, SectorMembers, StockIndustry } from '../endpoints/push2.ts'
import type { HttpClient } from '../http/client.ts'
import { DataSourceError } from '../http/errors.ts'

import { fetchWithFallback } from './fetchWithFallback.ts'
import type { Fetched } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const SECTOR_PAGE_SIZE = 100
/** 板块成分翻页上限；`total` 已回传，正常不会触顶。 */
const MAX_PAGES = 100

/**
 * 实时行情。接口对不存在的代码**静默省略**、全部不匹配时只回 `pv_none_match`——
 * 空结果不得当成功，否则用户输错代码看到一片空白却以为一切正常（反目标 A3）。
 */
export function quotes(
  http: HttpClient,
  symbols: readonly string[],
): Promise<Fetched<readonly Quote[]>> {
  return fetchWithFallback<readonly Quote[]>({
    key: `quotes:${symbols.join(',')}`,
    ttlMs: 0,
    noCache: true,
    sources: [
      {
        name: 'qt',
        run: async () => {
          const { text } = await http.request(qtRequest(symbols))
          const list = parseQt(text)
          if (list.length === 0) {
            throw new DataSourceError(
              `qt 无任何行情返回（${symbols.join(',')}）：代码可能不存在或打错`,
            )
          }
          const latest = list
            .map((q) => q.timestamp.date)
            .sort()
            .at(-1)!
          return { value: list, dataAsOf: latest }
        },
      },
    ],
  })
}

/** 日 K 线。代码不存在与「区间内无数据」在响应里分不开，空 K 线一律当失败如实抛出。 */
export function dailyKline(http: HttpClient, query: FqklineQuery): Promise<Fetched<DailyKline>> {
  return fetchWithFallback<DailyKline>({
    key: `kline:${query.symbol}:${query.period ?? 'day'}:${query.adjust ?? 'qfq'}`,
    ttlMs: 0,
    noCache: true,
    sources: [
      {
        name: 'fqkline',
        run: async () => {
          const { text } = await http.request(fqklineRequest(query))
          const list = parseFqkline(text)
          const kline = list.find((k) => k.symbol === query.symbol) ?? list[0]
          if (kline === undefined || kline.bars.length === 0) {
            throw new DataSourceError(
              `fqkline 无 K 线数据（${query.symbol}）：代码不存在或区间内无交易日`,
            )
          }
          return { value: kline, dataAsOf: kline.bars.at(-1)!.date }
        },
      },
    ],
  })
}

/**
 * 个股行业分类（细分行业 `f127`）。沪市首位的 `6` 取市场号 `1.`，其余取 `0.`（深/创/北）。
 * 无天然时点，`dataAsOf` 取抓取日。
 */
export function stockIndustry(
  http: HttpClient,
  cache: CacheStore,
  stockCode: string,
): Promise<Fetched<StockIndustry | null>> {
  return fetchWithFallback<StockIndustry | null>({
    key: `stockIndustry:${stockCode}`,
    ttlMs: 30 * DAY_MS,
    cache,
    sources: [
      {
        name: 'push2/stock/get',
        run: async () => {
          const { text } = await http.request(stockRequest(secidOf(stockCode)))
          return { value: parseStockIndustry(text) }
        },
      },
    ],
  })
}

/** 板块成分股（翻页取全）。`value` 为 `null` 表示该板块查无成分（接口 `data:null`）。 */
export function sectorMembers(
  http: HttpClient,
  cache: CacheStore,
  fs: string,
  opts: { pageSize?: number } = {},
): Promise<Fetched<SectorMembers | null>> {
  const pz = opts.pageSize ?? SECTOR_PAGE_SIZE
  return fetchWithFallback<SectorMembers | null>({
    key: `sectorMembers:${fs}:${pz}`,
    ttlMs: DAY_MS,
    cache,
    sources: [
      {
        name: 'push2/clist/get',
        run: async () => {
          const members: SectorMember[] = []
          let total = 0
          for (let pn = 1; pn <= MAX_PAGES; pn++) {
            const { text } = await http.request(clistRequest({ fs, pn, pz }))
            const page = parseSectorMembers(text)
            if (page === null) return { value: null } // 板块查无成分是数据缺失，不是失败
            total = page.total
            members.push(...page.members)
            if (members.length >= total || page.members.length === 0) break
          }
          return { value: { total, members } }
        },
      },
    ],
  })
}

/** 市场号 + 代码：`6` 开头（沪市）取 `1.`，其余取 `0.`。取错会返回别的股票或空。 */
function secidOf(stockCode: string): string {
  return `${stockCode.startsWith('6') ? '1' : '0'}.${stockCode}`
}
