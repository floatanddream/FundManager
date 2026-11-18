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

it('holdings：主源失败降级到移动端时，loss 与「本次仅前十大」可区分', async () => {
  const http = httpRouting([['FundMNInverstPosition', fixture('fundmobapi_position/000001.json')]])
  const r = await dataSource(http).holdings('000001', { year: 2026 })
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

  const backup = await dataSource(
    httpRouting([['pingzhongdata', fixture('pingzhongdata/000001.js')]]),
  ).assetAllocation('000001')
  expect(backup.source).toBe('pingzhongdata/Data_assetAllocation')
  expect(backup.loss).toContain('其他')
})
