/**
 * 搜基金、分类聚合与基金档案（设计 §六 市场数据）。
 *
 * 搜索数据来自数据源已有的 `fundCodes()` 全量表，**不另建分类体系**：`category` 就是
 * 数据源的原值（如 `混合型-灵活`），归一化只会造出一套与数据源对不上的第二分类。
 */
import type {
  Fetched,
  FundCodeEntry,
  FundDataSource,
  FundProfilePage,
} from '@fundmanager/datasource'
import { fromFetched, type Sourced } from '../envelope.ts'

/** 未指定时每页返回条数 */
export const DEFAULT_LIMIT = 50
/** 上限：全表两万余条，一次吐完既慢也没人看 */
export const MAX_LIMIT = 200

export type FundSearchOptions = {
  /** 同时匹配代码 / 名称 / 拼音简写 / 拼音全拼，大小写不敏感 */
  readonly q?: string
  /** 数据源原值精确匹配，不做归一化 */
  readonly category?: string
  /** 默认 {@link DEFAULT_LIMIT}，上限 {@link MAX_LIMIT} */
  readonly limit?: number
}

type FundCodesDeps = { readonly dataSource: Pick<FundDataSource, 'fundCodes'> }

/** `q` 命中四个字段中的任意一个即可 */
const matches = (entry: FundCodeEntry, q: string): boolean =>
  entry.code.toLowerCase().includes(q) ||
  entry.name.toLowerCase().includes(q) ||
  entry.abbrev.toLowerCase().includes(q) ||
  entry.pinyin.toLowerCase().includes(q)

/**
 * 搜基金。
 *
 * @returns 命中的元数据（已截断到 `limit`）；`stale` / `loss` / `dataAsOf` 从全量表穿透
 */
export async function searchFunds(
  deps: FundCodesDeps,
  opts: FundSearchOptions = {},
): Promise<Sourced<readonly FundCodeEntry[]>> {
  const fetched = await deps.dataSource.fundCodes()
  const q = opts.q?.trim().toLowerCase() ?? ''
  const matched = fetched.value.filter(
    (entry) =>
      (q === '' || matches(entry, q)) &&
      (opts.category === undefined || entry.category === opts.category),
  )
  // 负数与 0 都按 0 处理，不让 slice 的负数语义（从尾部取）溜进来
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_LIMIT), 0), MAX_LIMIT)
  // 搜索结果只是全量表的子集：沿用同一份出处与时点，但**不把整表塞进 provenance**
  // （两万余条重复序列化会让响应膨胀几十兆），故不套 fromDerived
  return { ...fromFetched(fetched), value: matched.slice(0, limit) }
}

/**
 * 可选类型清单，**从实际数据聚合**（数据源将来增删类型，这里自动跟上）。
 *
 * @returns 每个类型及其基金数，按类型名排序
 */
export async function listCategories(
  deps: FundCodesDeps,
): Promise<Sourced<readonly { readonly category: string; readonly count: number }[]>> {
  const fetched = await deps.dataSource.fundCodes()
  const counts = new Map<string, number>()
  for (const entry of fetched.value) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
  }
  const categories = [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category, 'zh'))
  return { ...fromFetched(fetched), value: categories }
}

/**
 * 基金档案：业绩比较基准、跟踪标的与概况表原文。
 *
 * @remarks 概况无天然时点，`dataAsOf` 由数据源取抓取日；`stale` 原样穿透
 */
export async function getFundProfile(
  deps: { readonly dataSource: Pick<FundDataSource, 'profile'> },
  fundCode: string,
): Promise<Sourced<FundProfilePage>> {
  const fetched: Fetched<FundProfilePage> = await deps.dataSource.profile(fundCode)
  return fromFetched(fetched)
}
