import type { FundDataSource, FundProfilePage } from '@fundmanager/datasource'
import { fromFetched, type Sourced } from '../envelope.ts'

export type DirectionTag = {
  readonly label: string
  readonly kind: 'index_theme' | 'broad_index' | 'reported_industry' | 'fund_category'
  readonly reportDate: string | null
  readonly reference: string
}

type Deps = {
  readonly dataSource: Pick<FundDataSource, 'profile' | 'industryAllocation'>
  readonly now?: () => Date
}

const indexMappings: readonly {
  readonly match: string
  readonly label: string
  readonly kind: DirectionTag['kind']
  readonly reference: string
}[] = [
  { match: '932066', label: '半导体', kind: 'index_theme', reference: '中证半导体行业精选指数' },
  {
    match: '中证半导体行业精选指数',
    label: '半导体',
    kind: 'index_theme',
    reference: '中证半导体行业精选指数',
  },
  { match: '930713', label: '人工智能', kind: 'index_theme', reference: '中证人工智能主题指数' },
  {
    match: '中证人工智能主题指数',
    label: '人工智能',
    kind: 'index_theme',
    reference: '中证人工智能主题指数',
  },
  { match: '000300', label: '沪深300宽基', kind: 'broad_index', reference: '沪深300指数' },
  { match: '沪深300', label: '沪深300宽基', kind: 'broad_index', reference: '沪深300指数' },
  { match: '000905', label: '中证500宽基', kind: 'broad_index', reference: '中证500指数' },
  { match: '中证500', label: '中证500宽基', kind: 'broad_index', reference: '中证500指数' },
  { match: '000852', label: '中证1000宽基', kind: 'broad_index', reference: '中证1000指数' },
  { match: '中证1000', label: '中证1000宽基', kind: 'broad_index', reference: '中证1000指数' },
  { match: '000688', label: '科创50宽基', kind: 'broad_index', reference: '上证科创板50成份指数' },
]

/**
 * 基于档案跟踪标的、产品分类或披露行业返回投资方向。
 * @throws 不主动抛出数据源错误；取数失败作为 `Sourced.reason` 返回，以隔离方向列故障。
 */
export async function getFundDirections(
  deps: Deps,
  fundCode: string,
): Promise<Sourced<readonly DirectionTag[]>> {
  const now = deps.now?.() ?? new Date()
  const localTime = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  let p: Sourced<FundProfilePage>
  try {
    p = fromFetched(await deps.dataSource.profile(fundCode))
  } catch (error) {
    return failed(error, localTime)
  }
  const target = p.value!.trackingTarget.replace(/\s/g, '').replace(/[（(]\d{6}[）)]$/, '')
  // 完整匹配跟踪标的，防止把「沪深300医药卫生指数」归到沪深300宽基。
  const mapping = indexMappings.find((m) => target === m.match || target === m.reference)
  if (mapping)
    return {
      ...p,
      value: [
        {
          label: mapping.label,
          kind: mapping.kind,
          reportDate: null,
          reference: mapping.reference,
        },
      ],
    }

  const fields = p.value!.fields
  const category = fields['基金类型'] ?? fields['基金类别'] ?? ''
  const categoryTag = categoryDirection(category)
  if (categoryTag) return { ...p, value: [categoryTag] }
  if (target && !/无跟踪标的|暂无|未跟踪|^-+$/.test(target))
    return { ...p, value: [], reason: '跟踪标的尚无已核验的方向映射' }

  const year = localTime.getUTCFullYear()
  let first: Awaited<ReturnType<FundDataSource['industryAllocation']>>
  try {
    first = await deps.dataSource.industryAllocation(fundCode, { year })
  } catch (error) {
    return failed(error, localTime, p)
  }
  let industry = first
  if (first.value.length === 0) {
    try {
      industry = await deps.dataSource.industryAllocation(fundCode, { year: year - 1 })
    } catch (error) {
      return failed(error, localTime, p)
    }
  }
  const quarters = industry.value
  const latest = [...quarters].sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0]
  const tags = latest
    ? latest.rows
        .filter((r) => r.navRatio !== null && r.navRatio > 0)
        .sort((a, b) => b.navRatio! - a.navRatio!)
        .slice(0, 2)
        .map((r) => ({
          label: r.industryName,
          kind: 'reported_industry' as const,
          reportDate: latest.reportDate,
          reference: '基金行业配置披露',
        }))
    : []
  const result = fromFetched(industry)
  return { ...result, dataAsOf: latest?.reportDate ?? result.dataAsOf, value: tags }
}

function categoryDirection(category: string): DirectionTag | null {
  const checks: readonly [RegExp, string][] = [
    [/中短债|短债/, '短债'],
    [/货币/, '货币'],
    [/纯债/, '纯债'],
    [/债券/, '债券型'],
  ]
  const found = checks.find(([pattern]) => pattern.test(category))
  return found
    ? {
        label: found[1],
        kind: 'fund_category',
        reportDate: null,
        reference: `基金分类：${category}`,
      }
    : null
}

function failed(
  error: unknown,
  localTime: Date,
  prior?: Sourced<unknown>,
): Sourced<readonly DirectionTag[]> {
  const iso = localTime.toISOString()
  return {
    value: null,
    reason: error instanceof Error ? error.message : String(error),
    source: prior?.source ?? 'fund directions',
    dataAsOf: prior?.dataAsOf ?? iso.slice(0, 10),
    capturedAt: prior?.capturedAt ?? iso.replace(/\.\d{3}Z$/, '+08:00'),
    stale: prior?.stale ?? false,
    loss: prior?.loss ?? null,
    provenance: prior?.provenance ?? [],
  }
}
