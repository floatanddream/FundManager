import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { decodeBody } from '../http/encoding.ts'
import { BusinessCodeError, ParseError } from '../http/errors.ts'
import { decodeGtimgBody, fqklineRequest, parseFqkline, parseQt, qtRequest } from './gtimg.ts'

const bytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)))
const text = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')

/** qt fixture 是 GBK 原始字节，须按 GBK 解码后再交给解析器（这也是真实链路的形态）。 */
const qtFixture = (): string => decodeBody(bytes('qt/multi-symbol.txt'), 'gbk')

const quote = (text: string, symbol: string): NonNullable<ReturnType<typeof parseQt>[number]> =>
  parseQt(text).find((q) => q.symbol === symbol)!

it('URL 构造：qt 声明 GBK 解码；fqkline 的 param 是定长位置参数', () => {
  expect(qtRequest(['sh000300', 'sz399006'])).toEqual({
    url: 'https://qt.gtimg.cn/q=sh000300,sz399006',
    charset: 'gbk',
  })
  expect(
    fqklineRequest({
      symbol: 'sh000300',
      start: '2026-10-01',
      end: '2026-11-18',
      count: 20,
      adjust: 'qfq',
    }),
  ).toEqual({
    url: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000300,day,2026-10-01,2026-11-18,20,qfq',
  })
  // 默认：周期 day、数量 20、复权 qfq；起止可省（留空占位）
  expect(fqklineRequest({ symbol: 'sh000300' }).url).toBe(
    'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000300,day,,,20,qfq',
  )
})

it('qt：GBK 解码后名称正确，一次请求多代码返回多行', () => {
  expect(parseQt(qtFixture()).map((q) => [q.symbol, q.name, q.code, q.securityType])).toEqual([
    ['sh000300', '沪深300', '000300', 'ZS'],
    ['sz399006', '创业板指', '399006', 'ZS'],
    ['sh510300', '沪深300ETF华泰柏瑞', '510300', 'ETF'],
    ['sh600519', '贵州茅台', '600519', 'GP-A'],
  ])
})

it('qt：字段位置按实测表解析，时间戳是独立类型', () => {
  const index = quote(qtFixture(), 'sh000300')
  expect(index).toMatchObject({
    price: 3983.77,
    previousClose: 3976.46,
    open: 3991.16,
    high: 3991.16,
    low: 3948.5,
    change: 7.31,
    changePercent: 0.18,
    amount: 38991384,
    timestamp: { raw: '20261118161411', date: '2026-11-18', time: '16:14:11' },
  })
  // 指数无买卖盘、无涨跌停：哨兵 -1 不能当价格，一律 null
  expect(index.limitUp).toBeNull()
  expect(index.bids[0]).toEqual({ price: null, volume: 0 })

  const stock = quote(qtFixture(), 'sh600519')
  // 三条关系核对位置没串：涨停=昨收×1.1、跌停=昨收×0.9、买一价=最新价
  expect(stock.limitUp).toBeCloseTo(stock.previousClose! * 1.1, 2)
  expect(stock.limitDown).toBeCloseTo(stock.previousClose! * 0.9, 2)
  expect(stock.bids[0]).toEqual({ price: 1442.66, volume: 7 })
  expect(stock.asks[0]).toEqual({ price: 1443.0, volume: 1 })
})

it('qt：行形状不符抛 ParseError；全部不匹配的 pv_none_match 返回空', () => {
  expect(() => parseQt('{"foo":1}')).toThrow(ParseError)
  expect(() => parseQt('')).toThrow(ParseError)
  // 「一个都没匹配上」的固定响应不是解析失败
  expect(parseQt('v_pv_none_match="1";\n')).toEqual([])
})

it('decodeGtimgBody：UTF-8 名义下的 GBK 回退，合法 UTF-8 原样返回', () => {
  expect(decodeGtimgBody(bytes('qt/multi-symbol.txt'))).toContain('沪深300')
  expect(decodeGtimgBody(new TextEncoder().encode('华夏成长混合'))).toBe('华夏成长混合')
})

it('fqkline：指数用 day 键，close 在第三位（不是 OHLC）', () => {
  const [index] = parseFqkline(text('fqkline/sh000300-day.json'))
  expect(index).toMatchObject({ symbol: 'sh000300', dataKey: 'day', period: 'day', adjust: null })
  expect(index!.bars).toHaveLength(20)
  expect(index!.bars[0]).toEqual({
    date: '2026-10-22',
    open: 4110.65,
    close: 4036.3,
    high: 4110.65,
    low: 4022.87,
    volume: 178043852,
  })
  expect(index!.bars.at(-1)).toEqual({
    date: '2026-11-18',
    open: 3991.16,
    close: 3983.77,
    high: 3991.16,
    low: 3948.5,
    volume: 167318271,
  })
})

it('fqkline：个股用 qfqday 键（写死 day 会取不到数据）', () => {
  const [stock] = parseFqkline(text('fqkline/sh600519-day.json'))
  expect(stock).toMatchObject({
    symbol: 'sh600519',
    dataKey: 'qfqday',
    period: 'day',
    adjust: 'qfq',
  })
  expect(stock!.bars[0]).toEqual({
    date: '2026-10-21',
    open: 1331.88,
    close: 1309.69,
    high: 1331.98,
    low: 1302.36,
    volume: 33514,
  })
  // 末条 close 与 qt 里 sh600519 的昨收 1457.70 交叉一致
  expect(stock!.bars.at(-1)!.close).toBe(1457.7)
})

it('fqkline：业务码非 0 或顶层 msg 非空都当失败；结构不符抛 ParseError', () => {
  expect(() =>
    parseFqkline(
      JSON.stringify({ code: 1, msg: 'bad params', data: { sh000300: { version: '16' } } }),
    ),
  ).toThrow(BusinessCodeError)
  // 实测：代码/市场不识别时 code 仍为 0，靠 msg=param error 才知道失败
  expect(() => parseFqkline(JSON.stringify({ code: 0, msg: 'param error', data: [] }))).toThrow(
    BusinessCodeError,
  )
  expect(() => parseFqkline(JSON.stringify({ code: 0, msg: '', data: [] }))).toThrow(ParseError)
  expect(() => parseFqkline('not json')).toThrow(ParseError)
})
