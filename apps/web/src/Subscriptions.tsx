import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, type PendingSubscription } from './api.ts'

/** 待确认申购独立于持仓。确认后同时刷新列表和账本指标。 */
export function Subscriptions({
  ledgerId,
  onConfirmed,
}: {
  ledgerId: string
  onConfirmed: () => void
}) {
  const client = useQueryClient()
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
    onSuccess: async () => {
      setActive(null)
      onConfirmed()
      await Promise.all([
        client.invalidateQueries({ queryKey: ['subscriptions', ledgerId] }),
        client.invalidateQueries({ queryKey: ['ledger-overview', ledgerId] }),
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
    <section className="subscription-panel" aria-labelledby="subscriptions-title">
      <div className="subscription-head">
        <div>
          <h2 id="subscriptions-title">待确认申购</h2>
          <p>确认成交详情后，申购才会计入持仓。</p>
        </div>
      </div>
      {pending.isError ? (
        <p role="alert" className="workspace-error">
          {pending.error.message}{' '}
          <button className="workspace-text-button" onClick={() => void pending.refetch()}>
            重试
          </button>
        </p>
      ) : pending.data?.length ? (
        <ul className="subscription-list">
          {pending.data.map((order) => (
            <li key={order.id}>
              <div>
                <strong>{order.fundCode}</strong>
                <span>
                  {order.orderDate} · 申购金额 ¥
                  {order.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <button
                className="workspace-text-button"
                disabled={quote.isPending || confirm.isPending}
                onClick={() => openOrder(order)}
              >
                补充确认信息
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {active && (
        <form className="subscription-form" onSubmit={finalize}>
          <h3>确认 {active.fundCode} 申购</h3>
          <p>
            申购金额 ¥{active.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })} · 下单日{' '}
            {active.orderDate}
          </p>
          <label>
            成交净值日期
            <input
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
          <label>
            同日顺序号（选填）
            <input
              type="number"
              min="0"
              step="1"
              value={sequence}
              disabled={confirm.isPending}
              onChange={(e) => setSequence(e.target.value)}
            />
          </label>
          <fieldset disabled={confirm.isPending}>
            <legend>份额来源</legend>
            <label className="subscription-choice">
              <input
                type="radio"
                name="share-source"
                checked={mode === 'quote'}
                onChange={() => {
                  setMode('quote')
                  quote.reset()
                }}
              />
              按净值和实际费用计算
            </label>
            <label className="subscription-choice">
              <input
                type="radio"
                name="share-source"
                checked={mode === 'statement'}
                onChange={() => {
                  setMode('statement')
                  quote.reset()
                }}
              />
              使用成交单份额
            </label>
          </fieldset>
          {mode === 'quote' ? (
            <>
              <label>
                实际费用（元，免手续费填 0）
                <input
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
              <button
                type="button"
                className="workspace-button secondary"
                disabled={!navDate || fee === '' || quote.isPending || confirm.isPending}
                onClick={() => quote.mutate({ id: active.id, navDate, fee: Number(fee) })}
              >
                查询并预览
              </button>
              {quote.data && (
                <div className="subscription-preview" role="status">
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
                <p role="alert" className="workspace-error">
                  {quote.error.message}
                </p>
              )}
            </>
          ) : (
            <label>
              成交单确认份额
              <input
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
            <p role="alert" className="workspace-error">
              {confirm.error.message}
            </p>
          )}
          <div className="workspace-actions">
            <button
              type="button"
              className="workspace-button secondary"
              disabled={confirm.isPending}
              onClick={() => setActive(null)}
            >
              返回
            </button>
            <button
              className="workspace-button"
              disabled={
                confirm.isPending ||
                (mode === 'quote' && (!quote.data || quote.data.shares == null))
              }
            >
              {confirm.isPending ? '正在确认…' : '确认申购'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
