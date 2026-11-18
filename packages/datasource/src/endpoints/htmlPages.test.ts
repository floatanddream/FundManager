import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { ParseError } from '../http/errors.ts'
import { fhspRequest, jbgkRequest, parseFhsp, parseJbgk } from './htmlPages.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')

it('URL 构造：两个端点都不需要任何请求头', () => {
  expect(jbgkRequest('000001')).toEqual({ url: 'https://fundf10.eastmoney.com/jbgk_000001.html' })
  expect(fhspRequest('510300')).toEqual({ url: 'https://fundf10.eastmoney.com/fhsp_510300.html' })
})

it('jbgk：业绩比较基准与跟踪标的按 <th> 文本定位，同一行夹多组也不串位', () => {
  const active = parseJbgk(fixture('jbgk/000001.html'))
  // 主动基金：基准指向中证800成长指数 70% + 中债综合 30%；跟踪标的如实是「无」
  expect([active.benchmark, active.trackingTarget]).toEqual([
    '中证800成长指数收益率*70%+中债-综合全价(总值)指数收益率*30%',
    '该基金无跟踪标的',
  ])
  // 联接基金：基准 95%（实测其「股票仓位」字段只有 0.41%，是障眼法，有效暴露只能取基准）
  const feeder = parseJbgk(fixture('jbgk/011609.html'))
  expect([feeder.benchmark, feeder.trackingTarget]).toEqual([
    '上证科创板50成份指数收益率*95%+活期存款利率(税后)*5%',
    '上证科创板50成份指数',
  ])
  // 「基金代码」那行的 <td> 实测没闭合，值不能把下一组的 <th>基金类型</th> 一起吃进来
  expect([active.fields['基金代码'], active.fields['基金类型']]).toEqual([
    '000001（前端）、000002（后端）',
    '混合型-灵活',
  ])
})

it('fhsp：分红表与拆分表分开解析，元/10份与无量纲比例不混为一谈', () => {
  const dividendOnly = parseFhsp(fixture('fhsp/000001.html'))
  expect(dividendOnly.dividends).toHaveLength(25) // 与 jbgk 的「成立来分红 25 次」一致
  expect(dividendOnly.dividends[0]).toEqual({
    year: 2025,
    recordDate: '2025-09-22',
    exDate: '2025-09-22',
    per10Units: 0.1,
    payDate: '2025-09-23',
  })
  // 该基金没有拆分，拆分表是 colspan 占位行「暂无拆分信息!」——空集合，不是解析失败
  expect(dividendOnly.splits).toEqual([])

  const split = parseFhsp(fixture('fhsp/510300.html'))
  expect(split.splits).toEqual([
    { year: 2012, splitDate: '2012-05-11', kind: '份额折算', ratio: { from: 1, to: 0.3709 } },
  ])
  expect(split.dividends[0]).toEqual({
    year: 2026,
    recordDate: '2026-01-16',
    exDate: '2026-01-19',
    per10Units: 1.23,
    payDate: '2026-01-27',
  })
})

it('两个端点：缺表或缺 <th> 一律抛 ParseError，不返回空集合或空串', () => {
  const noTable = '<html><body><p>页面已改版</p></body></html>'
  expect(() => parseJbgk(noTable)).toThrow(ParseError)
  expect(() => parseFhsp(noTable)).toThrow(ParseError)
  // 概况表还在，但「跟踪标的」的 <th> 没了（只剩基准）
  expect(() =>
    parseJbgk('<table><tr><th>业绩比较基准</th><td>某指数收益率*100%</td></tr></table>'),
  ).toThrow(ParseError)
  // 分红表还在，但表头被改（只剩 1 个 <th>）
  expect(() =>
    parseFhsp(
      `<table class='comm cfxq'><thead><tr><th>年份</th></tr></thead><tbody><tr><td>2025年</td></tr></tbody></table>`,
    ),
  ).toThrow(ParseError)
})
