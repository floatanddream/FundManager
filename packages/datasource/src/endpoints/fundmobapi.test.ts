import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { BusinessCodeError, ParseError } from '../http/errors.ts'
import {
  MOBILE_USER_AGENT,
  assetAllocationRequest,
  basicInformationRequest,
  detailInformationRequest,
  hisNetListRequest,
  inverstPositionRequest,
  parseInverstPosition,
  parseMobAssetAllocation,
  parseMobBasicInformation,
  parseMobDetailInformation,
  parseMobHisNetList,
} from './fundmobapi.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')

/** 取抛出的错误信息，便于对可操作提示做多条子串断言 */
const caughtMessage = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

it('URL 构造：四端点固定带 Mobile UA、无 Referer，参数为实测可用的 App 形状', () => {
  const origin = 'https://fundmobapi.eastmoney.com/FundMNewApi'
  expect(inverstPositionRequest('000001')).toEqual({
    url: `${origin}/FundMNInverstPosition?FCODE=000001&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=`,
    headers: { 'User-Agent': MOBILE_USER_AGENT },
  })
  expect(assetAllocationRequest('000001').url).toBe(
    `${origin}/FundMNAssetAllocationNew?FCODE=000001&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=`,
  )
  // 历史净值分页：pageIndex/pageSize 拼在 FCODE 之后、公共 App 参数之前
  expect(hisNetListRequest({ fundCode: '000001' })).toEqual({
    url: `${origin}/FundMNHisNetList?FCODE=000001&pageIndex=1&pageSize=20&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=`,
    headers: { 'User-Agent': MOBILE_USER_AGENT },
  })
  expect(basicInformationRequest('000001').headers?.['User-Agent']).toContain('Mobile')
  expect(detailInformationRequest('000001').headers).not.toHaveProperty('Referer')
})

it('FundMNInverstPosition：报告期取自顶层 Expansion，仅前十大并带个股行业与增减持', () => {
  const pos = parseInverstPosition(fixture('fundmobapi_position/000001.json'))
  expect(pos.reportDate).toBe('2026-09-30')
  expect(pos.stocks).toHaveLength(10)
  expect(pos.stocks[0]).toEqual({
    stockCode: '300308',
    stockName: '中际旭创',
    navRatio: 5.26,
    industryName: '通信',
    changeType: '减持',
    changeValue: -1.19,
  })
  expect(pos.stocks.at(-1)?.stockCode).toBe('688256')
  expect(pos.bonds[0]).toEqual({ bondCode: '019827', bondName: '26国债01', navRatio: 7.36 })
})

it('FundMNInverstPosition：桌面 UA 被拒时指出是 UA 问题，不当成网络繁忙', () => {
  const body = fixture('fundmobapi_position/desktop-UA-rejected.json')
  expect(() => parseInverstPosition(body)).toThrow(BusinessCodeError)
  const msg = caughtMessage(() => parseInverstPosition(body))
  expect(msg).toMatch(/User-Agent/)
  expect(msg).toMatch(/不是网络问题/)
  expect(msg).toMatch(/Mobile/)
})

it('FundMNAssetAllocationNew：解析最新报告期的资产配置，-- 记 null 不折算', () => {
  const rows = parseMobAssetAllocation(fixture('fundmobapi_assetallocation/000001.json'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual({
    reportDate: '2026-09-30',
    stockRatio: 78.21,
    bondRatio: 20.82,
    cashRatio: 0.45,
    otherRatio: 0.52,
    netAsset: 29.1867,
  })
})

it('FundMNHisNetList：解析一页净值并保留 totalCount（防静默截断成 20 天）', () => {
  const page = parseMobHisNetList(fixture('fundmobapi_hisnet/000001.json'))
  expect(page.totalCount).toBe(6046)
  expect(page.rows).toHaveLength(20)
  expect(page.rows[0]).toEqual({ date: '2026-11-17', nav: 0.951, accNav: 3.524, growthRate: 0.74 })
})

it('基本信息 / 详情：解析名称、类型、净值日、经理，以及详情里的业绩比较基准', () => {
  expect(parseMobBasicInformation(fixture('fundmobapi_info/000001-basic.json'))).toMatchObject({
    fundCode: '000001',
    shortName: '华夏成长混合',
    navDate: '2026-11-17',
    nav: 0.951,
    growthRate: 0.74,
    managers: ['郑晓辉', '刘睿聪'],
  })
  const detail = parseMobDetailInformation(fixture('fundmobapi_info/000001-detail.json'))
  expect(detail).toMatchObject({
    fundCode: '000001',
    fullName: '华夏成长证券投资基金',
    establishDate: '2001-12-18',
    trackingCode: null,
    trackingName: null,
  })
  // 设计 §七 称本端点不含业绩比较基准，实测 PERFCMP/BENCH 有值——如实解析，供报告核对
  expect(detail.benchmark).toContain('中证800成长指数')
})

it('五个端点：非 JSON 或 ErrCode 为 0 但结构不符，一律抛 ParseError 不返回空集合', () => {
  const wrongShape = JSON.stringify({ ErrCode: 0, Success: true, Datas: 'oops', TotalCount: 0 })
  const parsers = [
    parseInverstPosition,
    parseMobAssetAllocation,
    parseMobHisNetList,
    parseMobBasicInformation,
    parseMobDetailInformation,
  ]
  for (const parse of parsers) {
    expect(() => parse('not json')).toThrow(ParseError)
    expect(() => parse(wrongShape)).toThrow(ParseError)
  }
})
