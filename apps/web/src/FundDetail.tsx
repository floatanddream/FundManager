import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
import { Button } from './components/ui/button.tsx'
import './FundDetail.css'

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

type ChartOption = ComposeOption<LineSeriesOption | GridComponentOption | TooltipComponentOption>
type Props = {
  fundCode: string
  name?: string
  ledgerId?: string
  ledgerSummary?: ReactNode
  animateEntry?: boolean
}
const ranges = [
  [1, '1月'],
  [3, '3月'],
  [6, '6月'],
  [12, '1年'],
] as const

/** 用同一组净值点绘图和生成无障碍摘要，避免读屏信息与图形不一致。 */
function Chart({
  points,
  label,
  rangeMotion,
}: {
  points: NavPoint[]
  label: string
  rangeMotion?: number
}) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const chart = echarts.init(element)
    const colorCanvas = document.createElement('canvas')
    colorCanvas.width = colorCanvas.height = 1
    const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true })
    /** 从页面主题取颜色，确保手动切换时画布能跟随界面。 */
    function renderChart() {
      if (!element) return
      const styles = getComputedStyle(element)
      const resolveColor = (token: string, fallback: string) => {
        const value = styles.getPropertyValue(token).trim() || fallback
        if (!colorContext) return value
        // shadcn 的 oklch 颜色由浏览器转换后再交给 ECharts。
        colorContext.clearRect(0, 0, 1, 1)
        colorContext.fillStyle = fallback
        colorContext.fillStyle = value
        colorContext.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data
        return `rgba(${r}, ${g}, ${b}, ${(a ?? 255) / 255})`
      }
      const ink = resolveColor('--foreground', '#18181b')
      const muted = resolveColor('--muted-foreground', '#71717a')
      const line = resolveColor('--border', '#e4e4e7')
      const accent = resolveColor('--primary', '#404040')
      const surface = resolveColor('--popover', '#ffffff')
      const option: ChartOption = {
        animation: false,
        grid: { left: 53, right: 16, top: 15, bottom: 35 },
        tooltip: {
          trigger: 'axis',
          confine: true,
          backgroundColor: surface,
          borderColor: line,
          textStyle: { color: ink },
          valueFormatter: (value) => Number(value).toFixed(4),
          axisPointer: { type: 'line', snap: true, lineStyle: { color: muted, type: 'dashed' } },
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
            symbolSize: 7,
            lineStyle: { width: 2, color: accent },
            itemStyle: { color: accent },
            emphasis: {
              focus: 'series',
              scale: 1.7,
              itemStyle: { borderColor: surface, borderWidth: 2 },
            },
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

  // 曲线已经按实值绘制完成。月份切换只淡入画布，不插值生成中间净值。
  useEffect(() => {
    const element = host.current
    if (
      !element ||
      rangeMotion === undefined ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return
    const animation = element.animate([{ opacity: 0.55 }, { opacity: 1 }], {
      duration: 170,
      easing: 'ease-out',
    })
    return () => animation.cancel()
  }, [rangeMotion])

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
 * @param props.ledgerSummary 账本提供同一净值日的市值和收益，基金查询可以省略。
 */
export default function FundDetail({
  fundCode,
  name,
  ledgerId,
  ledgerSummary,
  animateEntry,
}: Props) {
  const [adjusted, setAdjusted] = useState(true)
  const [range, setRange] = useState<(typeof ranges)[number][0]>(3)
  const [rangeMotion, setRangeMotion] = useState<number>()
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

  function selectBasis(next: boolean) {
    if (next === adjusted) return
    setRangeMotion(undefined)
    setAdjusted(next)
  }

  return (
    <div className="fund-detail">
      <header className="fd-header">
        <div>
          <h2 className="text-base font-medium">
            {name || fields?.['基金简称'] || fields?.['基金全称'] || fundCode}
          </h2>
          <p>
            {fundCode}
            {fields?.['基金类型'] && ` · ${fields['基金类型']}`}
          </p>
        </div>
      </header>

      <div className={animateEntry ? 'fd-entry' : undefined}>
        {ledgerSummary}
        <div className="fd-chart-controls">
          <div className="fd-segments" role="group" aria-label="净值口径">
            <Button
              variant={adjusted ? 'secondary' : 'ghost'}
              aria-pressed={adjusted}
              onClick={() => selectBasis(true)}
            >
              复权净值
            </Button>
            <Button
              variant={!adjusted ? 'secondary' : 'ghost'}
              aria-pressed={!adjusted}
              onClick={() => selectBasis(false)}
            >
              单位净值
            </Button>
          </div>
          <div className="fd-segments" role="group" aria-label="图表区间">
            {ranges.map(([months, title]) => (
              <Button
                key={months}
                variant={range === months ? 'secondary' : 'ghost'}
                aria-pressed={range === months}
                onClick={() => {
                  if (range !== months) {
                    setRangeMotion((token) => (token ?? 0) + 1)
                    setRange(months)
                  }
                }}
              >
                {title}
              </Button>
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
            <Button variant="link" onClick={() => void nav.refetch()}>
              重试
            </Button>
          </div>
        ) : points.length ? (
          <Chart points={points} label={label} rangeMotion={rangeMotion} />
        ) : (
          <div className="fd-state">
            <p>{series?.reason ?? '该区间暂无净值数据。'}</p>
            {adjusted && nav.data.nav.value && (
              <Button variant="link" onClick={() => selectBasis(false)}>
                查看单位净值
              </Button>
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
    </div>
  )
}
