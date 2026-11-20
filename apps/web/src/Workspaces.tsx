import { useQueries, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronRight, Search } from 'lucide-react'
import { lazy, Suspense, useDeferredValue, useState } from 'react'
import { api, type Position, type Sourced } from './api.ts'

const FundDetail = lazy(() => import('./FundDetail.tsx'))
const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })
type SortKey = 'marketValue' | 'unrealizedGain'

function Money({ data, signed }: { data: Sourced<number>; signed?: boolean }) {
  const value = data.value
  if (value === null) {
    return (
      <>
        <span>—</span>
        {data.reason && (
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

function scrollToDetail() {
  if (!window.matchMedia('(max-width: 920px)').matches) return
  requestAnimationFrame(() => {
    const detail = document.getElementById('fund-detail')
    detail?.focus()
    detail?.scrollIntoView({ block: 'start' })
  })
}

function sortPositions(positions: Position[], key: SortKey, descending: boolean) {
  return [...positions].sort((a, b) => {
    const left = a[key].value
    const right = b[key].value
    if (left === null) return right === null ? 0 : 1
    if (right === null) return -1
    return descending ? right - left : left - right
  })
}

function FundPanel({
  code,
  name,
  ledgerId,
  onReconcile,
}: {
  code?: string
  name?: string
  ledgerId?: string
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
            <FundDetail key={code} fundCode={code} name={name} ledgerId={ledgerId} />
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
    queryKey: ['positions', ledgerId],
    queryFn: ({ signal }) => api.positions(ledgerId, signal),
  })
  const positions = query.data?.value ?? []
  const held = positions.filter((position) => position.shares > 0)
  const closed = positions.filter((position) => position.shares === 0)
  const visible = sortPositions(showClosed ? positions : held, sort.field, sort.desc)
  const active = visible.find((position) => position.fundCode === selected) ?? visible[0]
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
  const affected = positions.filter(
    ({ marketValue }) => marketValue.stale || marketValue.loss || marketValue.reason,
  )
  const hasStale = affected.some(({ marketValue }) => marketValue.stale)

  function changeSort(field: SortKey) {
    setSort((prev) => ({ field, desc: prev.field === field ? !prev.desc : true }))
  }

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
      <p className="workspace-panel workspace-empty" role="status">
        正在读取持仓…
      </p>
    )
  if (query.isError)
    return (
      <div className="workspace-panel workspace-empty">
        <p role="alert">{query.error.message}</p>
        <button className="workspace-button secondary" onClick={() => void query.refetch()}>
          重试
        </button>
      </div>
    )

  return (
    <>
      {affected.length > 0 && (
        <details className="workspace-warning">
          <summary>
            <AlertTriangle size={18} aria-hidden="true" />
            <strong>{hasStale ? '部分净值沿用缓存' : '部分持仓数据不完整'}</strong>
            <span>查看受影响基金</span>
          </summary>
          <ul>
            {affected.map(({ fundCode, marketValue }) => (
              <li key={fundCode}>
                <strong>{names.get(fundCode) ?? fundCode}</strong>
                {marketValue.value !== null && <> · 净值截至 {marketValue.dataAsOf}</>}
                {marketValue.stale && <> · 沿用缓存</>}
                {marketValue.loss && <> · {marketValue.loss}</>}
                {marketValue.reason && <> · {marketValue.reason}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="workspace-columns">
        <section className="workspace-panel holdings-panel">
          <h2>持仓</h2>
          {visible.length ? (
            <div className="holdings-scroll">
              <table className="holdings-table">
                <thead>
                  <tr>
                    <th scope="col">基金</th>
                    {sortHeading('marketValue', '市值')}
                    {sortHeading('unrealizedGain', '浮动盈亏')}
                    <th scope="col">净值日期</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((position) => {
                    const { fundCode, marketValue, unrealizedGain } = position
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
                          <Money data={marketValue} />
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
                            <Money data={unrealizedGain} signed />
                          )}
                        </td>
                        <td className={marketValue.stale ? 'workspace-stale-date' : undefined}>
                          {marketValue.value === null ? '—' : marketValue.dataAsOf}
                          {marketValue.stale && <span className="workspace-subtle">沿用缓存</span>}
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
        <FundPanel
          code={active?.fundCode}
          name={active ? names.get(active.fundCode) : undefined}
          ledgerId={ledgerId}
          onReconcile={active ? () => onReconcile(active.fundCode) : undefined}
        />
      </div>
    </>
  )
}

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
