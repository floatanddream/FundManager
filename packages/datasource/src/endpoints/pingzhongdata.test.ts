import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { ParseError } from '../http/errors.ts'
import { parsePingzhongdata, pingzhongdataRequest } from './pingzhongdata.ts'

/** 原始响应含 BOM 与首段注释，`readFileSync(..., 'utf8')` 会连 BOM 一起读入——正好验证解析器能兜住 */
const fixture = (): string =>
  readFileSync(new URL('../../test/fixtures/pingzhongdata/000001.js', import.meta.url), 'utf8')

it('URL 构造：pingzhongdata 端点不需要任何请求头', () => {
  expect(pingzhongdataRequest('011609')).toEqual({
    url: 'https://fund.eastmoney.com/pingzhongdata/011609.js',
  })
})

it('净值走势：epoch 毫秒按北京时间还原为 YYYY-MM-DD，不整体早一天', () => {
  const { navTrend, accNavTrend } = parsePingzhongdata(fixture())
  expect(navTrend).toHaveLength(6046)
  // 首条 epoch 1008604800000 是基金成立日 2001-12-18；按 UTC 切片会错成 2001-12-17
  expect(navTrend[0]).toEqual({ date: '2001-12-18', nav: 1, equityReturn: 0, unitMoney: '' })
  // 末条 0.951 与 f10/lsjz 的 FSRQ=2026-11-17 同日同值（交叉验证日期没错位）
  expect(navTrend.at(-1)).toEqual({
    date: '2026-11-17',
    nav: 0.951,
    equityReturn: 0.74,
    unitMoney: '',
  })
  expect(accNavTrend.at(-1)).toEqual({ date: '2026-11-17', accNav: 3.524 })
})

it('一次解析出身份、费率、区间收益与现任经理', () => {
  const d = parsePingzhongdata(fixture())
  expect(d).toMatchObject({
    fundCode: '000001',
    fundName: '华夏成长混合',
    sourceRate: 1.5,
    rate: 0.15,
    minPurchase: 10,
    returns: { oneYear: -8.12, sixMonth: -23.68, threeMonth: -32.22, oneMonth: -14.01 },
  })
  expect(d.managers[0]).toEqual({
    id: '30040527',
    name: '郑晓辉',
    star: 4,
    workTime: '14年又344天',
    fundSize: '84.45亿(4只基金)',
  })
})

it('一次解析出资产配置、规模、同类排名与累计收益（按报告期对齐的 categories）', () => {
  const d = parsePingzhongdata(fixture())
  expect(d.assetAllocation.categories).toEqual([
    '2025-12-31',
    '2026-03-31',
    '2026-06-30',
    '2026-09-30',
  ])
  expect(d.assetAllocation.series[0]).toEqual({
    name: '股票占净比',
    data: [79.42, 72.51, 79.98, 78.21],
  })
  expect(d.scaleHistory.at(-1)).toEqual({
    reportDate: '2026-09-30',
    netAsset: 29.19,
    mom: '-25.89%',
  })
  expect(d.peerRankTrend[0]).toEqual({ date: '2013-01-04', rank: 49, total: 163 })
  expect(d.grandTotal.map((s) => s.name)).toEqual(['华夏成长混合', '同类平均', '沪深300'])
})

it('结构不符一律抛 ParseError，不返回空集合', () => {
  // 把别的端点的 HTML 喂进来：根本不是可执行 JS
  expect(() => parsePingzhongdata('<!DOCTYPE html><html></html>')).toThrow(ParseError)
  // 是可执行 JS，但没有本端点的变量（结构已变）
  expect(() => parsePingzhongdata('var somethingElse = 1;')).toThrow(ParseError)
})
