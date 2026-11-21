import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type TransactionInput } from './api.ts'
import './LedgerAction.css'

type Props = {
  mode: 'transaction' | 'reconcile'
  ledgerId: string
  fundCode?: string
  onClose: () => void
  onSaved: () => void
}

const kinds = [
  ['subscribe', '申购'],
  ['redeem', '赎回'],
  ['dividend_cash', '现金分红'],
  ['dividend_reinvest', '红利再投'],
  ['split', '份额折算'],
] as const

/** 日期输入使用本地日历日，避免午夜附近转成 UTC 后偏移一天。 */
const today = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * 使用原生模态抽屉录入流水或核对份额。
 *
 * @param props.onSaved 流水确认写入后刷新账本；对账结果留在抽屉里供核对。
 */
export default function LedgerAction({ mode, ledgerId, fundCode = '', onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const panel = useRef<HTMLElement>(null)
  const closing = useRef(false)
  const [code, setCode] = useState(fundCode)
  const [date, setDate] = useState(today())
  const [kind, setKind] = useState<TransactionInput['kind']>('subscribe')
  const [amount, setAmount] = useState('')
  const [shares, setShares] = useState('')
  const [ratio, setRatio] = useState('')
  const [sequence, setSequence] = useState('0')
  const [note, setNote] = useState('')
  const [claimed, setClaimed] = useState('')
  const [asOf, setAsOf] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.reconcile>>['value']>(null)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => {
      if (element?.open) element.close()
    }
  }, [])

  /** 保持模态状态直到退场结束，让焦点在抽屉隐藏后再回到触发控件。 */
  function dismiss(afterClose: () => void) {
    if (closing.current) return
    closing.current = true
    const element = panel.current
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      afterClose()
      return
    }
    dialog.current?.setAttribute('data-closing', '')
    const exit = element.animate(
      [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: 'translateX(36px)', opacity: 0 },
      ],
      { duration: 160, easing: 'ease-in', fill: 'forwards' },
    )
    void exit.finished.then(afterClose, afterClose)
  }

  /** 手工关闭时保留正在提交的表单，以便展示失败原因。 */
  function close() {
    if (!busy) dismiss(onClose)
  }

  /** 让后端执行账务校验，校验失败时保留填写值供用户修改。 */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || closing.current) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      if (mode === 'reconcile') {
        const response = await api.reconcile(ledgerId, {
          fundCode: code.trim(),
          claimedShares: Number(claimed),
          ...(asOf ? { asOf } : {}),
        })
        setResult(response.value)
      } else {
        // 用户按常用的正数填写，出入账方向按 API 约定在提交时转换。
        const input: TransactionInput = {
          fundCode: code.trim(),
          date,
          kind,
          amount: kind === 'subscribe' ? -Number(amount) : kind === 'split' ? 0 : Number(amount),
          sequence: Number(sequence),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(kind === 'subscribe' || kind === 'dividend_reinvest'
            ? { sharesDelta: Number(shares) }
            : kind === 'redeem'
              ? { sharesDelta: -Number(shares) }
              : kind === 'split'
                ? { splitRatio: Number(ratio) }
                : {}),
        }
        await api.addTransaction(ledgerId, input)
        dismiss(onSaved)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  const needsShares = kind === 'subscribe' || kind === 'redeem' || kind === 'dividend_reinvest'
  const direction =
    kind === 'subscribe'
      ? `将写入：金额 −${amount || '0'}，份额 +${shares || '0'}。`
      : kind === 'redeem'
        ? `将写入：到账金额 +${amount || '0'}，份额 −${shares || '0'}。`
        : kind === 'dividend_cash'
          ? `将写入：金额 +${amount || '0'}，份额不变。`
          : kind === 'dividend_reinvest'
            ? `将写入：金额 +${amount || '0'}，份额 +${shares || '0'}。`
            : `将写入：折算比例 ${ratio || '0'}，金额 0。`

  return (
    <dialog
      ref={dialog}
      className="ledger-action"
      aria-labelledby="ledger-action-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="ledger-action__scrim" onClick={close} aria-hidden="true" />
      <section className="ledger-action__panel" ref={panel}>
        <header className="ledger-action__header">
          <div>
            <p className="ledger-action__eyebrow">账本操作</p>
            <h2 id="ledger-action-title">{mode === 'transaction' ? '录入流水' : '份额对账'}</h2>
          </div>
          <button
            type="button"
            className="ledger-action__close"
            onClick={close}
            aria-label="关闭"
            disabled={busy}
          >
            ×
          </button>
        </header>
        <form onSubmit={submit} className="ledger-action__form">
          <label>
            基金代码
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              placeholder="例如 011609"
            />
          </label>
          {mode === 'transaction' ? (
            <>
              <label>
                流水类型
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as TransactionInput['kind'])}
                >
                  {kinds.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                发生日期
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </label>
              {kind !== 'split' && (
                <label>
                  {kind === 'subscribe'
                    ? '申购金额'
                    : kind === 'redeem'
                      ? '赎回到账金额'
                      : kind === 'dividend_cash'
                        ? '现金分红金额'
                        : '红利再投金额'}
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </label>
              )}
              {needsShares && (
                <label>
                  {kind === 'redeem' ? '赎回份额' : '增加份额'}
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={shares}
                    onChange={(e) => setShares(e.target.value)}
                    required
                  />
                </label>
              )}
              {kind === 'split' && (
                <label>
                  折算比例
                  <input
                    type="number"
                    min="0.00000001"
                    step="any"
                    value={ratio}
                    onChange={(e) => setRatio(e.target.value)}
                    required
                    placeholder="例如 1.2"
                  />
                </label>
              )}
              <label>
                同日顺序号
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={sequence}
                  onChange={(e) => setSequence(e.target.value)}
                  required
                />
              </label>
              <p className="ledger-action__hint">
                同一天多笔流水的序号从 0 起且不能重复。默认
                0，可按实际先后调整。若已有一笔旧流水未编号，补录在它之后时请填 1 或更大。
              </p>
              <label>
                备注 <span className="ledger-action__optional">选填</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
              </label>
              <p className="ledger-action__direction">{direction}</p>
            </>
          ) : (
            <>
              <label>
                平台实际份额
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={claimed}
                  onChange={(e) => setClaimed(e.target.value)}
                  required
                />
              </label>
              <label>
                对账截止日 <span className="ledger-action__optional">选填，默认今天</span>
                <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              </label>
              <p className="ledger-action__hint">
                对账只比较平台份额与流水推导份额并显示差异，不会自动修改账本。
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="ledger-action__error">
              {error}
            </p>
          )}
          {result && (
            <section
              className={`ledger-action__result ${result.matched ? 'is-matched' : 'is-unmatched'}`}
              aria-live="polite"
            >
              <strong>{result.matched ? '份额一致' : '份额不一致'}</strong>
              <p>
                平台份额 {result.claimedShares} · 流水推导 {result.derivedShares}
              </p>
              <p>差异（推导 − 平台）{result.difference}</p>
              <p>上次对账一致：{result.lastMatchedOn ?? '暂无记录'}</p>
            </section>
          )}
          <footer className="ledger-action__footer">
            <button
              type="button"
              className="ledger-action__secondary"
              onClick={close}
              disabled={busy}
            >
              取消
            </button>
            <button type="submit" className="ledger-action__primary" disabled={busy}>
              {busy ? '处理中…' : mode === 'transaction' ? '确认录入' : '开始对账'}
            </button>
          </footer>
        </form>
      </section>
    </dialog>
  )
}
