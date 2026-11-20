import { expect, it } from 'vitest'
import type {
  Fetched,
  FundCodeEntry,
  FundDataSource,
  FundProfilePage,
} from '@fundmanager/datasource'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'
import { getFundProfile, listCategories, searchFunds } from './fundSearchService.ts'

const codes: readonly FundCodeEntry[] = [
  {
    code: '000001',
    abbrev: 'HXCZHH',
    name: '华夏成长混合',
    category: '混合型-灵活',
    pinyin: 'HUAXIACHENGZHANGHUNHE',
  },
  {
    code: '000003',
    abbrev: 'ZHKZZZQA',
    name: '中海可转债债券A',
    category: '债券型-混合二级',
    pinyin: 'ZHONGHAIKEZHUANZHAIZHAIQUANA',
  },
]

/** 全量代码表的假信封；`stale` 默认新鲜 */
const fundCodes = (
  value: readonly FundCodeEntry[],
  o: { stale?: boolean } = {},
): Fetched<readonly FundCodeEntry[]> => ({
  value,
  source: 'fundcode_search',
  dataAsOf: '2026-11-19',
  capturedAt: '2026-11-19T10:00:00+08:00',
  stale: o.stale ?? false,
  loss: null,
})

const searchDeps = (value: readonly FundCodeEntry[], o: { stale?: boolean } = {}) => ({
  dataSource: { fundCodes: async () => fundCodes(value, o) },
})

// 300 只同名基金，只有代码不同——用在 limit 测试里
const many: readonly FundCodeEntry[] = Array.from({ length: 300 }, (_, i) => ({
  ...codes[0]!,
  code: String(i).padStart(6, '0'),
}))

it('代码、名称、拼音简写、拼音全拼都能搜到，大小写不敏感', async () => {
  const d = searchDeps(codes)
  const counts = await Promise.all(
    ['000001', '华夏', 'hxczhh', 'HUAXIACHENGZHANG'].map(
      async (q) => (await searchFunds(d, { q })).value!.length,
    ),
  )
  expect(counts).toEqual([1, 1, 1, 1])
})

it('搜索结果带上全量表的出处与时点，stale 穿透', async () => {
  const r = await searchFunds(searchDeps(codes, { stale: true }), { q: '华夏' })
  expect(r).toMatchObject({ source: 'fundcode_search', dataAsOf: '2026-11-19', stale: true })
})

it('按类型精确筛选；未知类型返回空而不是全部', async () => {
  const d = searchDeps(codes)
  expect((await searchFunds(d, { category: '债券型-混合二级' })).value).toHaveLength(1)
  expect((await searchFunds(d, { category: '不存在的类型' })).value).toHaveLength(0)
})

it('分类清单从数据聚合，带每类基金数', async () => {
  const cats = (await listCategories(searchDeps(codes))).value!
  // 排序固定，断言顺序也钉住排序逻辑
  // 按中文拼音序排列：hun < zhai
  expect(cats).toEqual([
    { category: '混合型-灵活', count: 1 },
    { category: '债券型-混合二级', count: 1 },
  ])
})

it('limit 默认 50、上限 200，负数与 0 不反向取尾部', async () => {
  const d = searchDeps(many)
  expect((await searchFunds(d, {})).value).toHaveLength(50)
  expect((await searchFunds(d, { limit: 999 })).value).toHaveLength(200)
  expect((await searchFunds(d, { limit: -1 })).value).toHaveLength(0)
})

const profile: FundProfilePage = {
  benchmark: '中证800成长指数收益率*70%+中债-综合全价(总值)指数收益率*30%',
  trackingTarget: '该基金无跟踪标的',
  fields: { 基金简称: '华夏成长混合', 基金类型: '混合型-灵活' },
}

const app = () =>
  buildApp({
    db: openDatabase().db,
    dataSource: {
      fundCodes: async () => fundCodes(codes),
      profile: async () =>
        ({
          value: profile,
          source: 'jbgk',
          dataAsOf: '2026-11-19',
          capturedAt: '2026-11-19T10:00:00+08:00',
          stale: false,
          loss: null,
        }) satisfies Fetched<FundProfilePage>,
      navHistory: async () => {
        throw new Error('本测试不查净值')
      },
    } as Pick<FundDataSource, 'fundCodes' | 'profile' | 'navHistory'> as unknown as FundDataSource,
  })

it('分类路由不被当成基金代码（静态段先于 :fundCode 注册）', async () => {
  const r = await app().inject({ method: 'GET', url: '/api/funds/categories' })
  expect(r.statusCode).toBe(200)
  expect(JSON.parse(r.body).value).toEqual([
    { category: '混合型-灵活', count: 1 },
    { category: '债券型-混合二级', count: 1 },
  ])
})

it('搜索、档案与非法参数的三个路由', async () => {
  const a = app()
  const search = await a.inject({ method: 'GET', url: '/api/funds?q=华夏' })
  expect(JSON.parse(search.body).value).toHaveLength(1)

  const detail = await a.inject({ method: 'GET', url: '/api/funds/000001' })
  expect(JSON.parse(detail.body).value).toEqual(profile)

  const badLimit = await a.inject({ method: 'GET', url: '/api/funds?limit=abc' })
  const badCode = await a.inject({ method: 'GET', url: '/api/funds/abc' })
  expect([badLimit.statusCode, badCode.statusCode]).toEqual([400, 400])
})

it('档案服务把数据源信封原样搬运，stale 穿透', async () => {
  const deps = {
    dataSource: {
      profile: async () =>
        ({ ...fundCodes(codes, { stale: true }), value: profile }) as Fetched<FundProfilePage>,
    },
  }
  expect(await getFundProfile(deps, '000001')).toMatchObject({ value: profile, stale: true })
})
