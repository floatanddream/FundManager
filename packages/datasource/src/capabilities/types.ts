/**
 * 能力层的对外类型：`Fetched<T>` 信封、各能力的归一化输出类型、`FundDataSource` 接口。
 *
 * 这些类型是**数据源的对外契约**（设计 §十三），归 `packages/datasource` 而非 `packages/shared`；
 * 唯一例外是 `NavConfirmed`——它既是领域类型又由本层产出，留在 shared，本层用 `navConfirmed()` 构造。
 */
import type { NavConfirmed } from '@fundmanager/shared'

import type { HoldingPeriod } from '../endpoints/fundArchives.ts'
import type { FundCodeEntry } from '../endpoints/fundcode.ts'
import type {
  AnnouncementPage,
  FinancialReport,
  IndustryQuarter,
  NavEvent,
  TurnoverRow,
} from '../endpoints/f10.ts'
import type { DailyKline, FqklineQuery, Quote } from '../endpoints/gtimg.ts'
import type { DividendSplitPage, FundProfilePage } from '../endpoints/htmlPages.ts'
import type { CategorizedSeries } from '../endpoints/pingzhongdata.ts'
import type { SectorMembers, StockIndustry } from '../endpoints/push2.ts'

/**
 * 数据源层对外的统一信封：值 + 出处 + 数据时点 + 抓取时刻 + 新鲜度 + 口径损失。
 *
 * `stale`（数据旧）与 `loss`（口径弱）**必须分开**：前者是绝对时点问题（「你看到的是 3 天前的」），
 * 后者是覆盖问题（「这是持仓，但只剩前十大」）。
 */
export type Fetched<T> = {
  readonly value: T
  /** 数据来自哪个端点（如 `'f10/lsjz'`）——换源与排障要看 */
  readonly source: string
  /** 数据本身的时点（净值日 / 报告期 / 事件日），`YYYY-MM-DD`；无天然时点者为抓取日 */
  readonly dataAsOf: string
  /** 抓取时刻，带时区（+08:00） */
  readonly capturedAt: string
  /** 来自缓存降级——数据**旧**。TTL 未过期的正常命中**不算** stale（数据本来就该是这个时点） */
  readonly stale: boolean
  /** 相对主源**失去了什么口径**（如「仅前十大」）；无损失为 `null` */
  readonly loss: string | null
}

/** 一行净值历史：两个来源（lsjz / pingzhongdata）归一到同一形状。 */
export type NavHistoryRow = {
  /** 确认净值（T-1），带净值日。用 `navConfirmed` 构造以拦住脏日期 */
  readonly nav: NavConfirmed
  /** 累计净值；缺失为 null */
  readonly accNav: number | null
  /** 日增长率（%），缺失为 null */
  readonly growthRate: number | null
  /** 分红/拆分事件；备源（pingzhongdata 走势）没有此字段，降级后一律 null */
  readonly event: NavEvent | null
}

/** 净值历史：按期**降序**（最新在前）。 */
export type NavHistory = {
  readonly fundCode: string
  readonly rows: readonly NavHistoryRow[]
}

/** 规模/份额时序的一行：归一两源（gmbd 有份额与申赎，pingzhongdata 只有规模）。 */
export type ScaleHistoryRow = {
  readonly reportDate: string
  /** 期末净资产（亿元） */
  readonly netAsset: number | null
  /** 期末总份额（亿份）；备源没有，为 null */
  readonly totalShares: number | null
  /** 期间申购（亿份）；备源没有，为 null */
  readonly purchase: number | null
  /** 期间赎回（亿份）；备源没有，为 null */
  readonly redemption: number | null
  /** 净资产变动率（%）；备源没有，为 null */
  readonly navChangeRate: number | null
}

/** 规模/份额时序：按期**降序**（最新在前）。 */
export type ScaleHistory = {
  readonly fundCode: string
  readonly rows: readonly ScaleHistoryRow[]
}

/** 换手率历史：翻页取全后的全部报告期（按期降序）。 */
export type TurnoverResult = {
  readonly rows: readonly TurnoverRow[]
}

/**
 * 上层按**能力**取数的唯一接口（设计 §1 的缝）。
 *
 * 每个方法返回带「来源 + 数据时点 + 新鲜度 + 口径损失」的 `Fetched<T>`；失败绝不静默——
 * 要么给出标了 `stale` 的旧值，要么抛 `DataSourceError`。默认实现由 `endpoints/` 组合而成，
 * 「换源只改装配点」即换掉本接口的实现。
 */
export interface FundDataSource {
  /**
   * 净值历史。主源 `f10/lsjz`（含分红/拆分事件），降级 `pingzhongdata` 走势。
   *
   * @throws {DataSourceError} 全部来源失败且无缓存旧值
   */
  navHistory(
    fundCode: string,
    opts?: { readonly startDate?: string; readonly endDate?: string },
  ): Promise<Fetched<NavHistory>>

  /** 基金概况（业绩比较基准 / 跟踪标的）。**无备源**（移动端接口不含这两项）。 */
  profile(fundCode: string): Promise<Fetched<FundProfilePage>>

  /**
   * 持仓。默认取最新报告期；给 `month` 则取命中的那期。
   *
   * `loss` 反映该期是否为完整持仓：季报前十大或被 `topline` 截断时非 null（Review Focus #4）。
   */
  holdings(
    fundCode: string,
    opts?: { readonly year?: number; readonly month?: number },
  ): Promise<Fetched<HoldingPeriod>>

  /** 行业配置（基金维度，国民经济行业分类）。**无备源**（个股维度 `f127` 口径不同，不可相代）。 */
  industryAllocation(
    fundCode: string,
    opts?: { readonly year?: number },
  ): Promise<Fetched<readonly IndustryQuarter[]>>

  /** 资产配置。**只有 `pingzhongdata` 源**（设计里的主源 `FundMNAssetAllocationNew` 未接入本层）。 */
  assetAllocation(fundCode: string): Promise<Fetched<CategorizedSeries>>

  /** 规模/份额时序。主源 `gmbd`（含份额与申赎），降级 `pingzhongdata`（只有规模）。 */
  scaleHistory(fundCode: string): Promise<Fetched<ScaleHistory>>

  /** 分红 + 份额折算。主源 `fhsp` HTML，降级 `f10/lsjz` 的分红/折算字段。 */
  dividends(fundCode: string): Promise<Fetched<DividendSplitPage>>

  /** 公告列表。主源 `f10/JJGG`，降级 `f10/FHGG`（只有分红公告）。 */
  announcements(
    fundCode: string,
    opts?: { readonly pageSize?: number },
  ): Promise<Fetched<AnnouncementPage>>

  /** 财务指标（列式字典归一后的按报告期行）。**无备源**。 */
  financials(fundCode: string, opts?: { readonly year?: number }): Promise<Fetched<FinancialReport>>

  /** 换手率（翻页取全）。**无备源**。 */
  turnover(fundCode: string): Promise<Fetched<TurnoverResult>>

  /** 全量基金代码表。**无天然时点**，`dataAsOf` 取抓取日。 */
  fundCodes(): Promise<Fetched<readonly FundCodeEntry[]>>

  /**
   * 实时行情。**不缓存**（盘中反复变，缓存只会给出陈旧值）。
   *
   * @throws {DataSourceError} 一个都没取到（代码全不存在或打错）
   */
  quotes(symbols: readonly string[]): Promise<Fetched<readonly Quote[]>>

  /** 日 K 线。**不缓存**。 */
  dailyKline(query: FqklineQuery): Promise<Fetched<DailyKline>>

  /**
   * 个股行业分类（细分行业 `f127`，与 `HYPZ` 的国民经济分类**不是一套**）。
   *
   * @returns `value` 为 `null` 表示该代码查不到（接口 `data:null`），不是失败
   */
  stockIndustry(stockCode: string): Promise<Fetched<StockIndustry | null>>

  /** 板块成分股（翻页取全）。`value` 为 `null` 表示该板块查无成分（接口 `data:null`）。 */
  sectorMembers(
    fs: string,
    opts?: { readonly pageSize?: number },
  ): Promise<Fetched<SectorMembers | null>>
}
