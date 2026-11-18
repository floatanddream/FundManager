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
