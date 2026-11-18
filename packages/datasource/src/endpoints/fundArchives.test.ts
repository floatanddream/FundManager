import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { ParseError } from '../http/errors.ts'
import { gmbdRequest, jjccRequest, parseGmbd, parseJjcc } from './fundArchives.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')

/** 实测缺 Referer 的失败响应：HTTP 404 + 反爬/404 HTML 页（`<!DOCTYPE html…>`），不是业务码 JSON */
const antiCrawlHtml = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<meta http-equiv="Content-Type" content="text/html; charset=gb2312"/>
<title>404 - 找不到文件或目录。</title></head>
<body><div id="header"><h1>无法找到资源</h1></div></body></html>`

it('URL 构造：两个端点的参数顺序与必需 Referer', () => {
  expect(jjccRequest({ fundCode: '000001', year: 2026, topline: 10, month: 6 })).toEqual({
    url: 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=000001&topline=10&year=2026&month=6',
    headers: { Referer: 'https://fundf10.eastmoney.com/ccmx_000001.html' },
  })
  expect(gmbdRequest({ fundCode: '000001' })).toEqual({
    url: 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&code=000001&page=1',
    headers: { Referer: 'https://fundf10.eastmoney.com/gmbd_000001.html' },
  })
  // 不传 month 就不拼该参数；topline 有默认值（实测不传它会返回零行数据，绝不能省）
  expect(jjccRequest({ fundCode: '000001', year: 2026 }).url).toBe(
    'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=000001&topline=10&year=2026',
  )
})

it('jjcc：一个响应含多个报告期，按块给出报告期、行数与完整/前十大', () => {
  const periods = parseJjcc(fixture('jjcc/000001-2026.html'))
  expect(periods.map((p) => [p.reportDate, p.holdings.length, p.isFullPortfolio])).toEqual([
    ['2026-09-30', 10, false],
    ['2026-06-30', 77, true], // 半年报块，month=6 命中 → 返回全部持仓
    ['2026-03-31', 10, false],
  ])
})

it('jjcc：当前季度块 9 列、历史块 7 列，占净值比例都取最后三列而不错位', () => {
  const [q3, q2] = parseJjcc(fixture('jjcc/000001-2026.html'))
  // 当前季度块 9 列：最新价/涨跌幅是空 <span>，按固定列位取第 4 列会取到空值
  expect(q3!.holdings[0]).toEqual({
    rank: 1,
    stockCode: '300308',
    stockName: '中际旭创',
    navRatio: 5.26,
    shares: 19,
    marketValue: 15360.36,
  })
  expect(q3!.holdings.at(-1)).toEqual({
    rank: 10,
    stockCode: '688256',
    stockName: '寒武纪',
    navRatio: 3.41,
    shares: 9.86,
    marketValue: 9953.08,
  })
  // 历史块 7 列：最新价/涨跌幅/相关资讯整列不存在，同一只票（300308）的比例是 6.45 而非 5.26
  expect(q2!.holdings[0]).toEqual({
    rank: 1,
    stockCode: '300308',
    stockName: '中际旭创',
    navRatio: 6.45,
    shares: 20,
    marketValue: 25400,
  })
})

it('gmbd：解析规模份额全历史，缺失值 --- 记 null', () => {
  const rows = parseGmbd(fixture('gmbd/000001.html'))
  expect(rows).toHaveLength(100)
  expect(rows[0]).toEqual({
    reportDate: '2026-09-30',
    purchase: 1.51,
    redemption: 1.68,
    totalShares: 23.89,
    netAsset: 29.19,
    navChangeRate: -25.89,
  })
  expect(rows.at(-1)).toEqual({
    reportDate: '2001-12-18',
    purchase: null,
    redemption: null,
    totalShares: 32.37,
    netAsset: null,
    navChangeRate: null,
  })
})

it('两个端点：喂反爬 HTML 或缺变量的脚本一律抛 ParseError，不返回空集合', () => {
  for (const parse of [parseJjcc, parseGmbd]) {
    expect(() => parse(antiCrawlHtml)).toThrow(ParseError)
    expect(() => parse('var somethingElse = 1;')).toThrow(ParseError)
  }
})
