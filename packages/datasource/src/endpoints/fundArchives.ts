/**
 * `fundf10.eastmoney.com/FundArchivesDatas.aspx` 端点族：URL 构造 + 解析纯函数。
 *
 * 两个 `type`：
 * - `type=jjcc` 基金持仓（股票投资明细，**按期**），响应变量 `var apidata = { content: "<div…HTML…>", … }`
 * - `type=gmbd` 规模/份额时序，响应变量 **`var gmbd_apidata = { content: "<table…>", … }`**（**不是** `apidata`）
 *
 * 两者形态相同：**一个 JS 变量包着一段 HTML**。故解析必须先在 `node:vm` 沙箱里求值
 * （**禁止 `eval`**，见 `AGENTS.md`），再从 `content` 里抽取 HTML 表格。
 *
 * 两者都**必需 `Referer`**，但失败形态与 `api.fund/f10/*` 不同：缺 Referer 时返回
 * **HTTP 404 + 反爬/404 HTML 页**（`<!DOCTYPE html …>`），**不是** 200 + 业务码 JSON。
 * 故解析器若收到的是 HTML，`node:vm` 求值即抛，这里转为 `ParseError`（**不是** `BusinessCodeError`）。
 *
 * 见 `docs/research/2026-11-18-datasource-inventory.md` §1.4（jjcc）、§1.5（gmbd）、§6 #4/#5/#6。
 * 本次实现期对 §1.4 的实测修正写在 `jjccRequest` 与 `readIsFullPortfolio` 的注释里。
 */
import vm from 'node:vm'

import type { HttpRequestSpec } from '../http/client.ts'
import { ParseError } from '../http/errors.ts'

const ARCHIVES_ORIGIN = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx'
const F10_PAGE_ORIGIN = 'https://fundf10.eastmoney.com'

/**
 * 两个端点共用的请求头。
 *
 * `Referer` 是**唯一必需**的头，且**只校验到 host 一级**——实测任何 `fundf10.eastmoney.com/*`
 * 路径都放行，换成别站 host 即 404。缺了不通 4xx 之外的提示，返回的是 HTTP **404** +
 * 一段 `<!DOCTYPE html…>` 反爬页，故不能用状态码之外的东西去「认领」它。
 */
function archivesHeaders(page: string, fundCode: string): Record<string, string> {
  return { Referer: `${F10_PAGE_ORIGIN}/${page}_${fundCode}.html` }
}

/** 按固定顺序拼查询串，使 URL 与实测抓取命令一致（`URLSearchParams` 保留插入顺序）。 */
function archivesUrl(params: readonly [string, string][]): string {
  return `${ARCHIVES_ORIGIN}?${new URLSearchParams(params)}`
}

// ---------------------------------------------------------------------------
// jjcc：基金持仓（按期）
// ---------------------------------------------------------------------------

export type JjccQuery = {
  readonly fundCode: string
  /** 报告年份。响应含该年的**全部季度块**（实测 `year=2026` → 1/2/3 季度合并在一个响应里） */
  readonly year: number
  /**
   * 每块最多返回的持仓行数，默认 10。
   *
   * **注意**：实测**不传 `topline` 会返回表头而没有一行数据**（不是「不限」），故默认必须给。
   * 且它并非季报专属——见 `month`。
   */
  readonly topline?: number
  /**
   * 报告期月份（3/6/9/12），对应 F10 页面上选中的报告期。
   *
   * **实测修正盘点 §1.4「`month` 被忽略」——不成立。** `month` 决定**响应里哪个报告期块返回全部持仓**：
   * 命中 6（半年报，06-30）或 12（年报，12-31）时，**只有该期块**返回全量持仓，其余半年报/年报块
   * 仍受 `topline` 截断；季报块只有前十大，`month` 命中与否都一样只有 10 行。
   */
  readonly month?: number
}

/** 构造 `FundArchivesDatas.aspx?type=jjcc` 请求。 */
export function jjccRequest(query: JjccQuery): HttpRequestSpec {
  const params: [string, string][] = [
    ['type', 'jjcc'],
    ['code', query.fundCode],
    ['topline', String(query.topline ?? 10)],
    ['year', String(query.year)],
  ]
  if (query.month !== undefined) params.push(['month', String(query.month)])
  return { url: archivesUrl(params), headers: archivesHeaders('ccmx', query.fundCode) }
}

/** 一行持仓。 */
export type HoldingRow = {
  /** 序号 */
  readonly rank: number
  /** 股票代码 */
  readonly stockCode: string
  /** 股票名称 */
  readonly stockName: string
  /** 占净值比例（%，**已去 `%` 号但不 /100**，与 f10 族一致）；空 `td` 为 `null` */
  readonly navRatio: number | null
  /** 持股数（万股） */
  readonly shares: number | null
  /** 持仓市值（万元） */
  readonly marketValue: number | null
}

/** 一个报告期的持仓。 */
export type HoldingPeriod = {
  /** 报告期（`截止至：`），`YYYY-MM-DD` */
  readonly reportDate: string
  /**
   * 该期是否**完整持仓**（相对「仅前十大」）。
   *
   * 判据是块尾的展开/收起链接文案（见 `readIsFullPortfolio`），**不是报告期类型**——
   * 因为半年报/年报块同样可能被 `topline` 截断，只认报告期会**高估**（把截断当全量）。
   */
  readonly isFullPortfolio: boolean
  /** 该报告期的持仓行，按接口返回顺序（降序） */
  readonly holdings: readonly HoldingRow[]
}

/**
 * 解析 `type=jjcc` 的一个响应，返回其中**每个报告期块**。
 *
 * 一个响应含**多个报告期**（实测 `year=2026` → 3 个块），故必须**按块切分后再取表**，
 * 不能把多个报告期的行混成一个列表。
 *
 * **「结构完好但没有报告期块」返回空列表，不是错误**：接口对尚无报告期的年份
 * （实测 `year=1990`）返回 `content:""`——那是「该年还没披露」这一**正常业务结果**，
 * 不是结构变了。**只有认不出结构时才抛**（`readJsContent` 的三关：响应是可执行 JS、
 * 有 `apidata` 变量、`content` 是字符串）。把「无数据」也做成错误，会逼上层靠错误消息
 * 去辨认它，那才是脆的。
 *
 * @returns 各报告期块；该年一个报告期块都没有时为空数组
 * @throws {ParseError} 响应不是可识别的 jjcc 结构（非可执行 JS／缺 `apidata`／`content` 非字符串／
 *   某块缺报告期或缺表格）
 */
export function parseJjcc(text: string): readonly HoldingPeriod[] {
  const content = readJsContent(text, 'apidata', 'jjcc')
  const blocks = content.split("<h4 class='t'>").slice(1)
  return blocks.map((block, index) => parseHoldingPeriod(block, index))
}

/** 解析单个报告期块（`<h4 class='t'>` 到下一个 `<h4>` 之间）。 */
function parseHoldingPeriod(block: string, index: number): HoldingPeriod {
  const label = `jjcc 第 ${index + 1} 个报告期块`
  const tbody = block.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]
  if (tbody === undefined) throw new ParseError(`${label}：找不到持仓表 <tbody>`)
  const holdings = tbody
    .split('</tr>')
    .filter((row) => /<td/.test(row))
    .map((row) => parseHoldingRow(row, label))
  if (holdings.length === 0) throw new ParseError(`${label}：持仓表里没有任何数据行`)
  return {
    reportDate: readReportDate(block, label),
    isFullPortfolio: readIsFullPortfolio(block),
    holdings,
  }
}

/**
 * 识别块尾的展开/收起链接，判断该期是否为**完整持仓**。
 *
 * 这是响应里**唯一**能区分「全量」与「被 `topline` 截断」的信号（实测）：
 * - `收起持仓明细>>` → 该期已含全部持仓（`topline` 命中或该期本就不受限于它）
 * - `显示全部持仓明细>>` → 该期**被截断**，点开才加载全量
 * - **季报块根本没有这个链接**（季报本就只披露前十大，接口不提供更多）
 *
 * 只认「收起」为真；文案变化时退化为「非全量」，方向上是安全的（**宁可说前十大，不可把截断当全量**）。
 */
function readIsFullPortfolio(block: string): boolean {
  const tfoot = block.match(/<div class='tfoot'>[\s\S]*?<\/div>/)?.[0] ?? ''
  return tfoot.includes('收起')
}

/** `2026年3季度` 这类标题里的季度 → 报告期末日；仅当块内没有 `截止至：` 时兜底用。 */
const QUARTER_END: Readonly<Record<string, string>> = {
  '1': '03-31',
  '2': '06-30',
  '3': '09-30',
  '4': '12-31',
}

/**
 * 取报告期：优先块内 `截止至：<font>YYYY-MM-DD</font>`（精确日期），
 * 缺失时退回标题 `20XX年N季度` 推算（同一报告期，只是日期由季度推得）。
 */
function readReportDate(block: string, label: string): string {
  const explicit = block.match(/截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/)?.[1]
  if (explicit !== undefined) return explicit
  const title = block.match(/(\d{4})年([1-4])季度/)
  if (title !== null) {
    const end = QUARTER_END[title[2]!]!
    return `${title[1]}-${end}`
  }
  throw new ParseError(`${label}：识别不出报告期（既无「截止至」也无「N季度」标题）`)
}

/**
 * 解析一行持仓。
 *
 * **不能按固定列位取「占净值比例」**：实测当前季度块每行 9 个 `<td>`（含「最新价/涨跌幅/相关资讯」），
 * 而历史报告块只有 7 个 `<td>`——那三列**整列不存在**，故「占净值比例」在后者是第 5 列、在前者是第 7 列。
 * 唯一稳定的不变式是：**序号/代码/名称在最前 3 列，占净值比例/持股数/持仓市值在最后 3 列**。
 */
function parseHoldingRow(rowHtml: string, label: string): HoldingRow {
  const tds = cells(rowHtml)
  if (tds.length < 6) {
    throw new ParseError(
      `${label}：持仓行只有 ${tds.length} 个 <td>，少于序号/代码/名称 + 三个指标段`,
    )
  }
  const rank = Number(tds[0])
  if (!Number.isInteger(rank)) throw new ParseError(`${label}：持仓行序号「${tds[0]}」不是整数`)
  const at = (offset: number): string => tds[tds.length - offset]!
  return {
    rank,
    stockCode: tds[1]!,
    stockName: tds[2]!,
    navRatio: parseCellNumber(at(3), `${label} 占净值比例`),
    shares: parseCellNumber(at(2), `${label} 持股数`),
    marketValue: parseCellNumber(at(1), `${label} 持仓市值`),
  }
}

// ---------------------------------------------------------------------------
// gmbd：规模/份额时序
// ---------------------------------------------------------------------------

export type GmbdQuery = {
  readonly fundCode: string
  /** 页码，默认 1；实测 `page=1` 即返回季度全历史（100 行，2001-12-18 → 2026-09-30），未见分页 */
  readonly page?: number
}

/** 构造 `FundArchivesDatas.aspx?type=gmbd` 请求。 */
export function gmbdRequest(query: GmbdQuery): HttpRequestSpec {
  return {
    url: archivesUrl([
      ['type', 'gmbd'],
      ['code', query.fundCode],
      ['page', String(query.page ?? 1)],
    ]),
    headers: archivesHeaders('gmbd', query.fundCode),
  }
}

/**
 * 一行规模/份额（表头：日期 / 期间申购（亿份）/ 期间赎回（亿份）/ 期末总份额（亿份）/ 期末净资产（亿元）/ 净资产变动率）。
 *
 * 单位沿用接口原样（亿份 / 亿元），**不做换算**；缺失值为 `null`（接口用 `---` 占位）。
 */
export type ScaleShareRow = {
  /** 报告期（`日期`），`YYYY-MM-DD` */
  readonly reportDate: string
  /** 期间申购（亿份） */
  readonly purchase: number | null
  /** 期间赎回（亿份） */
  readonly redemption: number | null
  /** 期末总份额（亿份） */
  readonly totalShares: number | null
  /** 期末净资产（亿元） */
  readonly netAsset: number | null
  /** 净资产变动率（%，已去 `%` 号但不 /100） */
  readonly navChangeRate: number | null
}

/**
 * 解析 `type=gmbd`。返回**按接口顺序**（最新在前）的全部季度行。
 *
 * 只解析 `content` 里的 HTML 表。响应里另有一个 `data` 结构化数组，但其字段语义在同一响应内不一致
 * （近期行的期末净资产在 `NETNAV`、老行在 `QMJZC`），且中文口径只有表头写得明白，故**不解析 `data`**、不猜字段。
 *
 * @throws {ParseError} 响应不是可执行 JS、缺变量/`content`、缺表格或表为空
 */
export function parseGmbd(text: string): readonly ScaleShareRow[] {
  const content = readJsContent(text, 'gmbd_apidata', 'gmbd')
  const tbody = content.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]
  if (tbody === undefined) throw new ParseError('gmbd：找不到规模份额表 <tbody>（结构已变）')
  const rows = tbody
    .split('</tr>')
    .filter((row) => /<td/.test(row))
    .map((row) => parseScaleShareRow(row))
  if (rows.length === 0) throw new ParseError('gmbd：规模份额表里没有任何数据行')
  return rows
}

function parseScaleShareRow(rowHtml: string): ScaleShareRow {
  const tds = cells(rowHtml)
  if (tds.length !== 6) {
    throw new ParseError(`gmbd：规模份额行有 ${tds.length} 个 <td>，与表头 6 列不符`)
  }
  return {
    reportDate: tds[0]!,
    purchase: parseCellNumber(tds[1]!, 'gmbd 期间申购'),
    redemption: parseCellNumber(tds[2]!, 'gmbd 期间赎回'),
    totalShares: parseCellNumber(tds[3]!, 'gmbd 期末总份额'),
    netAsset: parseCellNumber(tds[4]!, 'gmbd 期末净资产'),
    navChangeRate: parseCellNumber(tds[5]!, 'gmbd 净资产变动率'),
  }
}

// ---------------------------------------------------------------------------
// 共用：JS 变量 + HTML 单元格
// ---------------------------------------------------------------------------

/** 沙箱执行上限（ms）。响应约 45–60 KB 且结构简单，5 s 足以兜住异常输入。 */
const SANDBOX_TIMEOUT_MS = 5000

/** 在 `node:vm` 沙箱里执行响应脚本，返回 contextified 对象（`var` 声明会变成它的属性）。 */
function runAssignmentScript(text: string, scene: string): Record<string, unknown> {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const sandbox: Record<string, unknown> = {}
  vm.createContext(sandbox)
  try {
    vm.runInContext(source, sandbox, { timeout: SANDBOX_TIMEOUT_MS, filename: 'fundArchives.js' })
  } catch (cause) {
    throw new ParseError(
      `${scene}：响应不是可执行的 JS 赋值脚本（结构已变，或缺 Referer 返回了反爬 HTML 页）`,
      { cause },
    )
  }
  return sandbox
}

/**
 * 求值响应脚本并取出 `<varName>.content` 字符串。
 *
 * 变量名**必须逐个传**：`jjcc` 是 `apidata`、`gmbd` 是 `gmbd_apidata`，写死一个会在另一个上静默失败。
 */
function readJsContent(text: string, varName: string, scene: string): string {
  const sandbox = runAssignmentScript(text, scene)
  const holder = sandbox[varName]
  if (typeof holder !== 'object' || holder === null) {
    throw new ParseError(`${scene}：响应缺少变量 ${varName}（结构已变）`)
  }
  const content = (holder as { content?: unknown }).content
  if (typeof content !== 'string') {
    throw new ParseError(`${scene}：${varName}.content 不是字符串（结构已变）`)
  }
  return content
}

/** 按出现顺序取出一个 `<tr>` 里所有 `<td>` 的纯文本。 */
function cells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cellText(m[1]!))
}

/** 单元格纯文本：剥掉内层标签（代码/名称在 `<a>` 里）、还原常见实体、去首尾空白。 */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

/** 解析单元格数值：千分位逗号与 `%` 去掉（不做 /100）；`---` / `--` / 空为 `null`。非空却读不出数抛。 */
function parseCellNumber(value: string, label: string): number | null {
  const text = value.replace(/[,\s%]/g, '')
  if (text === '' || text === '---' || text === '--') return null
  const num = Number(text)
  if (!Number.isFinite(num)) throw new ParseError(`${label}：无法解析的数值「${value}」`)
  return num
}
