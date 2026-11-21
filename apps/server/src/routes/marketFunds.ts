/**
 * 市场数据路由（与账本无关，设计 §六）：搜基金 / 分类 / 档案 / 净值。
 *
 * 都是「市场本来就有」的数据，路径**不带 `ledgerId`**——用账本去查全市场净值语义不通
 * （设计 §六 2026-11-20 修订）。
 */
import type { FastifyInstance } from 'fastify'
import { assertDate } from '@fundmanager/shared'
import type { FundDataSource } from '@fundmanager/datasource'
import { getNav, type NavRange } from '../services/navService.ts'
import { getFundRisk } from '../services/riskService.ts'
import { getFundDirections } from '../services/fundDirectionService.ts'
import {
  getFundProfile,
  listCategories,
  searchFunds,
  type FundSearchOptions,
} from '../services/fundSearchService.ts'

/** 公募基金代码均为 6 位数字；格式不对在入口拦下，不让上游用「空列表」当成功 */
const FUND_CODE = /^\d{6}$/

/**
 * 校验基金代码。
 *
 * @throws {TypeError} 不是 6 位数字
 */
const assertFundCode = (fundCode: string): string => {
  if (!FUND_CODE.test(fundCode)) {
    throw new TypeError(`基金代码必须是 6 位数字，收到「${fundCode}」`)
  }
  return fundCode
}

/**
 * 解析搜索查询参数。
 *
 * 缺省与上限由 Service 决定（`DEFAULT_LIMIT` / `MAX_LIMIT`），这里只把非数字挡掉：
 * `limit=abc` 若静默变成 0，前端会拿空列表当「没有这只基金」。
 *
 * @throws {TypeError} `limit` 不是非负整数
 */
const parseSearch = (query: unknown): FundSearchOptions => {
  const raw = (query ?? {}) as {
    readonly q?: unknown
    readonly category?: unknown
    readonly limit?: unknown
  }
  let limit: number | undefined
  if (raw.limit !== undefined) {
    limit = Number(raw.limit)
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TypeError(`limit 必须是非负整数，收到「${String(raw.limit)}」`)
    }
  }
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  return { q: text(raw.q), category: text(raw.category), limit }
}

/**
 * 解析净值区间查询参数。
 *
 * @throws {TypeError} 日期不是 `YYYY-MM-DD`，或 `startDate` 晚于 `endDate`
 *
 * @remarks 必须校验日期：数据源只把区间拼进上游 URL，非法格式可能被上游忽略而返回整段历史，
 * 前端会拿到一个「静默超出请求区间」的序列。
 */
const parseRange = (query: unknown): NavRange => {
  const raw = (query ?? {}) as { readonly startDate?: unknown; readonly endDate?: unknown }
  const date = (value: unknown, field: string): string | undefined =>
    value === undefined ? undefined : assertDate(String(value), field)
  const range = {
    startDate: date(raw.startDate, 'startDate'),
    endDate: date(raw.endDate, 'endDate'),
  }
  if (
    range.startDate !== undefined &&
    range.endDate !== undefined &&
    range.startDate > range.endDate
  )
    throw new TypeError('startDate 不能晚于 endDate')
  return range
}

/**
 * 注册市场数据路由。
 *
 * @param deps 装配点传入的数据源；本文件只做参数校验与调 Service，不写算式（§二 规则 1）
 *
 * @remarks **注册顺序有讲究**：静态段 `/api/funds/categories` 必须在参数段
 * `/api/funds/:fundCode` 之前注册——否则 `categories` 会被当成一个基金代码。
 */
export function registerMarketFundRoutes(
  app: FastifyInstance,
  deps: { readonly dataSource: FundDataSource },
): void {
  app.get('/api/funds', async (request) => searchFunds(deps, parseSearch(request.query)))

  // 必须在 `/api/funds/:fundCode` 之前，见上方 @remarks
  app.get('/api/funds/categories', async () => listCategories(deps))

  app.get<{ Params: { fundCode: string } }>('/api/funds/:fundCode/nav', async (request) => {
    return getNav(deps, assertFundCode(request.params.fundCode), parseRange(request.query))
  })

  // 单基金风险是**市场数据**：描述这只基金本身，与是否持有无关，路径不带 ledgerId
  app.get<{ Params: { fundCode: string } }>('/api/funds/:fundCode/risk', async (request) =>
    getFundRisk(deps, assertFundCode(request.params.fundCode)),
  )

  app.get<{ Params: { fundCode: string } }>('/api/funds/:fundCode/directions', async (request) =>
    getFundDirections(deps, assertFundCode(request.params.fundCode)),
  )

  app.get<{ Params: { fundCode: string } }>('/api/funds/:fundCode', async (request) => {
    return getFundProfile(deps, assertFundCode(request.params.fundCode))
  })
}
