import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import type { ComposeOption } from 'echarts/core'
import { LineChart, type LineSeriesOption } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  type GridComponentOption,
  type TooltipComponentOption,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { api, type NavPoint, type Sourced } from './api.ts'
import './FundDetail.css'

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

type ChartOption = ComposeOption<LineSeriesOption | GridComponentOption | TooltipComponentOption>
type Props = { fundCode: string; name?: string; ledgerId?: string }
const ranges = [
  [1, '1月'],
  [3, '3月'],
  [6, '6月'],
  [12, '1年'],
] as const

/** 用同一组净值点绘图和生成无障碍摘要，避免读屏信息与图形不一致。 */
function Chart({ points, label }: { points: NavPoint[]; label: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const chart = echarts.init(element)
    /** 从页面主题取颜色，确保手动切换时画布能跟随界面。 */
    function renderChart() {
      if (!element) return
      const styles = getComputedStyle(element)
      const ink = styles.getPropertyValue('--ink').trim()
      const muted = styles.getPropertyValue('--muted').trim()
      const line = styles.getPropertyValue('--line').trim()
      const accent = styles.getPropertyValue('--accent').trim()
      const surface = styles.getPropertyValue('--surface').trim()
      const option: ChartOption = {
        animation: false,
        grid: { left: 53, right: 16, top: 15, bottom: 35 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: surface,
          borderColor: line,
          textStyle: { color: ink },
          valueFormatter: (value) => Number(value).toFixed(4),
        },
        xAxis: {
          type: 'category',
          data: points.map((point) => point.date),
          boundaryGap: false,
          axisLine: { lineStyle: { color: line } },
          axisTick: { show: false },
          axisLabel: {
            color: muted,
            hideOverlap: true,
            formatter: (date: string) => date.slice(5),
          },
        },
        yAxis: {
          type: 'value',
          scale: true,
          splitLine: { lineStyle: { color: line } },
          axisLabel: { color: muted },
        },
        series: [
          {
            type: 'line',
            name: label,
            data: points.map((point) => point.value),
            showSymbol: points.length === 1,
            lineStyle: { width: 2, color: accent },
            itemStyle: { color: accent },
          },
        ],
      }
      chart.setOption(option)
    }

    renderChart()
    const sizeObserver = new ResizeObserver(() => chart.resize())
    sizeObserver.observe(element)
    // Canvas 中的颜色已经绘制完成，CSS 主题切换后必须重新配置图表。
    const themeObserver = new MutationObserver(renderChart)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => {
      themeObserver.disconnect()
      sizeObserver.disconnect()
      chart.dispose()
    }
  }, [label, points])

  const first = points[0]!
  const last = points.at(-1)!
  return (
    <div
      className="fund-detail-chart"
      ref={host}
      role="img"
      aria-label={`${label}走势，${first.date} 为 ${first.value.toFixed(4)}，${last.date} 为 ${last.value.toFixed(4)}`}
    />
  )
}

/** 在数字旁保留数据时点与降级说明，展开后可追溯来源。 */
function DataSource({
  data,
  showSource = true,
}: {
  data?: Sourced<unknown>
  showSource?: boolean
}) {
  if (!data) return null
  return (
    <div className="fd-source">
      {data.value !== null && <span>数据截至 {data.dataAsOf}</span>}
      {data.stale && <span className="fd-warning">沿用缓存</span>}
      {data.loss && <p className="fd-warning">{data.loss}</p>}
      {showSource && (
        <details>
          <summary>查看来源</summary>
          <p>
            {data.source} · 抓取于 {data.capturedAt.replace('T', ' ')}
          </p>
        </details>
      )}
    </div>
  )
}

/** 分别呈现零值、缺值和请求失败，避免把未知收益显示成零。 */
function Metric({
  label,
  data,
  pending,
  error,
  signed,
}: {
  label: string
  data?: Sourced<number>
  pending?: boolean
  error?: Error | null
  signed?: boolean
}) {
  const value = data?.value
  const tone = signed && value ? (value > 0 ? 'gain-positive' : 'gain-negative') : undefined
  return (
    <div className="fd-metric">
      <span>{label}</span>
      <strong className={tone}>
        {value == null ? '—' : `${signed && value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`}
      </strong>
      {pending && <p role="status">正在读取…</p>}
      {error && (
        <p role="alert" className="fd-error">
          {error.message}
        </p>
      )}
      {data?.reason && <p>{data.reason}</p>}
      <DataSource data={data} showSource={false} />
    </div>
  )
}

/** 用目标月的最后一天限制日号，避免 31 日减一个月后溢出到下个月。 */
function startOfRange(date: string, months: number) {
  const [year, month, day] = date.split('-').map(Number)
  const last = new Date(Date.UTC(year!, month! - months, 0))
  const start = new Date(
    Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), Math.min(last.getUTCDate(), day!)),
  )
  return start.toISOString().slice(0, 10)
}

/**
 * 查看基金净值和风险，账本内的基金另显示个人 XIRR。
 *
 * @param props.ledgerId 省略时只查询公开市场数据。
 */
export default function FundDetail({ fundCode, name, ledgerId }: Props) {
  const [adjusted, setAdjusted] = useState(true)
  const [range, setRange] = useState<(typeof ranges)[number][0]>(3)
  const info = useQuery({
    queryKey: ['fund-info', fundCode],
    queryFn: ({ signal }) => api.fundInfo(fundCode, signal),
    staleTime: 60 * 60 * 1000,
  })
  const nav = useQuery({
    queryKey: ['fund-nav', fundCode],
    queryFn: ({ signal }) => api.nav(fundCode, signal),
  })
  const risk = useQuery({
    queryKey: ['fund-risk', fundCode],
    queryFn: ({ signal }) => api.fundRisk(fundCode, signal),
  })
  const returns = useQuery({
    queryKey: ['fund-return', ledgerId, fundCode],
    queryFn: ({ signal }) => api.fundReturn(ledgerId!, fundCode, signal),
    enabled: Boolean(ledgerId),
  })

  const series = adjusted ? nav.data?.adjusted : nav.data?.nav
  const label = adjusted ? '复权净值' : '单位净值'
  const points = useMemo(() => {
    const rows = adjusted
      ? nav.data?.adjusted.value
      : nav.data?.nav.value?.rows.map((row) => row.nav)
    if (!rows?.length) return []
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))
    // 从最后一个净值日往前取区间，停更或沿用缓存时图仍显示对应的历史范围。
    const start = startOfRange(sorted.at(-1)!.date, range)
    return sorted.filter((point) => point.date >= start)
  }, [adjusted, nav.data, range])
  const fields = info.data?.value?.fields
  const details = info.data?.value

  return (
    <div className="fund-detail">
      <header className="fd-header">
        <div>
          <h2>{name || fields?.['基金简称'] || fields?.['基金全称'] || fundCode}</h2>
          <p>
            {fundCode}
            {fields?.['基金类型'] && ` · ${fields['基金类型']}`}
          </p>
        </div>
      </header>

      <div className="fd-chart-controls">
        <div className="fd-segments" role="group" aria-label="净值口径">
          <button aria-pressed={adjusted} onClick={() => setAdjusted(true)}>
            复权净值
          </button>
          <button aria-pressed={!adjusted} onClick={() => setAdjusted(false)}>
            单位净值
          </button>
        </div>
        <div className="fd-segments" role="group" aria-label="图表区间">
          {ranges.map(([months, title]) => (
            <button key={months} aria-pressed={range === months} onClick={() => setRange(months)}>
              {title}
            </button>
          ))}
        </div>
      </div>
      {nav.isPending ? (
        <div className="fd-state" role="status">
          正在读取净值…
        </div>
      ) : nav.isError ? (
        <div className="fd-state fd-error" role="alert">
          <p>{nav.error.message}</p>
          <button className="workspace-text-button" onClick={() => void nav.refetch()}>
            重试
          </button>
        </div>
      ) : points.length ? (
        <Chart key={`${label}/${range}`} points={points} label={label} />
      ) : (
        <div className="fd-state">
          <p>{series?.reason ?? '该区间暂无净值数据。'}</p>
          {adjusted && nav.data.nav.value && (
            <button className="workspace-text-button" onClick={() => setAdjusted(false)}>
              查看单位净值
            </button>
          )}
        </div>
      )}
      <DataSource data={series} />

      <div className="fd-stats" aria-label="基金指标">
        {ledgerId && (
          <Metric
            label="年化收益（XIRR）"
            data={returns.data?.value?.xirr}
            pending={returns.isPending}
            error={returns.error}
            signed
          />
        )}
        <Metric
          label="历史最大回撤"
          data={risk.data?.maxDrawdown}
          pending={risk.isPending}
          error={risk.error}
        />
      </div>
      {!ledgerId &&
        (details ? (
          <details className="fd-profile">
            <summary>基金档案</summary>
            <dl>
              {fields?.['基金管理人'] && (
                <div>
                  <dt>基金管理人</dt>
                  <dd>{fields['基金管理人']}</dd>
                </div>
              )}
              {fields?.['基金经理人'] && (
                <div>
                  <dt>基金经理</dt>
                  <dd>{fields['基金经理人']}</dd>
                </div>
              )}
              {details.benchmark && (
                <div>
                  <dt>业绩比较基准</dt>
                  <dd>{details.benchmark}</dd>
                </div>
              )}
              {details.trackingTarget && (
                <div>
                  <dt>跟踪标的</dt>
                  <dd>{details.trackingTarget}</dd>
                </div>
              )}
            </dl>
            <DataSource data={info.data} />
          </details>
        ) : info.isError ? (
          <p className="fd-error" role="status">
            基金档案暂不可用。
          </p>
        ) : null)}
    </div>
  )
}
