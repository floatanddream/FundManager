import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { api, type LedgerOverview, type PendingSubscription, type Sourced } from './api.ts'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.tsx'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group.tsx'
import { Alert, AlertDescription } from './components/ui/alert.tsx'

export type OverviewMotion = { id: string; marketValue: boolean; dailyGain: boolean }

const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })

/** 只有金额展示实际发生变化时才触发反馈，净值缺失继续由原状态提示。 */
function amountChanged(oldAmount: number | null, newAmount: number | null): boolean {
  return (
    newAmount !== null &&
    (oldAmount === null || currency.format(oldAmount) !== currency.format(newAmount))
  )
}

/** 待确认申购独立于持仓。确认后同时刷新列表和账本指标。 */
export function Subscriptions({
  ledgerId,
  onConfirmed,
  onOverviewChanged,
  arrivingDraftId,
  onDraftArrivalEnd,
}: {
  ledgerId: string
  onConfirmed: () => void
  onOverviewChanged: (motion: OverviewMotion) => void
  arrivingDraftId?: string
  onDraftArrivalEnd: (id: string) => void
}) {
  const client = useQueryClient()
  const sourceLabel = useId()
  const [active, setActive] = useState<PendingSubscription | null>(null)
  const pending = useQuery({
    queryKey: ['subscriptions', ledgerId],
    queryFn: ({ signal }) => api.subscriptions(ledgerId, signal),
  })
  const quote = useMutation({
    mutationFn: ({ id, ...body }: { id: string; navDate: string; fee: number }) =>
      api.quoteSubscription(ledgerId, id, body),
  })
  const confirm = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string
      navDate: string
      fee?: number
      shares?: number
      sequence?: number
    }) => api.confirmSubscription(ledgerId, id, body),
    onSuccess: async (saved) => {
      setActive(null)
      onConfirmed()
      const overviewKey = ['ledger-overview', ledgerId]
      const previous = client.getQueryData<Sourced<LedgerOverview>>(overviewKey)?.value
      const refreshOverview = client
        .invalidateQueries({ queryKey: overviewKey }, { throwOnError: true })
        .then(() => {
          const current = client.getQueryData<Sourced<LedgerOverview>>(overviewKey)?.value
          if (!previous || !current) return
          const marketValue = amountChanged(previous.marketValue.value, current.marketValue.value)
          const dailyGain = amountChanged(previous.dailyGain.value, current.dailyGain.value)
          if (marketValue || dailyGain) onOverviewChanged({ id: saved.id, marketValue, dailyGain })
        })
        .catch(() => {
          // 总览显示自己的取数错误。已确认的流水保持成功状态。
        })
      await Promise.all([
        client.invalidateQueries({ queryKey: ['subscriptions', ledgerId] }),
        refreshOverview,
        client.invalidateQueries({ queryKey: ['fund-return', ledgerId] }),
        client.invalidateQueries({ queryKey: ['portfolio-risk', ledgerId] }),
      ])
    },
  })
  const [navDate, setNavDate] = useState('')
  const [fee, setFee] = useState('')
  const [shares, setShares] = useState('')
  const [mode, setMode] = useState<'quote' | 'statement'>('quote')
  const [sequence, setSequence] = useState('')

  function openOrder(order: PendingSubscription) {
    setActive(order)
    setNavDate('')
    setFee('')
    setShares('')
    setMode('quote')
    setSequence('')
    quote.reset()
    confirm.reset()
  }
  function finalize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!active || confirm.isPending || (mode === 'quote' && quote.data?.shares == null)) return
    confirm.mutate({
      id: active.id,
      navDate,
      sequence: sequence === '' ? undefined : Number(sequence),
      ...(mode === 'quote' ? { fee: Number(fee) } : { shares: Number(shares) }),
    })
  }

  if (!active && !pending.isError && !pending.data?.length) return null

  return (
    <Card className="my-6" aria-labelledby="subscriptions-title">
      <CardHeader>
        <CardTitle id="subscriptions-title">待确认申购</CardTitle>
        <p className="text-sm text-muted-foreground">确认成交详情后，申购才会计入持仓。</p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {pending.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {pending.error.message}{' '}
              <Button type="button" variant="link" onClick={() => void pending.refetch()}>
                重试
              </Button>
            </AlertDescription>
          </Alert>
        ) : pending.data?.length ? (
          <ul className="grid gap-3">
            {pending.data.map((order) => (
              <li
                key={order.id}
                data-draft-arrival={order.id === arrivingDraftId ? 'true' : undefined}
                onAnimationEnd={
                  order.id === arrivingDraftId
                    ? (event) => {
                        if (event.target === event.currentTarget) onDraftArrivalEnd(order.id)
                      }
                    : undefined
                }
                className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0"
              >
                <div className="grid gap-1">
                  <strong>{order.fundCode}</strong>
                  <span>
                    {order.orderDate} · 申购金额 ¥
                    {order.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="link"
                  disabled={quote.isPending || confirm.isPending}
                  onClick={() => openOrder(order)}
                >
                  补充确认信息
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {active && (
          <form className="grid gap-4 rounded-lg border p-4" onSubmit={finalize}>
            <h3 className="font-medium">确认 {active.fundCode} 申购</h3>
            <p className="text-sm text-muted-foreground">
              申购金额 ¥{active.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })} ·
              下单日 {active.orderDate}
            </p>
            <label className="grid gap-2 text-sm font-medium">
              成交净值日期
              <Input
                type="date"
                min={active.orderDate}
                value={navDate}
                disabled={confirm.isPending}
                onChange={(e) => {
                  setNavDate(e.target.value)
                  quote.reset()
                }}
                required
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              同日顺序号（选填）
              <Input
                type="number"
                min="0"
                step="1"
                value={sequence}
                disabled={confirm.isPending}
                onChange={(e) => setSequence(e.target.value)}
              />
            </label>
            <fieldset disabled={confirm.isPending} className="grid gap-2">
              <legend id={sourceLabel}>份额来源</legend>
              <RadioGroup
                aria-labelledby={sourceLabel}
                disabled={confirm.isPending}
                value={mode}
                onValueChange={(value) => {
                  setMode(value as 'quote' | 'statement')
                  quote.reset()
                }}
                className="gap-3"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="quote" aria-labelledby={`${sourceLabel}-quote`} />
                  <span id={`${sourceLabel}-quote`}>按净值和实际费用计算</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="statement" aria-labelledby={`${sourceLabel}-statement`} />
                  <span id={`${sourceLabel}-statement`}>使用成交单份额</span>
                </label>
              </RadioGroup>
            </fieldset>
            {mode === 'quote' ? (
              <>
                <label className="grid gap-2 text-sm font-medium">
                  实际费用（元，免手续费填 0）
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={fee}
                    disabled={confirm.isPending}
                    onChange={(e) => {
                      setFee(e.target.value)
                      quote.reset()
                    }}
                    required
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!navDate || fee === '' || quote.isPending || confirm.isPending}
                  onClick={() => quote.mutate({ id: active.id, navDate, fee: Number(fee) })}
                >
                  查询并预览
                </Button>
                {quote.data && (
                  <div className="rounded-md bg-muted p-3 text-sm" role="status">
                    {quote.data.shares == null ? (
                      <p>{quote.data.reason ?? '无法计算份额，请核对净值日期或使用成交单份额。'}</p>
                    ) : (
                      <p>
                        确认净值 {quote.data.nav}（{quote.data.navDate}），实际费用 ¥{fee}，计算份额{' '}
                        {quote.data.shares.toFixed(4)}
                      </p>
                    )}
                  </div>
                )}
                {quote.error && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{quote.error.message}</AlertDescription>
                  </Alert>
                )}
              </>
            ) : (
              <label className="grid gap-2 text-sm font-medium">
                成交单确认份额
                <Input
                  type="number"
                  step="any"
                  value={shares}
                  disabled={confirm.isPending}
                  onChange={(e) => setShares(e.target.value)}
                  required
                />
              </label>
            )}
            {confirm.error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{confirm.error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={confirm.isPending}
                onClick={() => setActive(null)}
              >
                返回
              </Button>
              <Button
                type="submit"
                disabled={
                  confirm.isPending ||
                  (mode === 'quote' && (!quote.data || quote.data.shares == null))
                }
              >
                {confirm.isPending ? '正在确认…' : '确认申购'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
