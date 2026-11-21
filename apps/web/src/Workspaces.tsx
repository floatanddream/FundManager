import { useQueries, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronRight, Search } from 'lucide-react'
import { lazy, Suspense, useDeferredValue, useState } from 'react'
import { api, type Coverage, type OverviewPosition, type Sourced } from './api.ts'

const FundDetail = lazy(() => import('./FundDetail.tsx'))
const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })
const percentage = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  signDisplay: 'exceptZero',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})
type SortKey = 'marketValue' | 'dailyGain' | 'unrealizedGain'

/** 缺值显示原因，让用户能区分成本未知和实际盈亏为零。 */
function Money({
  data,
  signed,
  showReason = true,
}: {
  data: Sourced<number>
  signed?: boolean
  showReason?: boolean
}) {
  const value = data.value
  if (value === null) {
    return (
      <>
        <span>—</span>
        {showReason && data.reason && (
          <span className="workspace-subtle" title={data.reason}>
            {data.reason.startsWith('成本未知') ? '成本未知' : data.reason}
          </span>
        )}
      </>
    )
  }
  const color = signed && value !== 0 ? (value > 0 ? 'gain-positive' : 'gain-negative') : undefined
  return (
    <span className={color}>
      {signed && value > 0 ? '+' : ''}
      {currency.format(value)}
    </span>
  )
}

/** 窄屏下详情排在列表之后，把键盘焦点和视口一起移到详情。 */
function scrollToDetail() {
  if (!window.matchMedia('(max-width: 920px)').matches) return
  requestAnimationFrame(() => {
    const detail = document.getElementById('fund-detail')
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    detail?.focus({ preventScroll: true })
    detail?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'instant' : 'smooth' })
  })
}

/** 未知值始终排在末尾，升序时也不能把未知当作最小金额。 */
function sortPositions(positions: OverviewPosition[], key: SortKey, descending: boolean) {
  return [...positions].sort((a, b) => {
    const left = a[key].value
    const right = b[key].value
    if (left === null) return right === null ? 0 : 1
    if (right === null) return -1
    return descending ? right - left : left - right
  })
}

/** 标签查询单独缓存，行业接口失败时不影响同一行的市值和收益。 */
function DirectionTags({ code }: { code: string }) {
  const query = useQuery({
    queryKey: ['fund-directions', code],
    queryFn: ({ signal }) => api.directions(code, signal),
    staleTime: 60 * 60 * 1000,
  })

  if (query.isPending) return <span className="direction-placeholder">正在读取…</span>
  if (query.isError) return <span className="direction-placeholder">暂不可用</span>
  const data = query.data
  if (!data.value?.length)
    return (
      <span className="direction-placeholder" title={data.reason ?? undefined}>
        {data.value === null ? '暂不可用' : '暂无方向数据'}
      </span>
    )

  return (
    <div className="direction-tags">
      {data.value.map((tag) => (
        <details className="direction-label" key={`${tag.kind}/${tag.label}`}>
          <summary>{tag.label}</summary>
          <small>
            {tag.reference}
            {tag.reportDate && <> · 报告期 {tag.reportDate}</>}
          </small>
        </details>
      ))}
      {data.stale && <small className="workspace-stale-date">沿用缓存</small>}
      {data.loss && <small className="direction-placeholder">{data.loss}</small>}
    </div>
  )
}

/** 数据不足时在汇总金额旁显示覆盖范围，让部分合计和完整总额有明确区别。 */
function OverviewMetric({
  label,
  data,
  coverage,
  signed,
}: {
  label: string
  data: Sourced<number>
  coverage: Coverage
  signed?: boolean
}) {
  const partial = coverage.included < coverage.total
  return (
    <div className="overview-metric">
      <h2>{label}</h2>
      <strong>
        <Money data={data} signed={signed} showReason={false} />
      </strong>
      {partial && (
        <p className="workspace-stale-date">
          {data.value === null ? '待确认' : '部分已确认'}（{coverage.included}/{coverage.total} 只）
        </p>
      )}
      {data.stale && <p className="workspace-stale-date">沿用缓存</p>}
      {data.value === null && data.reason && <p>{data.reason}</p>}
    </div>
  )
}

/** 右栏的账本金额与左栏读取同一个响应，切换基金时不会串用上一只基金的数据。 */
function PositionSummary({ position }: { position: OverviewPosition }) {
  return (
    <div className="position-summary">
      <div className="position-summary-header">
        <DirectionTags code={position.fundCode} />
        <p>
          持仓市值{' '}
          <strong>
            <Money data={position.marketValue} showReason={false} />
          </strong>
        </p>
      </div>
      <div className="position-summary-metrics">
        <div>
          <span>当日收益</span>
          <strong>
            <Money data={position.dailyGain} signed />
          </strong>
        </div>
        <div>
          <span>{position.shares === 0 ? '已实现收益' : '持有收益'}</span>
          <strong>
            {position.shares === 0 ? (
              currency.format(position.realizedGain)
            ) : (
              <Money data={position.unrealizedGain} signed />
            )}
          </strong>
        </div>
      </div>
      {(position.dailyGain.value !== null || position.marketValue.value !== null) && (
        <p className="position-summary-date">
          数据截至{' '}
          {position.dailyGain.value !== null
            ? position.dailyGain.dataAsOf
            : position.marketValue.dataAsOf}
        </p>
      )}
    </div>
  )
}

/** 组合和基金查询共用详情，只在账本内提供份额核对。 */
function FundPanel({
  code,
  name,
  ledgerId,
  position,
  onReconcile,
}: {
  code?: string
  name?: string
  ledgerId?: string
  position?: OverviewPosition
  onReconcile?: () => void
}) {
  return (
    <section
      id="fund-detail"
      className="workspace-panel detail-panel"
      tabIndex={-1}
      aria-label="基金详情"
    >
      {code ? (
        <>
          <Suspense
            fallback={
              <p className="workspace-empty" role="status">
                正在打开基金详情…
              </p>
            }
          >
            <FundDetail
              key={code}
              fundCode={code}
              name={name}
              ledgerId={ledgerId}
              ledgerSummary={position ? <PositionSummary position={position} /> : undefined}
            />
          </Suspense>
          {onReconcile && (
            <div className="detail-action">
              <button className="workspace-text-button" onClick={onReconcile}>
                核对份额
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="workspace-empty">选择一只基金查看净值与风险。</p>
      )}
    </section>
  )
}

/**
 * 展示指定账本的持仓与数据可信度，选中基金联动详情。
 *
 * @param props.ledgerId 当前账本标识，用于隔离持仓请求与缓存。
 */
export function Portfolio({
  ledgerId,
  onSearch,
  onReconcile,
}: {
  ledgerId: string
  onSearch: () => void
  onReconcile: (code: string) => void
}) {
  const [selected, setSelected] = useState<string>()
  const [showClosed, setShowClosed] = useState(false)
  const [sort, setSort] = useState<{ field: SortKey; desc: boolean }>({
    field: 'marketValue',
    desc: true,
  })
  const query = useQuery({
    queryKey: ['ledger-overview', ledgerId],
    queryFn: ({ signal }) => api.overview(ledgerId, signal),
  })
  const overview = query.data?.value
  const positions = overview?.positions ?? []
  const held = positions.filter((position) => position.shares > 0)
  const closed = positions.filter((position) => position.shares === 0)
  const visible = [
    ...sortPositions(held, sort.field, sort.desc),
    ...(showClosed ? sortPositions(closed, sort.field, sort.desc) : []),
  ]
  const active = visible.find((position) => position.fundCode === selected) ?? visible[0]
  // 基金名称沿用详情查询的缓存键，持仓表和详情不会为同一只基金各取一次档案。
  const fundNames = useQueries({
    queries: visible.map(({ fundCode }) => ({
      queryKey: ['fund-info', fundCode],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.fundInfo(fundCode, signal),
      staleTime: 60 * 60 * 1000,
    })),
  })
  const names = new Map(
    visible.map(({ fundCode }, index) => [
      fundCode,
      fundNames[index]?.data?.value?.fields['基金简称'],
    ]),
  )
  const affected = held.filter(
    ({ marketValue, dailyGain }) =>
      marketValue.stale ||
      marketValue.loss ||
      marketValue.reason ||
      dailyGain.stale ||
      dailyGain.loss ||
      dailyGain.reason,
  )
  const hasStale = affected.some(
    ({ marketValue, dailyGain }) => marketValue.stale || dailyGain.stale,
  )

  /** 换列时默认让金额最大的基金排在前面。 */
  function changeSort(field: SortKey) {
    setSort((prev) => ({ field, desc: prev.field === field ? !prev.desc : true }))
  }

  /** 通过 aria-sort 把实际排序状态同步给辅助工具。 */
  function sortHeading(field: SortKey, label: string) {
    return (
      <th
        scope="col"
        aria-sort={sort.field === field ? (sort.desc ? 'descending' : 'ascending') : 'none'}
      >
        <button className="table-sort" onClick={() => changeSort(field)}>
          {label}
          {sort.field === field && <span aria-hidden="true">{sort.desc ? '↓' : '↑'}</span>}
        </button>
      </th>
    )
  }

  if (query.isPending)
    return (
      <>
        <div className="workspace-page-heading">
          <h1>账本总览</h1>
        </div>
        <p className="workspace-panel workspace-empty" role="status">
          正在读取账本总览…
        </p>
      </>
    )
  if (query.isError)
    return (
      <>
        <div className="workspace-page-heading">
          <h1>账本总览</h1>
        </div>
        <div className="workspace-panel workspace-empty">
          <p role="alert">{query.error.message}</p>
          <button className="workspace-button secondary" onClick={() => void query.refetch()}>
            重试
          </button>
        </div>
      </>
    )
  if (!overview)
    return (
      <p className="workspace-panel workspace-empty" role="status">
        {query.data?.reason ?? '暂无账本总览数据。'}
      </p>
    )

  return (
    <div className="workspace-columns ledger-workspace">
      <div className="ledger-workspace-list">
        <div className="workspace-page-heading">
          <h1>账本总览</h1>
        </div>
        <section className="workspace-panel overview-metrics" aria-label="账本资产和收益">
          <OverviewMetric
            label="基金总市值"
            data={overview.marketValue}
            coverage={overview.marketValueCoverage}
          />
          <OverviewMetric
            label="当日收益"
            data={overview.dailyGain}
            coverage={overview.dailyGainCoverage}
            signed
          />
        </section>
        {overview.valuationDate && (
          <p className="overview-date">
            数据截至 {overview.valuationDate}
            {overview.previousDate && (
              <>
                {' '}
                · 收益区间 {overview.previousDate} 至 {overview.valuationDate}
              </>
            )}
          </p>
        )}
        {affected.length > 0 && (
          <details className="workspace-warning">
            <summary>
              <AlertTriangle size={18} aria-hidden="true" />
              <strong>{hasStale ? '部分净值沿用缓存' : '部分持仓数据不完整'}</strong>
              <span>查看受影响基金</span>
            </summary>
            <ul>
              {affected.map(({ fundCode, marketValue, dailyGain }) => (
                <li key={fundCode}>
                  <strong>{names.get(fundCode) ?? fundCode}</strong>
                  {marketValue.value !== null && <> · 净值截至 {marketValue.dataAsOf}</>}
                  {marketValue.stale && <> · 沿用缓存</>}
                  {marketValue.loss && <> · {marketValue.loss}</>}
                  {marketValue.reason && <> · {marketValue.reason}</>}
                  {dailyGain.reason && dailyGain.reason !== marketValue.reason && (
                    <> · 当日收益：{dailyGain.reason}</>
                  )}
                  {dailyGain.loss && dailyGain.loss !== marketValue.loss && (
                    <> · {dailyGain.loss}</>
                  )}
                  {dailyGain.stale && !marketValue.stale && <> · 当日收益沿用缓存</>}
                </li>
              ))}
            </ul>
          </details>
        )}
        <section className="workspace-panel holdings-panel">
          <h2>我的基金</h2>
          {visible.length ? (
            <div className="holdings-scroll">
              <table className="holdings-table">
                <thead>
                  <tr>
                    <th scope="col">基金</th>
                    <th scope="col">投资方向</th>
                    {sortHeading('marketValue', '市值')}
                    {sortHeading('dailyGain', '当日收益')}
                    {sortHeading('unrealizedGain', '持有收益')}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((position) => {
                    const { fundCode, marketValue, dailyGain, unrealizedGain, holdingGainRate } =
                      position
                    const isActive = active?.fundCode === fundCode
                    return (
                      <tr key={fundCode} data-selected={isActive}>
                        <th scope="row">
                          <button
                            className="fund-row-button"
                            aria-pressed={isActive}
                            onClick={() => {
                              setSelected(fundCode)
                              scrollToDetail()
                            }}
                          >
                            <span>{names.get(fundCode) ?? fundCode}</span>
                            {names.get(fundCode) && <small>{fundCode}</small>}
                          </button>
                        </th>
                        <td>
                          <DirectionTags code={fundCode} />
                        </td>
                        <td>
                          <Money data={marketValue} />
                        </td>
                        <td>
                          <Money data={dailyGain} signed />
                        </td>
                        <td>
                          {position.shares === 0 ? (
                            <>
                              <span
                                className={
                                  position.realizedGain > 0
                                    ? 'gain-positive'
                                    : position.realizedGain < 0
                                      ? 'gain-negative'
                                      : undefined
                                }
                              >
                                {currency.format(position.realizedGain)}
                              </span>
                              <span className="workspace-subtle">已实现收益</span>
                            </>
                          ) : (
                            <>
                              <Money data={unrealizedGain} signed />
                              {holdingGainRate.value !== null && (
                                <span className="workspace-subtle">
                                  {percentage.format(holdingGainRate.value)}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="workspace-empty holdings-empty">
              <p>{closed.length ? '当前没有持仓。' : '账本里还没有流水。'}</p>
              {!closed.length && (
                <button className="workspace-button secondary" onClick={onSearch}>
                  <Search size={16} aria-hidden="true" />
                  查找基金
                </button>
              )}
            </div>
          )}
          {closed.length > 0 && (
            <div className="holdings-footer">
              <button
                className="workspace-text-button"
                aria-expanded={showClosed}
                onClick={() => setShowClosed(!showClosed)}
              >
                {showClosed ? '收起' : '展开'}已清仓基金（{closed.length}）
                <ChevronRight
                  size={15}
                  className={showClosed ? 'is-rotated' : undefined}
                  aria-hidden="true"
                />
              </button>
            </div>
          )}
        </section>
      </div>
      <FundPanel
        code={active?.fundCode}
        name={active ? names.get(active.fundCode) : undefined}
        ledgerId={ledgerId}
        position={active}
        onReconcile={active ? () => onReconcile(active.fundCode) : undefined}
      />
    </div>
  )
}

/**
 * 按公开基金元数据查询，并将选中代码传给流水入口。
 *
 * @param props.onRecord 从详情预填基金代码，新建账本的路径由调用方负责。
 */
export function FundSearch({
  ledgerId,
  onRecord,
}: {
  ledgerId?: string
  onRecord: (code: string) => void
}) {
  const [term, setTerm] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<{ code: string; name: string }>()
  const query = useDeferredValue(term.trim())
  const categories = useQuery({
    queryKey: ['fund-categories'],
    queryFn: ({ signal }) => api.categories(signal),
  })
  const search = useQuery({
    queryKey: ['fund-search', query, category],
    queryFn: ({ signal }) => api.funds(query, category, signal),
  })
  const results = search.data?.value ?? []

  return (
    <>
      <div className="workspace-page-heading">
        <h1>基金查询</h1>
      </div>
      <div className="workspace-columns">
        <section className="workspace-panel search-panel">
          <div className="fund-search-fields">
            <div className="workspace-search">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                aria-label="基金名称、代码或拼音"
                placeholder="输入基金名称、代码或拼音"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
              />
            </div>
            <select
              aria-label="基金类型"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">全部类型</option>
              {(categories.data?.value ?? [])
                .filter((item) => item.category)
                .map((item) => (
                  <option key={item.category} value={item.category}>
                    {item.category}
                  </option>
                ))}
            </select>
          </div>
          {categories.isError && (
            <p role="status" className="search-source-note">
              基金类型暂不可用，仍可按名称或代码搜索。
            </p>
          )}
          {search.data?.stale && (
            <p role="status" className="search-source-note">
              搜索结果沿用缓存（{search.data.dataAsOf}）。
            </p>
          )}
          {search.data?.loss && (
            <p role="status" className="search-source-note">
              {search.data.loss}
            </p>
          )}
          {search.isPending ? (
            <p className="workspace-empty" role="status">
              正在查询基金…
            </p>
          ) : search.isError ? (
            <div className="workspace-empty">
              <p role="alert">{search.error.message}</p>
              <button className="workspace-button secondary" onClick={() => void search.refetch()}>
                重试
              </button>
            </div>
          ) : results.length ? (
            <ul className="fund-search-list">
              {results.map((fund) => (
                <li key={fund.code}>
                  <button
                    className="search-fund-row"
                    aria-pressed={fund.code === selected?.code}
                    onClick={() => {
                      setSelected(fund)
                      scrollToDetail()
                    }}
                  >
                    <span>
                      <strong>{fund.name}</strong>
                      <small>
                        {fund.code}
                        {fund.category ? ` · ${fund.category}` : ''}
                      </small>
                    </span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="workspace-empty">{search.data?.reason ?? '没有找到匹配的基金。'}</p>
          )}
        </section>
        <div>
          <FundPanel code={selected?.code} name={selected?.name} />
          {selected && (
            <button
              className="workspace-button search-record"
              onClick={() => onRecord(selected.code)}
            >
              {ledgerId ? '录入这只基金的流水' : '新建账本后录入'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
