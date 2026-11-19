import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { MemoryCacheStore } from '../cache/memoryCache.ts'
import { HttpClient } from '../http/client.ts'
import { DataSourceError } from '../http/errors.ts'
import { createFundDataSource } from './index.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')

/** 无视 URL、固定回同一个响应体；maxRetries=0 使失败不重试 */
const httpReturning = (body: string): HttpClient =>
  new HttpClient({ fetch: async () => new Response(body), minIntervalMs: 0, maxRetries: 0 })

const dataSource = (http: HttpClient) =>
  createFundDataSource({ http, cache: new MemoryCacheStore() })

/** 按 URL 关键字路由到响应体；未匹配的 URL 一律 404（模拟该源不可用） */
const httpRouting = (routes: readonly (readonly [string, string])[]): HttpClient =>
  new HttpClient({
    minIntervalMs: 0,
    maxRetries: 0,
    fetch: async (url) => {
      const hit = routes.find(([key]) => String(url).includes(key))
      return hit === undefined ? new Response('nope', { status: 404 }) : new Response(hit[1])
    },
  })

/** 实测缺 Referer 的失败响应：HTTP 200 + ErrCode:-999 */
const noReferer = JSON.stringify({ ErrCode: -999, ErrMsg: '', Data: '' })

/** 一页移动端历史净值（FundMNHisNetList） */
const hisnetRow = (date: string, nav: number, accNav: number, growthRate: number) => ({
  FSRQ: date,
  DWJZ: String(nav),
  LJJZ: String(accNav),
  JZZZL: String(growthRate),
})
const hisnetPage = (rows: readonly unknown[], totalCount: number): string =>
  JSON.stringify({ ErrCode: 0, Success: true, Datas: rows, TotalCount: totalCount })

/** 一行/一页 lsjz 的构造助手（测试名与断言用中文，造数据用助手） */
const lsjzRow = (date: string, nav: number) => ({
  FSRQ: date,
  DWJZ: String(nav),
  LJJZ: String(nav),
  JZZZL: '0',
  FHFCZ: null,
  FHFCZ10: null,
  FHFCBZ: null,
  FHSP: '',
})
const lsjzPage = (rows: unknown[], totalCount: number, pageIndex: number) =>
  JSON.stringify({
    ErrCode: 0,
    ErrMsg: null,
    Data: { LSJZList: rows },
    TotalCount: totalCount,
    PageSize: 2,
    PageIndex: pageIndex,
  })

it('navHistory：翻页取全，不只取首页', async () => {
  const pages = [
    lsjzPage([lsjzRow('2026-11-17', 1.1), lsjzRow('2026-11-14', 1.2)], 4, 1),
    lsjzPage([lsjzRow('2026-11-13', 1.3), lsjzRow('2026-11-12', 1.4)], 4, 2),
  ]
  const http = new HttpClient({
    minIntervalMs: 0,
    maxRetries: 0,
    fetch: async (url) =>
      new Response(pages[Number(new URL(String(url)).searchParams.get('pageIndex')) - 1]!),
  })
  const r = await dataSource(http).navHistory('000001')
  expect(r.source).toBe('f10/lsjz')
  expect(r.value.rows.map((row) => row.nav.date)).toEqual([
    '2026-11-17',
    '2026-11-14',
    '2026-11-13',
    '2026-11-12',
  ])
  expect(r.dataAsOf).toBe('2026-11-17')
})

it('navHistory：lsjz 返回空列表（代码打错）视为失败，不当成成功取数', async () => {
  const empty = lsjzPage([], 0, 1)
  await expect(dataSource(httpReturning(empty)).navHistory('999999')).rejects.toThrow(
    DataSourceError,
  )
})

it('navHistory：不同日期区间不共用缓存条目（窄区间不会截断随后的全量）', async () => {
  // 模拟 f10/lsjz：按 startDate 过滤 + 按 pageIndex 分页（每页 2 条）
  const all = ['2026-11-17', '2026-11-14', '2026-11-13', '2026-11-12'].map((d) => lsjzRow(d, 1))
  const http = new HttpClient({
    minIntervalMs: 0,
    maxRetries: 0,
    fetch: async (url) => {
      const u = new URL(String(url))
      const start = u.searchParams.get('startDate')
      const rows = all.filter((r) => start === null || r.FSRQ >= start)
      const pageIndex = Number(u.searchParams.get('pageIndex'))
      return new Response(
        lsjzPage(rows.slice((pageIndex - 1) * 2, pageIndex * 2), rows.length, pageIndex),
      )
    },
  })
  const ds = createFundDataSource({ http, cache: new MemoryCacheStore() }) // 共享缓存
  const ranged = await ds.navHistory('000001', { startDate: '2026-11-14' })
  expect(ranged.value.rows.map((row) => row.nav.date)).toEqual(['2026-11-17', '2026-11-14'])
  // 同 TTL 内再取全量：必须重新取数拿到全部，而不是命中上面那条被截断的缓存
  const full = await ds.navHistory('000001')
  expect(full.value.rows.map((row) => row.nav.date)).toEqual([
    '2026-11-17',
    '2026-11-14',
    '2026-11-13',
    '2026-11-12',
  ])
})

it('navHistory：降级到备源（pingzhongdata）时也按请求区间裁剪', async () => {
  const routes = (): HttpClient =>
    httpRouting([
      ['f10/lsjz', noReferer],
      ['pingzhongdata', fixture('pingzhongdata/000001.js')],
    ])
  const ranged = await dataSource(routes()).navHistory('000001', {
    startDate: '2026-11-10',
    endDate: '2026-11-17',
  })
  const full = await dataSource(routes()).navHistory('000001')
  expect(ranged.source).toBe('pingzhongdata/Data_netWorthTrend')
  expect(ranged.value.rows.length).toBeGreaterThan(0)
  expect(ranged.value.rows.length).toBeLessThan(full.value.rows.length)
  expect(
    ranged.value.rows.every((row) => row.nav.date >= '2026-11-10' && row.nav.date <= '2026-11-17'),
  ).toBe(true)
})

it('holdings：仅前十大时在 loss 里如实说明，month 命中全量块时无损失', async () => {
  const ds = dataSource(httpReturning(fixture('jjcc/000001-2026.html')))
  const latest = await ds.holdings('000001', { year: 2026 })
  expect(latest.loss).toContain('前十大')
  const full = await ds.holdings('000001', { year: 2026, month: 6 })
  expect(full.loss).toBeNull()
  expect(full.value.isFullPortfolio).toBe(true)
})

it('navHistory：前两源都失败时降级到 fundmobapi，仍标出丢失分红字段', async () => {
  const http = httpRouting([
    ['f10/lsjz', noReferer],
    ['pingzhongdata', 'var broken = 1;'],
    ['FundMNHisNetList', hisnetPage([hisnetRow('2026-11-17', 0.951, 3.524, 0.74)], 1)],
  ])
  const r = await dataSource(http).navHistory('000001')
  expect(r.source).toBe('fundmobapi/FundMNHisNetList')
  expect(r.loss).toContain('分红')
  expect(r.value.rows[0]!.nav).toEqual({ kind: 'nav', value: 0.951, date: '2026-11-17' })
})

it('holdings：未指定年份/月份（要最新）时主源失败可降级到移动端，loss 与「本次仅前十大」可区分', async () => {
  const http = httpRouting([['FundMNInverstPosition', fixture('fundmobapi_position/000001.json')]])
  // 没给 year/month：「给我最新的」——备源返回最新一期正是所要，降级合法
  const r = await dataSource(http).holdings('000001')
  expect(r.source).toBe('fundmobapi/FundMNInverstPosition')
  expect(r.loss).toContain('降级')
  expect(r.value.reportDate).toBe('2026-09-30')
  expect(r.value.holdings[0]).toMatchObject({
    rank: 1,
    stockCode: '300308',
    navRatio: 5.26,
    shares: null,
    marketValue: null,
  })
})

it('holdings：显式指定年份且主源失败时抛错，绝不返回备源的最新一期', async () => {
  // 备源可用并返回它自己的最新一期 2026-09-30——正是「要 2020，给你 2026」的来源，必须拦住
  const http = httpRouting([
    ['year=2020', jjccEmptyYear],
    ['FundMNInverstPosition', fixture('fundmobapi_position/000001.json')],
  ])
  const error = await dataSource(http)
    .holdings('000001', { year: 2020 })
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(DataSourceError)
  expect(String(error)).toMatch(/不提供指定年份.*2020.*错误年份/) // 说清不认年份、不能顶替
  expect(String(error)).not.toContain('2026-09-30') // 备源的期绝不进入结果
})

it('assetAllocation：主源为移动端；降级到 pingzhongdata 时标出无「其他」占比', async () => {
  const main = await dataSource(
    httpRouting([['FundMNAssetAllocationNew', fixture('fundmobapi_assetallocation/000001.json')]]),
  ).assetAllocation('000001')
  expect(main.source).toBe('fundmobapi/FundMNAssetAllocationNew')
  expect(main.value.categories).toEqual(['2026-09-30'])
  expect(main.value.series.map((s) => s.name)).toEqual([
    '股票占净比',
    '债券占净比',
    '现金占净比',
    '其他占净比',
    '净资产',
  ])
  expect(main.value.series[0]!.data).toEqual([78.21])
  expect(main.loss).toContain('一个报告期') // 主源只有 1 个报告期，覆盖变小须如实记 loss

  const backup = await dataSource(
    httpRouting([['pingzhongdata', fixture('pingzhongdata/000001.js')]]),
  ).assetAllocation('000001')
  expect(backup.source).toBe('pingzhongdata/Data_assetAllocation')
  expect(backup.loss).toContain('其他')
})

it('assetAllocation：货币基金的 pingzhongdata 备源装的是份额流量，拒用并抛出可自解释错误', async () => {
  // 把真实 fixture 的资产占比换成货币基金的份额流量形态（期间申购/期间赎回/总份额）
  const moneyMarket = fixture('pingzhongdata/000001.js').replace(
    /Data_assetAllocation = \{[^;]*\};/,
    'Data_assetAllocation = {"series":[{"name":"期间申购","data":[0.86]},{"name":"期间赎回","data":[1.77]},{"name":"总份额","data":[27.12]}],"categories":["2026-09-30"]};',
  )
  const http = httpRouting([
    ['FundMNAssetAllocationNew', noReferer],
    ['pingzhongdata', moneyMarket],
  ])
  await expect(dataSource(http).assetAllocation('000001')).rejects.toThrow(/货币基金/)
})

/** 无报告期的年份：接口返回空 content（实测 year=1990 → content:""） */
const jjccEmptyYear = 'var apidata={ content:"",arryear:[2025],curyear:2026 }'
/** 把真实 fixture 的报告期整体挪到上一年，用来验「年初退一年」拿到的是上一年那一期 */
const jjccPrevYear = fixture('jjcc/000001-2026.html').replaceAll('2026', '2025')

it('holdings：now 固定在年初且未指定年份时，取到的是上一年那一期，而非空/当年', async () => {
  const http = httpRouting([
    ['year=2025', jjccPrevYear],
    ['year=2026', jjccEmptyYear],
  ])
  const r = await dataSource(http).holdings('000001', { now: () => new Date(2026, 0, 5) })
  expect(r.value.reportDate).toBe('2025-09-30') // 当年无报告期 → 退一年，且没崩、没给 2026
})

it('holdings：指定月份未命中且备源可用时仍抛错，绝不返回备源的期', async () => {
  // 备源 FundMNInverstPosition 本身可用（返回它自己的最新一期 2026-09-30）——若没拦住就会拿它顶上
  const http = httpRouting([
    ['type=jjcc', fixture('jjcc/000001-2026.html')],
    ['FundMNInverstPosition', fixture('fundmobapi_position/000001.json')],
  ])
  const call = dataSource(http).holdings('000001', { year: 2026, month: 12 })
  await expect(call).rejects.toThrow(DataSourceError)
  await expect(call).rejects.toThrow(/没有 12 月对应的报告期.*2026-09-30/) // 主源：说清要哪期、实际有哪些
  await expect(call).rejects.toThrow(/不提供按期/) // 备源：被拒，不返回它的期
})

it('holdings：显式指定年份时，当年无报告期一律抛错，不回退上一年（也不靠 [0]! 取到 undefined）', async () => {
  const http = httpRouting([
    ['year=2025', jjccPrevYear], // 若错误地退回上一年，会拿到这一期
    ['year=2026', jjccEmptyYear],
  ])
  await expect(dataSource(http).holdings('000001', { year: 2026 })).rejects.toThrow(
    /没有任何报告期/,
  )
})

it('industryAllocation / financials：默认年份取自注入的 now，而非挂钟', async () => {
  const seen: string[] = []
  const http = new HttpClient({
    minIntervalMs: 0,
    maxRetries: 0,
    fetch: async (url) => {
      seen.push(String(url))
      return new Response(
        String(url).includes('HYPZ')
          ? fixture('api_fund_hypz/000001-2026.json')
          : fixture('api_fund_cwzb/000001.json'),
      )
    },
  })
  const ds = dataSource(http)
  const now = () => new Date(2019, 0, 5) // 用 2019 断开与当前挂钟年（2026）的联系，才能证明确实读了注入值
  await ds.industryAllocation('000001', { now })
  await ds.financials('000001', { now })
  expect(seen.map((u) => new URL(u).searchParams.get('year'))).toEqual(['2019', '2019'])
})
