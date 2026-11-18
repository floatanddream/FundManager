/**
 * 腾讯行情族两个端点：URL 构造 + 解析纯函数。
 *
 * - `qt.gtimg.cn/q=` 实时行情（指数 / 场内 ETF / 个股），响应 **GBK**，一次可请求多个代码
 * - `web.ifzq.gtimg.cn/appstock/app/fqkline/get` 日 K 线（前复权等），响应 **JSON**
 *
 * 两者都**不需要任何请求头**（实测不带 Referer / 不带特殊 UA 均 200）。
 * 见 `docs/research/2026-11-18-datasource-inventory.md` §1.17（qt）、§1.18（fqkline）、§6 #7/#8。
 *
 * 实现期对盘点的修正（以本节为准，详见各函数注释）：
 * 1. `qt` 是 GBK：**必须先解码再解析**——直接按 UTF-8 读得到的是乱码，而乱码不会报错，
 *    只会静默产出错误的名称。故 `qtRequest` 声明 `charset: 'gbk'`，走 `decodeBody` 的 GBK 路径。
 * 2. `fqkline` 承载 K 线的键**不是固定 `day`**：指数（无复权数据）实测是 `day`，
 *    个股 / ETF（有复权数据）实测是 `qfqday`。写死 `day` 会在个股上静默取不到数据。
 * 3. `fqkline` 顶层 `code` **不足以判成败**：实测 `param` 格式错时 `code:1`，但代码/市场不识别时
 *    `code:0` + `msg:"param error"` + `data:[]`。故业务码校验必须**同时看 `msg`**。
 * 4. `fqkline` 的中文名一律是 `\u` 转义 ASCII，实测整份响应无非 ASCII 字节——盘点担心的
 *    「GBK 风险」未复现。仍保留 `decodeGtimgBody` 作为防御性回退（见其注释）。
 */
import { z } from 'zod'

import type { HttpRequestSpec } from '../http/client.ts'
import { decodeBody } from '../http/encoding.ts'
import { BusinessCodeError, ParseError } from '../http/errors.ts'

const QT_ENDPOINT = 'https://qt.gtimg.cn/q='
const FQKLINE_ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'

/**
 * 腾讯行情族（UTF-8 名义下）的防御性解码：先按 UTF-8 解，若出现替换字符 `U+FFFD`
 * （说明原字节不是合法 UTF-8）再回退 GBK。
 *
 * 实测 `fqkline` 的响应体是纯 ASCII（中文 `\u` 转义），此回退**不会触发**；保留它是因
 * 腾讯行情族历史上确有 GBK 响应。`HttpClient` 只按请求声明的单一 charset 解码，故需要
 * 自动回退时由此函数承担（`qt` 则直接声明 `charset: 'gbk'`，不必用它）。
 */
export function decodeGtimgBody(bytes: Uint8Array): string {
  const utf8 = decodeBody(bytes, 'utf-8')
  return utf8.includes('�') ? decodeBody(bytes, 'gbk') : utf8
}

// ---------------------------------------------------------------------------
// qt：实时行情（GBK，`~` 分隔）
// ---------------------------------------------------------------------------

/**
 * 构造 `qt.gtimg.cn/q=` 请求。一次可带多个代码（响应是多行 `v_...`）。
 *
 * **必须让内核按 GBK 解码**：响应头 `Content-Type: text/html; charset=GBK`，按 UTF-8 解
 * 会把 `沪深300` 变成一串替换字符，而这不报错——名称被静默写坏。
 */
export function qtRequest(symbols: readonly string[]): HttpRequestSpec {
  return { url: `${QT_ENDPOINT}${symbols.join(',')}`, charset: 'gbk' }
}

/**
 * 行情时间戳。**独立类型，刻意不与业务日期混用**（`CONSTRAINTS/08-code-style.md` §8.2）：
 * 「行情时间」是市场快照时刻（含时分秒、盘中反复变），而业务日期是 `YYYY-MM-DD` 的账务日。
 * 用同一个 `string` 装两者，迟早会把某个盘中时刻当成记账日。
 */
export type QuoteTimestamp = {
  /** 原始时间戳 `YYYYMMDDHHMMSS`，如 `20261118161411` */
  readonly raw: string
  /** 交易日 `YYYY-MM-DD` */
  readonly date: string
  /** 交易时刻 `HH:MM:SS` */
  readonly time: string
}

/** 一档买卖盘。 */
export type QuoteLevel = {
  /** 价；指数无买卖盘，此时为 `null` */
  readonly price: number | null
  /** 量（手） */
  readonly volume: number
}

/**
 * 一个品种的实时行情。
 *
 * **字段位置的来源**：腾讯未公开字段表，下面 `QT_FIELD` 的每个位置都是从实测取值**反推并核对**
 * 出来的（2026-11-18，样本 `sh000300`/`sz399006`/`sh510300`/`sh600519`）。核对方法写在每个字段注释里。
 * 未核对出语义的位置（54–60、62–87）**有意不解析**——不猜。
 */
export type Quote = {
  /** 请求里的品种代码（`v_` 变量名去掉前缀），如 `sh000300`；与下面 `code`（纯数字 `000300`）不同 */
  readonly symbol: string
  /** 名称（GBK 解码后） */
  readonly name: string
  /** 代码（纯数字，如 `000300`） */
  readonly code: string
  /** 最新价（字段 3，与字段 35 的第 1 段一致） */
  readonly price: number | null
  /** 昨收（字段 4；`price − 昨收 = 字段 31 涨跌` 已核对） */
  readonly previousClose: number | null
  /** 今开（字段 5） */
  readonly open: number | null
  /** 最高（字段 33，与 41 重复） */
  readonly high: number | null
  /** 最低（字段 34，与 42 重复） */
  readonly low: number | null
  /** 涨跌（字段 31） */
  readonly change: number | null
  /** 涨跌%（字段 32） */
  readonly changePercent: number | null
  /** 成交量（手，字段 6，与 36 重复） */
  readonly volume: number | null
  /** 成交额（万元，字段 37；`600519` 实测 431602 万 = 4316023208 元，与字段 35 第 3 段一致） */
  readonly amount: number | null
  /** 换手率（%，字段 38） */
  readonly turnoverRate: number | null
  /** 振幅（%，字段 43；实测 = (高−低)/昨收，与值吻合） */
  readonly amplitude: number | null
  /** 量比（字段 49） */
  readonly volumeRatio: number | null
  /** 均价（字段 51；`600519` 实测 ≈ 成交额/成交量/100） */
  readonly averagePrice: number | null
  /** 市盈率（TTM，字段 39；指数 13.50、`600519` 21.95 合理，ETF 为空） */
  readonly peTtm: number | null
  /** 市净率（字段 46） */
  readonly pb: number | null
  /** 总市值（亿元，字段 45） */
  readonly totalMarketCap: number | null
  /** 流通市值（亿元，字段 44） */
  readonly floatMarketCap: number | null
  /** 涨停价（字段 47；`600519` 实测 = 昨收×1.1，核对吻合）。指数实测哨兵值 `-1`（无涨跌停）→ `null` */
  readonly limitUp: number | null
  /** 跌停价（字段 48；`600519` 实测 = 昨收×0.9）。指数哨兵值 `-1` → `null` */
  readonly limitDown: number | null
  readonly timestamp: QuoteTimestamp
  /** 品种类别（字段 61）：`ZS` 指数 / `ETF` / `GP-A` A 股 */
  readonly securityType: string
  /** 买一~买五（字段 9–18）；指数无买卖盘，价全为 `null` */
  readonly bids: readonly QuoteLevel[]
  /** 卖一~卖五（字段 19–28） */
  readonly asks: readonly QuoteLevel[]
}

/**
 * `~` 分隔字段的位置 → 含义。**全部由实测取值反推**，不是照抄某份文档。
 *
 * | 位置 | 含义 | 核对依据 |
 * |---|---|---|
 * | 0 | 保留/未识别 | 指数 `"1"`、创业板指 `"51"`，不解析 |
 * | 1 | 名称 | GBK 解码后为 `沪深300` 等 |
 * | 2 | 代码 | `000300` |
 * | 3 | 最新价 | 与字段 35 第 1 段相同 |
 * | 4 | 昨收 | `3 − 4 = 31`（涨跌），实测吻合 |
 * | 5 | 今开 | |
 * | 6 | 成交量（手） | 与字段 35 第 2 段、字段 36 相同 |
 * | 7 / 8 | 外盘 / 内盘 | 指数为 0，个股有值 |
 * | 9–18 | 买一~买五 价/量 | ETF/个股有值，指数为 0 |
 * | 19–28 | 卖一~卖五 价/量 | 同上 |
 * | 29 | 最近逐笔成交 | 实测为空 |
 * | 30 | 时间戳 `YYYYMMDDHHMMSS` | |
 * | 31 | 涨跌 | `3 − 4` |
 * | 32 | 涨跌% | `31 / 4` |
 * | 33 / 34 | 最高 / 最低 | 与 41 / 42 重复 |
 * | 35 | `最新价/成交量/成交额` 拼接 | 三段与 3、6、境外金额吻合 |
 * | 36 | 成交量（手） | 与 6 重复 |
 * | 37 | 成交额（万元） | `600519` 431602 万 = 4316023208 元 |
 * | 38 | 换手率（%） | |
 * | 39 | 市盈率（TTM） | 指数/个股合理，ETF 为空 |
 * | 40 | 空 | |
 * | 41 / 42 | 最高 / 最低 | 与 33 / 34 重复 |
 * | 43 | 振幅（%） | `(33 − 34)/4`，实测吻合 |
 * | 44 / 45 | 流通市值 / 总市值（亿） | 个股两者相等，指数不等 |
 * | 46 | 市净率 | |
 * | 47 / 48 | 涨停价 / 跌停价 | `4 × 1.1` / `4 × 0.9`；指数为 `-1`（哨兵） |
 * | 49 | 量比 | |
 * | 50 | 委差 | |
 * | 51 | 均价 | `37 × 10000 / (6 × 100)` 近似，实测吻合 |
 * | 52 / 53 | 市盈（动）/ 市盈（静） | 指数/ETF 为空 |
 * | 54–59 | 未核实 | 不解析 |
 * | 60 | 市场类别描述 | `"   A"` / `" "` |
 * | 61 | 品种类别 | `ZS` / `ETF` / `GP-A` |
 * | 62–87 | 未核实 | 不解析 |
 */
const QT_FIELD = {
  name: 1,
  code: 2,
  price: 3,
  previousClose: 4,
  open: 5,
  volume: 6,
  timestamp: 30,
  change: 31,
  changePercent: 32,
  high: 33,
  low: 34,
  amount: 37,
  turnoverRate: 38,
  peTtm: 39,
  amplitude: 43,
  floatMarketCap: 44,
  totalMarketCap: 45,
  pb: 46,
  limitUp: 47,
  limitDown: 48,
  volumeRatio: 49,
  averagePrice: 51,
  securityType: 61,
  bidPrice0: 9,
  askPrice0: 19,
} as const

/** 解析所需的最小字段数（最大访问到的位置 61，故需 62 个）。实测样本均为 88 个，留出增长余量。 */
const QT_MIN_FIELDS = QT_FIELD.securityType + 1

/** 请求的品种一个都没匹配上时，响应是这一行而不是任何 `v_<symbol>`。 */
const QT_NONE_MATCH = 'pv_none_match'

/**
 * 解析 `qt` 响应（**文本须已按 GBK 解码**——用 `decodeBody(bytes, 'gbk')` 或 `decodeGtimgBody`）。
 *
 * 响应每行形如 `v_sh000300="1~沪深300~000300~…";`；一次请求多个代码就是多行。
 * 仅返回**实际取到行情**的品种：不存在的代码被接口直接省略（`sh999999` 不产生任何行），
 * 一个都没匹配上时响应只有 `v_pv_none_match="1";`——这两种情况都返回空数组（是正常业务，
 * 不是解析失败）。**行形状不符才抛 `ParseError`**（Review Focus #2：结构变了不能伪装成空集合）。
 *
 * @throws {ParseError} 任一行不是 `v_xxx="…";` 的形状、字段数不足，或时间戳/数值格式不符
 */
export function parseQt(text: string): readonly Quote[] {
  const quotes: Quote[] = []
  let sawLine = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    sawLine = true
    const match = trimmed.match(/^v_([A-Za-z0-9_]+)="([\s\S]*)"\s*;$/)
    if (match === null) {
      throw new ParseError(`qt：响应行不是 v_xxx="…"; 的形状（结构已变）：${trimmed.slice(0, 60)}`)
    }
    const symbol = match[1]!
    if (symbol === QT_NONE_MATCH) continue
    quotes.push(parseQuoteLine(symbol, match[2]!))
  }
  if (!sawLine) throw new ParseError('qt：响应里没有任何 v_xxx 行（结构已变）')
  return quotes
}

function parseQuoteLine(symbol: string, value: string): Quote {
  const fields = value.split('~')
  if (fields.length < QT_MIN_FIELDS) {
    throw new ParseError(
      `qt：${symbol} 只有 ${fields.length} 个字段，少于解析所需的 ${QT_MIN_FIELDS}（结构已变）`,
    )
  }
  const at = (index: number): string => fields[index]!
  const num = (index: number, label: string): number | null =>
    qtNumber(at(index), `${symbol} ${label}`)
  // 涨停/跌停：指数的哨兵值是 -1，不能当成价格（-1 元）
  const priceOrNull = (index: number, label: string): number | null => {
    const n = num(index, label)
    return n !== null && n > 0 ? n : null
  }
  const level = (priceIndex: number): QuoteLevel => ({
    price: priceOrNull(priceIndex, `盘口价[${priceIndex}]`),
    volume: num(priceIndex + 1, `盘口量[${priceIndex + 1}]`) ?? 0,
  })
  return {
    symbol,
    name: at(QT_FIELD.name),
    code: at(QT_FIELD.code),
    price: num(QT_FIELD.price, '最新价'),
    previousClose: num(QT_FIELD.previousClose, '昨收'),
    open: num(QT_FIELD.open, '今开'),
    high: num(QT_FIELD.high, '最高'),
    low: num(QT_FIELD.low, '最低'),
    change: num(QT_FIELD.change, '涨跌'),
    changePercent: num(QT_FIELD.changePercent, '涨跌%'),
    volume: num(QT_FIELD.volume, '成交量'),
    amount: num(QT_FIELD.amount, '成交额'),
    turnoverRate: num(QT_FIELD.turnoverRate, '换手率'),
    amplitude: num(QT_FIELD.amplitude, '振幅'),
    volumeRatio: num(QT_FIELD.volumeRatio, '量比'),
    averagePrice: num(QT_FIELD.averagePrice, '均价'),
    peTtm: num(QT_FIELD.peTtm, '市盈率TTM'),
    pb: num(QT_FIELD.pb, '市净率'),
    totalMarketCap: num(QT_FIELD.totalMarketCap, '总市值'),
    floatMarketCap: num(QT_FIELD.floatMarketCap, '流通市值'),
    limitUp: priceOrNull(QT_FIELD.limitUp, '涨停价'),
    limitDown: priceOrNull(QT_FIELD.limitDown, '跌停价'),
    timestamp: parseQuoteTimestamp(at(QT_FIELD.timestamp), symbol),
    securityType: at(QT_FIELD.securityType),
    bids: [0, 1, 2, 3, 4].map((i) => level(QT_FIELD.bidPrice0 + i * 2)),
    asks: [0, 1, 2, 3, 4].map((i) => level(QT_FIELD.askPrice0 + i * 2)),
  }
}

/** `20261118161411` → `{ raw, date, time }`。形状不符即抛——静默产出坏时间戳比抛错危险。 */
function parseQuoteTimestamp(raw: string, label: string): QuoteTimestamp {
  if (!/^\d{14}$/.test(raw)) {
    throw new ParseError(`qt：${label} 的时间戳「${raw}」不是 14 位 YYYYMMDDHHMMSS`)
  }
  return {
    raw,
    date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
    time: `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`,
  }
}

/** `~` 字段数值：空串是「无此数据」返回 `null`；非空却读不出数抛 `ParseError`。允许负（涨跌等）。 */
function qtNumber(value: string, label: string): number | null {
  const text = value.trim()
  if (text === '') return null
  const num = Number(text)
  if (!Number.isFinite(num)) throw new ParseError(`qt：${label} 无法解析的数值「${value}」`)
  return num
}

// ---------------------------------------------------------------------------
// fqkline：日 K 线
// ---------------------------------------------------------------------------

export type FqklineQuery = {
  /** 市场+代码，如 `sh000300` */
  readonly symbol: string
  /** 周期，实测支持 `day` / `week` / `month`；默认 `day` */
  readonly period?: string
  /** 起始日 `YYYY-MM-DD`，含；可省（留空） */
  readonly start?: string
  /** 截止日 `YYYY-MM-DD`，含；可省（留空） */
  readonly end?: string
  /** 返回的最大条数（取区间内**最后** N 条）；默认 20 */
  readonly count?: number
  /** 复权方式 `qfq`（前复权）/ `hfq`（后复权）/ `''`（不复权）；默认 `qfq` */
  readonly adjust?: string
}

/**
 * 构造 `fqkline/get` 请求。`param` 是逗号分隔的**定长**位置参数：`{市场}{代码},{周期},{起},{止},{数量},{复权}`。
 * 本端点**不需要任何请求头**。
 */
export function fqklineRequest(query: FqklineQuery): HttpRequestSpec {
  const param = [
    query.symbol,
    query.period ?? 'day',
    query.start ?? '',
    query.end ?? '',
    String(query.count ?? 20),
    query.adjust ?? 'qfq',
  ].join(',')
  return { url: `${FQKLINE_ENDPOINT}?param=${param}` }
}

/**
 * 一根 K 线。**数组顺序是 `[date, open, close, high, low, volume]`——`close` 在第 3 位，不是常见 OHLC 顺序**。
 * 照抄 OHLC 会把开、收对调，价格全错且看不出来。
 */
export type KlineBar = {
  /** 交易日 `YYYY-MM-DD`（业务日期，非行情时间戳） */
  readonly date: string
  readonly open: number
  readonly close: number
  readonly high: number
  readonly low: number
  /** 成交量（手）；接口原文，未换算 */
  readonly volume: number
}

/** 一个品种的 K 线序列。 */
export type DailyKline = {
  readonly symbol: string
  /** 响应里承载 K 线的键：**实测指数是 `day`、个股/ETF 是 `qfqday`**（有复权数据才带前缀），不是固定 `day` */
  readonly dataKey: string
  /** 周期：由 `dataKey` 去掉复权前缀得到（`day` / `week` / `month`） */
  readonly period: string
  /** 复权方式：`qfq` / `hfq`；无前缀（如指数）为 `null` */
  readonly adjust: string | null
  /** K 线，按接口顺序（升序） */
  readonly bars: readonly KlineBar[]
}

const fqklineSchema = z.object({
  data: z.record(z.string(), z.record(z.string(), z.unknown())),
})

/** 承载 K 线的键：`day`/`week`/`month`，可选带 `qfq`/`hfq` 前缀。 */
const KLINE_KEY = /^(hfq|qfq)?(day|week|month)$/

/** 一根 K 线的原始单元：接口一律给字符串（成交量可能带 `.000`）。 */
const barRowSchema = z.array(z.union([z.string(), z.number()]))

type FqklineEnvelope = z.output<typeof fqklineSchema>

/**
 * 校验 `fqkline` 的信封，返回 `data`。
 *
 * **只查 `code` 不够**：实测 `param` 格式错时 `code:1`，而代码/市场不识别时是
 * `code:0` + `msg:"param error"` + `data:[]`。故两者都要看（Review Focus #1）。
 *
 * @throws {ParseError} 响应不是 JSON 对象、缺 `code`、`data` 不是对象
 * @throws {BusinessCodeError} `code` 非 0，或 `code` 为 0 但 `msg` 非空（如 `param error`）
 */
function assertFqklineOk(text: string): FqklineEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new ParseError('fqkline：响应不是合法 JSON', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ParseError('fqkline：响应不是 JSON 对象')
  }
  const { code, msg } = parsed as { code?: unknown; msg?: unknown }
  if (typeof code !== 'number') throw new ParseError('fqkline：响应缺少 code 字段（结构已变）')
  const message = typeof msg === 'string' ? msg : ''
  if (code !== 0) {
    throw new BusinessCodeError(`fqkline 业务码 ${code}：${message || '（msg 为空）'}`)
  }
  if (message !== '') {
    throw new BusinessCodeError(
      `fqkline 顶层 msg 非空「${message}」——实测 code 为 0 也可能是失败（如 param error），` +
        `HTTP 200 不代表成功`,
    )
  }
  // 失败时接口给 `data:[]`（数组）。显式拦下：Zod 的 record 对数组的处置不保证，
  // 放过它会得到「空结果」而不是「解析失败」——那正是最危险的静默错值。
  if (Array.isArray((parsed as { data?: unknown }).data)) {
    throw new ParseError('fqkline：data 是数组而不是对象（结构已变或响应为错误页）')
  }
  const result = fqklineSchema.safeParse(parsed)
  if (!result.success) {
    throw new ParseError(`fqkline：data 结构不符预期 —— ${result.error.message}`)
  }
  return result.data
}

/**
 * 解析 `fqkline` 响应，返回 **`data` 里每个品种**的 K 线（本端点一次请求一个代码，通常是 1 个）。
 *
 * 代码不存在时接口给的是**空数组**而非错误（实测 `sh999999` → `code:0`、`data.sh999999.day:[]`），
 * 故「不存在」与「该区间无数据」在响应里分不开，两者都返回 `bars: []`——能力层需自行留意。
 *
 * @throws {BusinessCodeError} 顶层业务码/`msg` 表示失败
 * @throws {ParseError} 结构不符、找不到 K 线键，或任一根 K 线的字段/日期格式不符
 */
export function parseFqkline(text: string): readonly DailyKline[] {
  const envelope = assertFqklineOk(text)
  return Object.entries(envelope.data).map(([symbol, node]) => parseSymbolKline(symbol, node))
}

function parseSymbolKline(symbol: string, node: Record<string, unknown>): DailyKline {
  const dataKey = Object.keys(node).find((key) => KLINE_KEY.test(key))
  if (dataKey === undefined) {
    throw new ParseError(
      `fqkline：${symbol} 下找不到 K 线键（预期形如 day / qfqday，实际键：${Object.keys(node).join(', ')}）`,
    )
  }
  const rows = parseShape(barRowSchema.array(), node[dataKey], `fqkline ${symbol}.${dataKey}`)
  const matched = KLINE_KEY.exec(dataKey)!
  return {
    symbol,
    dataKey,
    period: matched[2]!,
    adjust: matched[1] ?? null,
    bars: rows.map((row, index) => parseBar(row, `${symbol}.${dataKey}[${index}]`)),
  }
}

/** 一根 K 线：`[date, open, close, high, low, volume, …]`。**第三位是收盘价**，见 `KlineBar`。 */
function parseBar(row: readonly (string | number)[], label: string): KlineBar {
  if (row.length < 6) {
    throw new ParseError(`fqkline ${label}：K 线行只有 ${row.length} 个元素，少于 6（结构已变）`)
  }
  const date = String(row[0])
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ParseError(`fqkline ${label}：日期「${date}」不是 YYYY-MM-DD`)
  }
  return {
    date,
    open: barNumber(row[1]!, `${label} open`),
    close: barNumber(row[2]!, `${label} close`),
    high: barNumber(row[3]!, `${label} high`),
    low: barNumber(row[4]!, `${label} low`),
    volume: barNumber(row[5]!, `${label} volume`),
  }
}

function barNumber(value: string | number, label: string): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) throw new ParseError(`fqkline ${label}：无法解析的数值「${value}」`)
  return num
}

/** 局部复制的结构校验（f10 的 `parseShape` 未导出，各端点模块各自持有，避免跨模块依赖）。 */
function parseShape<S extends z.ZodType>(schema: S, value: unknown, label: string): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new ParseError(`${label}：结构不符预期 —— ${result.error.message}`)
  }
  return result.data
}
