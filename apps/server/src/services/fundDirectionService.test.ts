import { expect, it } from 'vitest'
import type {
  Fetched,
  FundDataSource,
  FundProfilePage,
  IndustryQuarter,
} from '@fundmanager/datasource'
import { getFundDirections } from './fundDirectionService.ts'

const fetched = <T>(value: T, overrides: Partial<Fetched<T>> = {}): Fetched<T> => ({
  value,
  source: 'test-source',
  dataAsOf: '2026-09-30',
  capturedAt: '2026-11-21T10:00:00+08:00',
  stale: false,
  loss: null,
  ...overrides,
})
const profile = (trackingTarget: string): FundProfilePage => ({
  benchmark: '',
  trackingTarget,
  fields: {},
})
const emptyProfile = fetched(profile('该基金无跟踪标的'))
const deps = (options: {
  profile?: Fetched<FundProfilePage>
  years?: Record<number, Fetched<readonly IndustryQuarter[]>>
}) => ({
  dataSource: {
    profile: async () => options.profile ?? emptyProfile,
    industryAllocation: async (_code: string, opts?: { year?: number }) =>
      options.years?.[opts?.year ?? 0] ?? fetched([]),
  } as unknown as Pick<FundDataSource, 'profile' | 'industryAllocation'>,
  now: () => new Date('2026-01-10T00:00:00+08:00'),
})

it('按经核验的跟踪指数标注主题指数并保留档案时点', async () => {
  const result = await getFundDirections(
    deps({ profile: fetched(profile('中证半导体行业精选指数'), { dataAsOf: '2026-11-01' }) }),
    '012345',
  )
  expect(result.value).toEqual([
    { label: '半导体', kind: 'index_theme', reportDate: null, reference: '中证半导体行业精选指数' },
  ])
  expect(result.dataAsOf).toBe('2026-11-01')
})

it('主动基金在本年暂无披露时回退上年并按权重取前两行业', async () => {
  const q: IndustryQuarter = {
    quarter: '4',
    reportDate: '2025-12-31',
    rows: [
      { industryCode: '1', industryName: '通信', marketValue: 1, navRatio: 20 },
      { industryCode: '2', industryName: '电子', marketValue: 1, navRatio: 15 },
      { industryCode: '3', industryName: '计算机', marketValue: 1, navRatio: 10 },
    ],
  }
  const result = await getFundDirections(
    deps({ years: { 2026: fetched([]), 2025: fetched([q]) } }),
    '000001',
  )
  expect(result.value).toEqual([
    {
      label: '通信',
      kind: 'reported_industry',
      reportDate: '2025-12-31',
      reference: '基金行业配置披露',
    },
    {
      label: '电子',
      kind: 'reported_industry',
      reportDate: '2025-12-31',
      reference: '基金行业配置披露',
    },
  ])
  expect(result.dataAsOf).toBe('2025-12-31')
})

it('标的名称含有宽基名称时，仍以完整标的核验方向', async () => {
  const result = await getFundDirections(
    deps({ profile: fetched(profile('沪深300医药卫生指数')) }),
    '011609',
  )
  expect(result.value).toEqual([])
  expect(result.reason).toContain('尚无已核验')
})

it('档案有明确短债分类时展示期限，无标的和行业披露时不推断联接基金方向', async () => {
  const classified = (category: string) =>
    deps({
      profile: fetched({ ...profile('该基金无跟踪标的'), fields: { 基金类型: category } }),
    })
  expect((await getFundDirections(classified('债券型-中短债'), '000001')).value).toMatchObject([
    { label: '短债', kind: 'fund_category' },
  ])
  expect((await getFundDirections(classified('指数型-ETF联接'), '011609')).value).toEqual([])
})

it('上游档案失败返回带原因的空值', async () => {
  const bad = {
    ...deps({}),
    dataSource: {
      ...deps({}).dataSource,
      profile: async () => {
        throw new Error('offline')
      },
    },
  }
  const result = await getFundDirections(bad, '000001')
  expect(result.value).toBeNull()
  expect(result.reason).toContain('offline')
})
