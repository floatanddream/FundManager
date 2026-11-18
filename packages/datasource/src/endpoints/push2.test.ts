import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { BusinessCodeError, ParseError } from '../http/errors.ts'
import { clistRequest, parseSectorMembers, parseStockIndustry, stockRequest } from './push2.ts'

const text = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')

it('URL 构造：stock/get 带 market.code 的 secid；clist/get 的 fs 原样透传', () => {
  expect(stockRequest('0.300308')).toEqual({
    url: 'https://push2.eastmoney.com/api/qt/stock/get?secid=0.300308&fields=f57,f58,f127,f128',
  })
  expect(clistRequest({ fs: 'b:BK0475', pn: 1, pz: 3 })).toEqual({
    url: 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&fs=b:BK0475&fields=f12,f14',
  })
})

it('stock/get：解析出细分行业与地域板块', () => {
  // f127 是细分行业名「通信设备」，不是 HYPZ 的国民经济分类
  expect(parseStockIndustry(text('push2_stock_get/sz300308.json'))).toEqual({
    code: '300308',
    name: '中际旭创',
    industry: '通信设备',
    region: '山东板块',
  })
})

it('stock/get：data 为 null 返回 null（代码不存在），不返回空对象', () => {
  expect(parseStockIndustry(JSON.stringify({ rc: 0, data: null }))).toBeNull()
  // 空串/`-` 是东财的「无此数据」哨兵，归一成 null
  expect(
    parseStockIndustry(
      JSON.stringify({ rc: 0, data: { f57: '1', f58: 'X', f127: '', f128: '-' } }),
    ),
  ).toEqual({ code: '1', name: 'X', industry: null, region: null })
})

it('stock/get：rc 非 0 抛 BusinessCodeError；data 非对象、缺字段抛 ParseError', () => {
  expect(() => parseStockIndustry(JSON.stringify({ rc: -1, data: null }))).toThrow(
    BusinessCodeError,
  )
  expect(() => parseStockIndustry(JSON.stringify({ rc: 0, data: 'x' }))).toThrow(ParseError)
  expect(() => parseStockIndustry(JSON.stringify({ rc: 0, data: { f57: '1', f58: 'X' } }))).toThrow(
    ParseError,
  )
  expect(() => parseStockIndustry('not json')).toThrow(ParseError)
})

it('clist/get：diff 是字典不是数组，按序取出成分股', () => {
  const result = parseSectorMembers(text('push2_clist_get/bank-BK0475.json'))
  expect(result!.total).toBe(42)
  expect(result!.members).toEqual([
    { code: '601288', name: '农业银行' },
    { code: '601818', name: '光大银行' },
    { code: '000001', name: '平安银行' },
  ])
})

it('clist/get：data 为 null 返回 null；diff 缺失抛 ParseError（不伪装成空集合）', () => {
  expect(parseSectorMembers(JSON.stringify({ rc: 0, data: null }))).toBeNull()
  expect(() => parseSectorMembers(JSON.stringify({ rc: 0, data: { total: 0 } }))).toThrow(
    ParseError,
  )
  expect(() => parseSectorMembers(JSON.stringify({ rc: 0, data: { total: 1, diff: [] } }))).toThrow(
    ParseError,
  )
  expect(() => parseSectorMembers(JSON.stringify({ rc: 5, data: null }))).toThrow(BusinessCodeError)
})
