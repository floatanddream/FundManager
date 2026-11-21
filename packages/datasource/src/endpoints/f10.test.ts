import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { BusinessCodeError, ParseError } from '../http/errors.ts'
import {
  cwzbRequest,
  fhggRequest,
  hypzRequest,
  jjhslRequest,
  jjggRequest,
  lsjzRequest,
  parseCwzb,
  parseFhgg,
  parseHypz,
  parseJjhsl,
  parseJjgg,
  parseLsjz,
} from './f10.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')

/** 实测形状：缺 Referer 时东财返回 HTTP 200 + ErrCode:-999，Data 为空串、PageSize/PageIndex 为 0 */
const noReferer = (): string =>
  JSON.stringify({
    Data: '',
    ErrCode: -999,
    ErrMsg: '',
    TotalCount: 0,
    Expansion: null,
    PageSize: 0,
    PageIndex: 0,
  })

/** 业务码为 0 但结构不是预期的样子——必须抛 ParseError，不能退化成空集合 */
const wrongShape = (): string => JSON.stringify({ ErrCode: 0, ErrMsg: null, Data: 'oops' })

it('URL 构造按各端点实测的参数名（大小写敏感）与必需 Referer', () => {
  expect(lsjzRequest({ fundCode: '000001' })).toEqual({
    url: 'https://api.fund.eastmoney.com/f10/lsjz?fundCode=000001&pageIndex=1&pageSize=20',
    headers: { Referer: 'https://fundf10.eastmoney.com/jjjz_000001.html' },
  })
  expect(hypzRequest({ fundCode: '000001', year: 2026 }).url).toBe(
    'https://api.fund.eastmoney.com/f10/HYPZ/?fundCode=000001&year=2026',
  )
  expect(fhggRequest({ fundCode: '000001' }).url).toBe(
    'https://api.fund.eastmoney.com/f10/FHGG?fundcode=000001&pageIndex=1&pageSize=10',
  )
  expect(jjggRequest({ fundCode: '000001' }).url).toBe(
    'https://api.fund.eastmoney.com/f10/JJGG?fundcode=000001&pageIndex=1&pageSize=10&type=0',
  )
  expect(cwzbRequest({ fundCode: '000001', year: 2026 }).url).toBe(
    'https://api.fund.eastmoney.com/f10/GetArrayCwzb?fundcode=000001&showtype=0&year=2026',
  )
  expect(jjhslRequest({ fundCode: '000001' }).url).toBe(
    'https://api.fund.eastmoney.com/f10/JJHSL/?fundcode=000001&pageindex=1&pagesize=5',
  )
  expect(jjhslRequest({ fundCode: '000001' }).headers?.['Referer']).toBe(
    'https://fundf10.eastmoney.com/jjhsl_000001.html',
  )
})

it('lsjz：解析净值行、分页信息，以及藏在行里的分红事件', () => {
  const page = parseLsjz(fixture('api_fund_lsjz/000001-dividend.json'))
  expect(page).toMatchObject({ pageIndex: 1, pageSize: 20, totalCount: 3 })
  expect(page.rows[0]).toEqual({
    date: '2025-09-23',
    nav: 1.091,
    accNav: 3.664,
    growthRate: -0.09,
    event: null,
  })
  expect(page.rows[1]).toEqual({
    date: '2025-09-22',
    nav: 1.092,
    accNav: 3.665,
    growthRate: 1.57,
    event: { kind: 'dividend', perUnit: 0.01, per10Unit: 0.1, description: '每10份派现金0.1000元' },
  })
  expect(page.rows[2]?.date).toBe('2025-09-19')
})

it('lsjz：FHFCBZ=106 识别为拆分折算，FHFCZ10 与 FHFCZ 同值', () => {
  const { rows } = parseLsjz(fixture('api_fund_lsjz/510300-split.json'))
  expect(rows).toHaveLength(1)
  expect(rows[0]?.event).toEqual({
    kind: 'split',
    perUnit: 0.37094933,
    per10Unit: 0.37094933,
    description: '每份基金份额折算0.37094933份',
  })
})

it('lsjz：明确的折算码即使缺少描述和金额也保留事件', () => {
  const payload = JSON.parse(fixture('api_fund_lsjz/510300-split.json')) as {
    Data: { LSJZList: Array<Record<string, unknown>> }
  }
  payload.Data.LSJZList[0]!.FHFCZ = ''
  payload.Data.LSJZList[0]!.FHFCZ10 = null
  payload.Data.LSJZList[0]!.FHSP = ''
  expect(parseLsjz(JSON.stringify(payload)).rows[0]?.event).toEqual({
    kind: 'split',
    perUnit: null,
    per10Unit: null,
    description: '',
  })
})

it('lsjz：业务码非 0 抛 BusinessCodeError，不返回空集合', () => {
  expect(() => parseLsjz(noReferer())).toThrow(BusinessCodeError)
  expect(() => parseLsjz(noReferer())).toThrow('ErrCode:-999')
})

it('hypz：解析行业配置的季度与占净值比例', () => {
  const quarters = parseHypz(fixture('api_fund_hypz/000001-2026.json'))
  expect(quarters.map((q) => q.reportDate)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31'])
  expect(quarters[0]?.quarter).toBe('3')
  expect(quarters[0]?.rows[0]).toEqual({
    industryCode: 'C',
    industryName: '制造业',
    marketValue: 204306.051448,
    navRatio: 70,
  })
})

it('hypz：业务码非 0 抛 BusinessCodeError', () => {
  expect(() => parseHypz(noReferer())).toThrow(BusinessCodeError)
})

it('fhgg：解析分红公告的标题、发布日期与 ID', () => {
  const page = parseFhgg(fixture('api_fund_fhgg/000001.json'))
  expect(page).toMatchObject({ totalCount: 15, pageIndex: 1, pageSize: 10 })
  expect(page.items).toHaveLength(10)
  expect(page.items[0]).toEqual({
    fundCode: '000001',
    title: '华夏成长证券投资基金第二十五次分红公告',
    publishDate: '2025-09-18',
    id: 'AN202509181745804126',
    category: '2',
  })
})

it('fhgg：业务码非 0 抛 BusinessCodeError', () => {
  expect(() => parseFhgg(noReferer())).toThrow(BusinessCodeError)
})

it('jjgg：解析全部公告列表', () => {
  const page = parseJjgg(fixture('api_fund_jjgg/000001.json'))
  expect(page.totalCount).toBe(1694)
  expect(page.items[0]?.title).toBe('关于暂停部分电子交易的服务提示')
  expect(page.items[0]?.publishDate).toBe('2026-11-06')
})

it('jjgg：业务码非 0 抛 BusinessCodeError', () => {
  expect(() => parseJjgg(noReferer())).toThrow(BusinessCodeError)
})

it('cwzb：列式字典按索引 zip 成按报告期的行，千分位与百分号已归一', () => {
  const { periods, warnings } = parseCwzb(fixture('api_fund_cwzb/000001.json'))
  expect(warnings).toEqual([])
  expect(periods.map((p) => p.reportDate)).toEqual([
    '2026-06-30',
    '2025-12-31',
    '2025-06-30',
    '2024-12-31',
  ])
  expect(periods[0]?.metrics).toEqual({
    COMPROFIT: 194068592.02,
    NETPROFIT: 1379209410.51,
    UNITPROFIT: 0.54,
    NGROWTH: 45.28,
    FNGROWTH: 51.15,
    DISPROFIT: 615783507.36,
    DIFUNTIPROFIT: 0.26,
    ENDNAV: 3938207602.85,
    ENDUNITNAV: 1.64,
    FCNGROWTH: 969.24,
  })
})

it('cwzb：无数据年份的占位空行被跳过并记入 warnings', () => {
  const body = JSON.stringify({
    ErrCode: 0,
    ErrMsg: null,
    Data: { data: { FSRQ: [''], NETPROFIT: [''] } },
  })
  const { periods, warnings } = parseCwzb(body)
  expect(periods).toEqual([])
  expect(warnings).toHaveLength(1)
})

it('cwzb：业务码非 0 抛 BusinessCodeError', () => {
  expect(() => parseCwzb(noReferer())).toThrow(BusinessCodeError)
})

it('jjhsl：解析换手率并保留分页信息', () => {
  const page = parseJjhsl(fixture('api_fund_jjhsl/000001.json'))
  expect(page).toMatchObject({ totalCount: 44, pageSize: 5, pageIndex: 1 })
  expect(page.rows[0]).toEqual({ reportDate: '2026-06-30', stockTurnover: 218.01 })
  expect(page.rows).toHaveLength(5)
})

it('jjhsl：业务码非 0 抛 BusinessCodeError', () => {
  expect(() => parseJjhsl(noReferer())).toThrow(BusinessCodeError)
})

it('六个端点：ErrCode 为 0 但结构不符一律抛 ParseError，不返回空集合', () => {
  const parsers = [parseLsjz, parseHypz, parseFhgg, parseJjgg, parseCwzb, parseJjhsl]
  for (const parse of parsers) expect(() => parse(wrongShape())).toThrow(ParseError)
})
