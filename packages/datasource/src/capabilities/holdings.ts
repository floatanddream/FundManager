/**
 * 能力：持仓（按期）。
 *
 * 主源 `FundArchivesDatas?type=jjcc`，降级到移动端 `fundmobapi/FundMNInverstPosition`。
 *
 * `loss` 有**两种不同成因**，文案必须能区分（本文件的核心）：
 * 1. 主源命中但该期本就非全量（季报前十大、或被 `topline` 截断）——「**这次取到的就是前十大**」；
 * 2. 主源失败、降到移动端接口——「**主源挂了，备源只给前十大**」。
 *
 * 混成一句话会让「是不是降级了」答不上来——`stale` 只管数据旧不旧、不管口径弱不弱。
 * 主源的口径由块尾链接文案判定（`isFullPortfolio`），**不能按报告期类型判**（会高估）。
 */
import type { CacheStore } from '../cache/cacheStore.ts'
import type { HoldingPeriod, HoldingRow } from '../endpoints/fundArchives.ts'
import { jjccRequest, parseJjcc } from '../endpoints/fundArchives.ts'
import { inverstPositionRequest, parseInverstPosition } from '../endpoints/fundmobapi.ts'
import type { HttpClient } from '../http/client.ts'
import { DataSourceError } from '../http/errors.ts'

import { fetchWithFallback } from './fetchWithFallback.ts'
import type { Fetched } from './types.ts'

const TTL_MS = 24 * 60 * 60 * 1000

export function holdings(
  http: HttpClient,
  cache: CacheStore,
  fundCode: string,
  opts: { year?: number; month?: number; now?: () => Date } = {},
): Promise<Fetched<HoldingPeriod>> {
  const now = opts.now ?? (() => new Date())
  const year = opts.year ?? now().getFullYear()
  const month = opts.month
  const fixedYear = opts.year !== undefined
  return fetchWithFallback<HoldingPeriod>({
    key: `holdings:${fundCode}:${year}:${month ?? ''}`,
    ttlMs: TTL_MS,
    cache,
    lossFor: coverageLoss,
    sources: [
      {
        name: 'FundArchivesDatas/jjcc',
        run: async () => {
          const period = await fetchJjccPeriod(http, fundCode, year, month, fixedYear)
          return { value: period, dataAsOf: period.reportDate }
        },
      },
      {
        name: 'fundmobapi/FundMNInverstPosition',
        // 与主源的 lossFor 文案必须可区分：这句是「主源挂了」的信号，主源那句是「这次本来就只有前十大」
        loss: '主源 FundArchivesDatas/jjcc 失败，已降级到移动端 FundMNInverstPosition：它只提供前十大持仓（且无持股数、持仓市值），不是该期的真实覆盖',
        run: async () => {
          // 备源不认 `year` / `month`，只会返回它自己的「最新一期」。调用方指定了年份或月份时
          // 若拿它顶，「要 2020」就会被换成「给你 2026」、「要 6 月」会变成「给你 9 月」——
          // 正是本项目要杜绝的静默错值。直接抛，让整条链失败、错误如实返回，绝不返回备源的期。
          // 只有「给我最新的」（year、month 都没给）时备源可用：此时最新一期正是所要。
          if (fixedYear || month !== undefined) {
            throw new DataSourceError(
              month !== undefined
                ? `fundmobapi/FundMNInverstPosition 不提供按期（month）查询，只返回其最新一期，` +
                    `指定月份时不能作为备源（${fundCode}）`
                : `fundmobapi/FundMNInverstPosition 不提供指定年份（year）查询，只返回其最新一期` +
                    `（具体报告期取决于该接口当前数据），不能作为指定年份时的备源：` +
                    `请求的是 ${year} 年，用它的最新一期顶替就是返回错误年份的持仓（${fundCode}）`,
            )
          }
          const { text } = await http.request(inverstPositionRequest(fundCode))
          const pos = parseInverstPosition(text)
          if (pos.stocks.length === 0) {
            // 响应合理但无股票持仓——不当成功（否则与 `jjcc` 空集合一样，会把「解析失败」伪装成「没有持仓」）
            throw new DataSourceError(
              `fundmobapi/FundMNInverstPosition 未返回股票持仓（${fundCode}）：可能该基金不持有股票或代码有误`,
            )
          }
          const period: HoldingPeriod = {
            reportDate: pos.reportDate,
            // 该接口本就只给前十大，永远不是完整持仓
            isFullPortfolio: false,
            holdings: pos.stocks.map(toHoldingRow),
          }
          return { value: period, dataAsOf: pos.reportDate }
        },
      },
    ],
  })
}

/** 该期若非完整持仓，如实记口径损失——非完整有两种来源：季报前十大、被 topline 截断。 */
function coverageLoss(period: HoldingPeriod): string | null {
  return period.isFullPortfolio ? null : '仅前十大持仓：该报告期只披露了前十大重仓股，不是完整持仓'
}

/**
 * 移动端持仓行 → 归一持仓行。
 *
 * `shares` / `marketValue` 该接口**不提供**，一律 `null`（不是 0——0 会被当成「持有零股」）。
 * 该接口另带的个股行业与增减持方向暂不进入 `HoldingRow`（当前契约没有这两列），保留在端点层。
 */
function toHoldingRow(
  row: { stockCode: string; stockName: string; navRatio: number | null },
  index: number,
): HoldingRow {
  return {
    rank: index + 1,
    stockCode: row.stockCode,
    stockName: row.stockName,
    navRatio: row.navRatio,
    shares: null,
    marketValue: null,
  }
}

/** 给 `month` 则取命中的那一期（**命中不了就抛**，绝不退回别的期）；否则取报告期最新的一期。 */
function selectPeriod(periods: readonly HoldingPeriod[], month: number | undefined): HoldingPeriod {
  if (month !== undefined) {
    const needle = `-${String(month).padStart(2, '0')}-`
    const matched = periods.find((p) => p.reportDate.includes(needle))
    if (matched !== undefined) return matched
    // 指定了月份却拿不到那一期，退回「最新一期」会把「要 6 月」变成「给你 9 月」而**无任何信号**。
    // 宁可抛，也不给错期——调用方要么得到要的那期，要么得到一条能自解释的错误。
    throw new DataSourceError(
      `jjcc 响应里没有 ${month} 月对应的报告期，不退回其它报告期` +
        `（该次实际拿到的报告期：${describePeriods(periods)}）`,
    )
  }
  const latest = [...periods].sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0]
  if (latest === undefined) {
    // 报告期列表为空时 `[0]!` 会取到 `undefined` 并静默往下传，显式抛出以免崩或给出垃圾。
    throw new DataSourceError('jjcc 响应里没有任何报告期，无法给出最新一期')
  }
  return latest
}

/**
 * 取主源报告期。
 *
 * **年初的坑**：1 月的头几天里，最新报告期仍是上一年的 Q3——查询「当年」可能一个报告期都拿不到。
 * 故在调用方**没有显式给 `year`**（`fixedYear` 为假）且当年取不到报告期时，退回上一年再取一次
 * （多一次请求，只在取不到时发生）。显式给了年份的调用方**行为不变**：当年没有就如实失败，
 * 绝不换成别的年份。`parseJjcc` 对「该年无报告期」返回空列表（不是抛错），这里据空列表退一年。
 */
async function fetchJjccPeriod(
  http: HttpClient,
  fundCode: string,
  year: number,
  month: number | undefined,
  fixedYear: boolean,
): Promise<HoldingPeriod> {
  const load = async (y: number): Promise<readonly HoldingPeriod[]> => {
    const { text } = await http.request(jjccRequest({ fundCode, year: y, month }))
    return parseJjcc(text)
  }
  let periods = await load(year)
  if (periods.length === 0 && !fixedYear) periods = await load(year - 1)
  return selectPeriod(periods, month)
}

/** 列出实际拿到的报告期，供报错信息自解释。 */
function describePeriods(periods: readonly HoldingPeriod[]): string {
  return periods.length === 0 ? '（空）' : periods.map((p) => p.reportDate).join('、')
}
