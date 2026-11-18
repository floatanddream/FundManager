import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { decodeBody } from '../http/encoding.ts'
import { ParseError } from '../http/errors.ts'
import { fundcodeRequest, parseFundCodeList } from './fundcode.ts'

const bytes = readFileSync(
  new URL('../../test/fixtures/fundcode_search/truncated-sample.js', import.meta.url),
)
/** 原始字节，含 UTF-8 BOM（真实链路里 decodeBody 会去掉）。 */
const decoded = (): string => decodeBody(new Uint8Array(bytes), 'utf-8')

it('URL 构造：不声明 charset（UTF-8，BOM 由 decodeBody 去掉）', () => {
  expect(fundcodeRequest()).toEqual({ url: 'https://fund.eastmoney.com/js/fundcode_search.js' })
})

it('解析 5 元组：代码 / 拼音简写 / 名称 / 类型 / 全拼', () => {
  const entries = parseFundCodeList(decoded())
  expect(entries).toHaveLength(6)
  expect(entries[0]).toEqual({
    code: '000001',
    abbrev: 'HXCZHH',
    name: '华夏成长混合',
    category: '混合型-灵活',
    pinyin: 'HUAXIACHENGZHANGHUNHE',
  })
  expect(entries.at(-1)).toMatchObject({
    code: '970205',
    name: '兴证资管金麒麟兴享增利六个月持有期债券C',
  })
})

it('解析前自带去 BOM：直接喂原始文本也成立', () => {
  // readFileSync(…, 'utf8') 保留首字符 ﻿，解析器须自行剥离
  expect(parseFundCodeList(bytes.toString('utf8'))[0]!.code).toBe('000001')
})

it('形状不符抛 ParseError，不返回空集合', () => {
  expect(() => parseFundCodeList('{"not":"assignment"}')).toThrow(ParseError)
  expect(() => parseFundCodeList('var r = [[1,2,3,4,5]];')).toThrow(ParseError)
  expect(() => parseFundCodeList('var r = [];')).toThrow(ParseError)
  expect(() => parseFundCodeList('var r = [["000001","X"]];')).toThrow(ParseError)
})
