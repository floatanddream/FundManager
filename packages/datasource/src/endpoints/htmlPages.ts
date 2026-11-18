/**
 * `fundf10.eastmoney.com` 的两个**服务端渲染 HTML 页**：`jbgk_{code}.html`（基金概况）与
 * `fhsp_{code}.html`（分红 + 份额折算）。
 *
 * 与 `api.fund` / `fundmobapi` 那些 JSON 端点不同，这两页**没有业务码**——HTTP 200 就是页面本身，
 * 页面上也没有 `ErrCode` 可校验。故失败只可能是「页面结构变了」，解析器一律抛 `ParseError`
 * （Review Focus #2：结构不符**绝不**退化成空集合或空串，那会让用户看到「这只基金没有分红」）。
 *
 * 两页都**不需要任何请求头**（实测不带 Referer 也 200），UTF-8，静态。
 *
 * 见 `docs/research/2026-11-18-datasource-inventory.md` §1.3（jbgk）、§1.6（fhsp）、
 * §6 #14（两张表 / 数值内嵌中文）、#16（`<th>` 定位）、#18（联接基金的“股票仓位”是障眼法）。
 */
import type { HttpRequestSpec } from '../http/client.ts'
import { ParseError } from '../http/errors.ts'

const F10_PAGE_ORIGIN = 'https://fundf10.eastmoney.com'

// ---------------------------------------------------------------------------
// jbgk：基金概况（业绩比较基准 / 跟踪标的）
// ---------------------------------------------------------------------------

/** 构造 `jbgk_{code}.html` 请求。本端点**不需要任何请求头**。 */
export function jbgkRequest(fundCode: string): HttpRequestSpec {
  return { url: `${F10_PAGE_ORIGIN}/jbgk_${fundCode}.html` }
}

/** 基金概况页。 */
export type FundProfilePage = {
  /**
   * `业绩比较基准` **原文**（含权重），如
   * `中证800成长指数收益率*70%+中债-综合全价(总值)指数收益率*30%`。
   *
   * **有效暴露取自它，不是「股票仓位」字段**（`CONSTRAINTS/04-hard-rules.md` §4 规则 5）：
   * 实测联接基金 `011609` 的股票仓位只有 0.41%，而基准给出 95%——字面代入前者会得出荒谬结果。
   * 本层**不解析**基准里的权重（口径与拆分方式未核实），只把原文交出去。
   */
  readonly benchmark: string
  /**
   * `跟踪标的` **原文**。主动基金实测是「该基金无跟踪标的」这类文案，**如实返回**——
   * 「无跟踪标的」本身是有效信息（`§4 规则 4`：无跟踪标的的基金不产出行业归因），
   * 不能折成 `null`，否则与「这页没抓到」分不开。
   */
  readonly trackingTarget: string
  /**
   * 概况表其余字段的**原文**（标签 → 值），如「基金简称」「管理费率」「净资产规模」。
   * 这些值的口径未逐项核实（「1.20%（每年）」「29.19亿元（截止至：2026年09月30日）」都是
   * 中文与数字混排），本层**不拆**——拆错了就是账错，原样保留可回溯。
   *
   * `业绩比较基准` 与 `跟踪标的` 也在这里（表中原文），上面两个字段是它们的必须存在性保证。
   */
  readonly fields: Readonly<Record<string, string>>
}

/**
 * 解析 `jbgk_{code}.html`。
 *
 * @throws {ParseError} 找不到含「业绩比较基准 / 跟踪标的」的概况表，或这两项缺失/为空
 */
export function parseJbgk(text: string): FundProfilePage {
  const fields = parseThTdPairs(findProfileTable(text))
  const benchmark = fields['业绩比较基准']
  const trackingTarget = fields['跟踪标的']
  if (benchmark === undefined || benchmark === '') {
    throw new ParseError('jbgk：概况表里「业绩比较基准」缺失或为空（结构已变）')
  }
  if (trackingTarget === undefined || trackingTarget === '') {
    throw new ParseError('jbgk：概况表里「跟踪标的」缺失或为空（结构已变）')
  }
  return { benchmark, trackingTarget, fields }
}

/**
 * 取出概况表：文档里**同时**含「业绩比较基准」与「跟踪标的」两张标签的那个 `<table>`。
 *
 * 不能按 `class="info w790"` 定位——类名是页面样式，改版会变，而这两个标签才是这一页存在的理由。
 * 也要**限定在表内**：侧边栏导航也用 `<th>`（`<th class="nowrap"><h3>热点推荐</h3>…`），
 * 不限定的话那些噪音会混进 `fields`。
 */
function findProfileTable(html: string): string {
  const tables = html.match(/<table[^>]*>[\s\S]*?<\/table>/g) ?? []
  const table = tables.find((t) => t.includes('>业绩比较基准<') && t.includes('>跟踪标的<'))
  if (table === undefined) {
    throw new ParseError('jbgk：文档里找不到含「业绩比较基准 / 跟踪标的」的概况表（结构已变）')
  }
  return table
}

/**
 * 抽出一个表里**所有** `<th>标签</th>` → 其后第一个 `<td>` 的文本。
 *
 * **必须按 `<th>` 文本定位，不能按行取**：实测同一 `<tr>` 里夹着两组（「业绩比较基准」与
 * 「跟踪标的」同行），按行取只能拿到其中一组。
 *
 * 值的右边界要卡在**下一个 `<th>`**，而不是只看 `</td>`：实测部分行的 `<td>` **根本没有闭合**
 * （`<td>000001（前端）、000002（后端）<th>基金类型</th>`）——只认 `</td>` 会取不到值，
 * 或者把下一组的标签一起吃进来。
 */
function parseThTdPairs(tableHtml: string): Record<string, string> {
  const ths = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
  const fields: Record<string, string> = {}
  ths.forEach((th, index) => {
    const label = htmlText(th[1]!)
    if (label === '') return
    const start = th.index + th[0].length
    const end = index + 1 < ths.length ? ths[index + 1]!.index : tableHtml.length
    // 表头 `<th>` 后面没有值，跳过；否则 `<td ...>` 到 `</td>` 或到下一个 `<th>` 为止
    const cell = tableHtml.slice(start, end).match(/<td[^>]*>([\s\S]*?)(?:<\/td>|$)/)
    if (cell === null) return
    fields[label] = htmlText(cell[1]!)
  })
  return fields
}

// ---------------------------------------------------------------------------
// fhsp：分红 + 份额折算（两张不同 class 的表）
// ---------------------------------------------------------------------------

/** 构造 `fhsp_{code}.html` 请求。本端点**不需要任何请求头**。 */
export function fhspRequest(fundCode: string): HttpRequestSpec {
  return { url: `${F10_PAGE_ORIGIN}/fhsp_${fundCode}.html` }
}

/** 一笔分红（`table.cfxq` 的一行）。 */
export type DividendRecord = {
  /** 年份（表里写作 `2025年`，取数字部分） */
  readonly year: number
  /** 权益登记日，`YYYY-MM-DD`；缺失为 `null` */
  readonly recordDate: string | null
  /** 除息日，`YYYY-MM-DD`；缺失为 `null` */
  readonly exDate: string | null
  /**
   * 每 10 份分红（元），从「每10份派现金0.1000元」里抽出。
   * **量纲是「元 / 10 份」**——与拆分比例（`SplitRecord.ratio`）不是一个东西，不可互相代入。
   */
  readonly per10Units: number
  /** 分红发放日，`YYYY-MM-DD`；缺失为 `null` */
  readonly payDate: string | null
}

/** 一笔份额拆分/折算（`table.fhxq` 的一行）。 */
export type SplitRecord = {
  /** 年份 */
  readonly year: number
  /** 拆分折算日，`YYYY-MM-DD`；缺失为 `null` */
  readonly splitDate: string | null
  /** 拆分类型原文，如「份额折算」 */
  readonly kind: string
  /**
   * 拆分折算比例，从 `1:0.3709` 里抽出。**无量纲，不是金额**——`510300` 实测
   * 「份额折算 1:0.3709」会改变份额数（用户无操作，份额也会变），这正是账本要支持 `split` 的原因。
   */
  readonly ratio: { readonly from: number; readonly to: number }
}

/** `fhsp_{code}.html` 的全部事件。 */
export type DividendSplitPage = {
  readonly dividends: readonly DividendRecord[]
  readonly splits: readonly SplitRecord[]
}

/**
 * 解析 `fhsp_{code}.html`。
 *
 * 分红与拆分是**两张 class 不同的表**（`table.cfxq` / `table.fhxq`，列数 5 / 4），
 * 必须分开解析——按一张表取会把「每10份分红」与「拆分比例」串成同列。
 *
 * 表内是「暂无分红信息!」这类 `colspan` 占位行时返回**空数组**（该基金确实没有该类事件，
 * 是正常业务，不是解析失败）；表本身或表头 `<th>` 不见了才抛 `ParseError`。
 *
 * @throws {ParseError} 缺表、缺 `<thead>`/`<th>`、表头列数不符，或数据行的列数/字段格式不符
 */
export function parseFhsp(text: string): DividendSplitPage {
  return {
    dividends: parseDividendTable(findClassTable(text, 'cfxq')),
    splits: parseSplitTable(findClassTable(text, 'fhxq')),
  }
}

/** 首页实测（`000001`）该表的列数与表头，列数不符即结构已变。 */
const DIVIDEND_COLUMNS = 5
const SPLIT_COLUMNS = 4

function parseDividendTable(tableHtml: string): readonly DividendRecord[] {
  return parseDataRows(tableHtml, 'table.cfxq', DIVIDEND_COLUMNS).map((cells, index) => {
    const label = `fhsp 分红表第 ${index + 1} 行`
    return {
      year: parseYear(cells[0]!, label),
      recordDate: parseDateCell(cells[1]!, `${label} 权益登记日`),
      exDate: parseDateCell(cells[2]!, `${label} 除息日`),
      per10Units: parsePer10Units(cells[3]!, `${label} 每10份分红`),
      payDate: parseDateCell(cells[4]!, `${label} 分红发放日`),
    }
  })
}

function parseSplitTable(tableHtml: string): readonly SplitRecord[] {
  return parseDataRows(tableHtml, 'table.fhxq', SPLIT_COLUMNS).map((cells, index) => {
    const label = `fhsp 拆分表第 ${index + 1} 行`
    return {
      year: parseYear(cells[0]!, label),
      splitDate: parseDateCell(cells[1]!, `${label} 拆分折算日`),
      kind: cells[2]!,
      ratio: parseRatio(cells[3]!, `${label} 拆分折算比例`),
    }
  })
}

/** 按 class 定位表；类名是页面样式，改了就只能抛——但总比把别的表当数据表强。 */
function findClassTable(html: string, className: string): string {
  const pattern = new RegExp(
    `<table[^>]*class=['"][^'"]*\\b${className}\\b[^'"]*['"][^>]*>[\\s\\S]*?</table>`,
  )
  const match = html.match(pattern)
  if (match === null) throw new ParseError(`fhsp：找不到 ${className} 表（结构已变）`)
  return match[0]
}

/**
 * 取一张事件表的全部数据行，每行是一个已剥标签的单元格数组。
 *
 * 表头 `<th>` 必须存在且列数正确——这是「表格结构还在」的唯一可校验信号。至于数据行的
 * `colspan` 占位行（「暂无分红信息!」）**跳过而不是抛**：那是「该基金没有这类事件」的正常表达。
 */
function parseDataRows(
  tableHtml: string,
  scene: string,
  columns: number,
): readonly (readonly string[])[] {
  const thead = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/)?.[1]
  if (thead === undefined) throw new ParseError(`fhsp ${scene}：表里没有 <thead>（结构已变）`)
  const headerCells = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
  if (headerCells.length !== columns || htmlText(headerCells[0]![1]!) !== '年份') {
    throw new ParseError(
      `fhsp ${scene}：表头 ${headerCells.length} 列且首列为「${htmlText(headerCells[0]?.[1] ?? '')}」` +
        `，与预期的 ${columns} 列（首列「年份」）不符（结构已变）`,
    )
  }
  const tbody = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]
  if (tbody === undefined) throw new ParseError(`fhsp ${scene}：表里没有 <tbody>（结构已变）`)

  const rows: string[][] = []
  for (const rowHtml of tbody.split('</tr>')) {
    if (!/<td/.test(rowHtml)) continue
    // 占位行是整行跨列的一句「暂无分红信息!」/「暂无拆分信息!」，不是数据
    if (/colspan/i.test(rowHtml)) continue
    const cells = cellsOf(rowHtml)
    if (cells.length !== columns) {
      throw new ParseError(`fhsp ${scene}：数据行 ${cells.length} 列，与表头 ${columns} 列不符`)
    }
    rows.push(cells)
  }
  return rows
}

/** `2025年` → `2025`；不是这个形状说明行的结构变了。 */
function parseYear(value: string, label: string): number {
  const match = value.match(/^(\d{4})年$/)
  if (match === null) throw new ParseError(`${label}：年份「${value}」不是「YYYY年」的形状`)
  return Number(match[1])
}

/** 日期单元格：空 / `---` 记 `null`（**数据缺失**），非空则必须是 `YYYY-MM-DD`（否则是格式变了）。 */
function parseDateCell(value: string, label: string): string | null {
  if (value === '' || value === '---' || value === '--') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ParseError(`${label}：日期「${value}」不是 YYYY-MM-DD`)
  }
  return value
}

/** 从「每10份派现金0.1000元」里抽金额。抽不出即抛——给 `null` 会让分红静默变成 0 元。 */
function parsePer10Units(value: string, label: string): number {
  const match = value.match(/每10份派现金([0-9]+(?:\.[0-9]+)?)元/)
  if (match === null) throw new ParseError(`${label}：「${value}」里抽不出每 10 份分红金额`)
  return Number(match[1])
}

/** 从 `1:0.3709` 里抽比例的两端。两端都保留，**不做除法**——折算方向由调用方按语义决定。 */
function parseRatio(value: string, label: string): { from: number; to: number } {
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)\s*:\s*([0-9]+(?:\.[0-9]+)?)$/)
  if (match === null) throw new ParseError(`${label}：「${value}」不是「A:B」的比例形状`)
  return { from: Number(match[1]), to: Number(match[2]) }
}

// ---------------------------------------------------------------------------
// 共用：HTML 单元格
// ---------------------------------------------------------------------------

/** 按出现顺序取出一个 `<tr>` 里所有 `<td>` 的纯文本。 */
function cellsOf(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => htmlText(m[1]!))
}

/** 单元格纯文本：剥掉内层标签（值里有 `<a>` / `<span>`）、还原常见实体、去首尾空白。 */
function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}
