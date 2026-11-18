/**
 * `fund.eastmoney.com/js/fundcode_search.js`：全量基金代码表。URL 构造 + 解析纯函数。
 *
 * 响应**不需要任何请求头**，编码 UTF-8 **带 BOM**（`decodeBody` 会去掉）。
 * 见 `docs/research/2026-11-18-datasource-inventory.md` §1.2、§6 #3。
 *
 * 形态是 **JS 赋值语句**（`var r = [[…],[…]];`），**不是 JSON**。解析用「取赋值右侧的数组字面量
 * 再 `JSON.parse`」——数组字面量本身就是合法 JSON，**故不必也绝不可 `eval`/`new Function`**
 * （`eval` 会执行外部文件里的任意代码）。见 `CONSTRAINTS/08-code-style.md`。
 *
 * 实测整表 **3.2 MB / 两万余条**，逐字节存 fixture 会让仓库臃肿且解析几乎不会错，故仓库内只存
 * **首尾截断样本**（见 `test/fixtures/fundcode_search/manifest.json` 的 `notes`）。
 */
import type { HttpRequestSpec } from '../http/client.ts'
import { ParseError } from '../http/errors.ts'

const FUNDCODE_URL = 'https://fund.eastmoney.com/js/fundcode_search.js'

/**
 * 一行基金元数据（接口是 5 元组数组）。
 *
 * 元组顺序 **代码 / 拼音简写 / 名称 / 类型 / 全拼**——若照普通「代码在前、名称在后」的直觉取，
 * 会把简写当名称。
 */
export type FundCodeEntry = {
  /** 基金代码，如 `000001` */
  readonly code: string
  /** 拼音简写，如 `HXCZHH` */
  readonly abbrev: string
  /** 基金名称，如 `华夏成长混合` */
  readonly name: string
  /** 类型，如 `混合型-灵活` */
  readonly category: string
  /** 拼音全拼，如 `HUAXIACHENGZHANGHUNHE` */
  readonly pinyin: string
}

/** 每行的元素个数（实测全部为 5）。 */
const ENTRY_WIDTH = 5

/** 匹配 `var r = <数组字面量>;`（BOM 已由调用方或本函数去掉，见下）。 */
const ASSIGNMENT = /^\s*var\s+r\s*=\s*(\[[\s\S]*\])\s*;?\s*$/

/** 构造基金代码表请求。**不声明 charset**：响应是 UTF-8，`decodeBody` 默认按 UTF-8 解并去 BOM。 */
export function fundcodeRequest(): HttpRequestSpec {
  return { url: FUNDCODE_URL }
}

/**
 * 解析 `fundcode_search.js`，返回全部基金元数据。
 *
 * @throws {ParseError} 不是 `var r = […]` 的形状、右侧不是合法 JSON 数组、某行不是 5 个字符串，
 *   或结果为空（空表不可能是真实的全量列表，宁可抛错也不返回空集合）
 */
export function parseFundCodeList(text: string): readonly FundCodeEntry[] {
  // 真实链路里 BOM 已被 decodeBody 去掉；此处再兜一次，使解析器对直接喂原始文本也成立
  const source = text.replace(/^﻿/, '')
  const match = ASSIGNMENT.exec(source)
  if (match === null) {
    throw new ParseError(
      'fundcode_search：响应不是 `var r = […];` 的形状（结构已变，实测应为 JS 赋值语句）',
    )
  }
  let rows: unknown
  try {
    rows = JSON.parse(match[1]!)
  } catch (cause) {
    throw new ParseError('fundcode_search：赋值右侧不是合法 JSON 数组（结构已变）', { cause })
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ParseError('fundcode_search：解析结果不是非空数组（结构已变或响应为错误页）')
  }
  return rows.map((row, index) => parseEntry(row, index))
}

function parseEntry(row: unknown, index: number): FundCodeEntry {
  if (!Array.isArray(row) || row.length < ENTRY_WIDTH) {
    throw new ParseError(`fundcode_search：第 ${index} 行不是 ${ENTRY_WIDTH} 元组（结构已变）`)
  }
  const fields = row.slice(0, ENTRY_WIDTH)
  for (const [i, field] of fields.entries()) {
    if (typeof field !== 'string') {
      throw new ParseError(`fundcode_search：第 ${index} 行第 ${i} 列不是字符串（结构已变）`)
    }
  }
  const [code, abbrev, name, category, pinyin] = fields as string[]
  return { code: code!, abbrev: abbrev!, name: name!, category: category!, pinyin: pinyin! }
}
