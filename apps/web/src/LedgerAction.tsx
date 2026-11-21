import { useRef, useState, type FormEvent } from 'react'
import { api, type TransactionInput } from './api.ts'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { Sheet, SheetContent, SheetTitle } from './components/ui/sheet.tsx'
import './LedgerAction.css'

type Props = {
  mode: 'transaction' | 'reconcile'
  ledgerId: string
  fundCode?: string
  onClose: () => void
  onSaved: (result: 'pending-subscription' | 'transaction') => void
}

const kinds = [
  ['subscribe', '申购'],
  ['redeem', '赎回'],
  ['dividend_cash', '现金分红'],
  ['dividend_reinvest', '红利再投'],
  ['split', '份额折算'],
] as const

/** 场外基金的账本日期统一按中国时区，海外浏览器也默认到同一个交易日期。 */
const today = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

/**
 * 使用 shadcn 抽屉录入流水或核对份额。
 *
 * @param props.onSaved 流水确认写入后刷新账本；对账结果留在抽屉里供核对。
 */
export default function LedgerAction({ mode, ledgerId, fundCode = '', onClose, onSaved }: Props) {
  const afterClose = useRef<(() => void) | null>(null)
  const [open, setOpen] = useState(true)
  const codeInput = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState(fundCode)
  const [date, setDate] = useState(today)
  const [kind, setKind] = useState<TransactionInput['kind']>('subscribe')
  const [hasStatement, setHasStatement] = useState(false)
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
  const isSubscriptionDraft = kind === 'subscribe' && !hasStatement

  /** 等 Sheet 播完退场动效、归还焦点后再卸载整个表单。 */
  function dismiss(callback: () => void) {
    if (afterClose.current) return
    afterClose.current = callback
    setOpen(false)
  }

  /** 手工关闭时保留正在提交的表单，以便展示失败原因。 */
  function close() {
    if (!busy) dismiss(onClose)
  }

  /** 让后端执行账务校验，校验失败时保留填写值供用户修改。 */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || afterClose.current) return
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
        if (isSubscriptionDraft) {
          await api.addSubscription(ledgerId, {
            fundCode: code.trim(),
            orderDate: date,
            amount: Number(amount),
          })
          dismiss(() => onSaved('pending-subscription'))
          return
        }
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
        dismiss(() => onSaved('transaction'))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  const needsShares =
    kind === 'redeem' || kind === 'dividend_reinvest' || (kind === 'subscribe' && hasStatement)
  const direction =
    kind === 'subscribe'
      ? isSubscriptionDraft
        ? '先保存申购金额，等确认净值或回单可用后再入账。'
        : `按回单入账，金额 −${amount || '0'}，增加 ${shares || '0'} 份。`
      : kind === 'redeem'
        ? `将写入：到账金额 +${amount || '0'}，份额 −${shares || '0'}。`
        : kind === 'dividend_cash'
          ? `将写入：金额 +${amount || '0'}，份额不变。`
          : kind === 'dividend_reinvest'
            ? `将写入：金额 +${amount || '0'}，份额 +${shares || '0'}。`
            : `将写入：折算比例 ${ratio || '0'}，金额 0。`

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close()
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) afterClose.current?.()
      }}
    >
      <SheetContent
        className="ledger-action__panel"
        overlayClassName="ledger-action__overlay"
        showCloseButton={false}
        initialFocus={codeInput}
      >
        <header className="ledger-action__header">
          <div>
            <p className="ledger-action__eyebrow">账本操作</p>
            <SheetTitle className="ledger-action__title">
              {mode === 'transaction' ? '录入流水' : '份额对账'}
            </SheetTitle>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="ledger-action__close"
            onClick={close}
            aria-label="关闭"
            disabled={busy}
          >
            ×
          </Button>
        </header>
        <form onSubmit={submit} className="ledger-action__form">
          <label>
            基金代码
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              data-ledger-autofocus
              ref={codeInput}
              placeholder="例如 011609"
            />
          </label>
          {mode === 'transaction' ? (
            <>
              <label>
                流水类型
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as TransactionInput['kind'])
                    setHasStatement(false)
                  }}
                >
                  {kinds.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {kind === 'subscribe' && (
                <Button
                  variant="link"
                  className="workspace-text-button"
                  type="button"
                  onClick={() => setHasStatement(!hasStatement)}
                >
                  {hasStatement ? '返回金额申购' : '已有回单，直接入账'}
                </Button>
              )}
              <label>
                {isSubscriptionDraft
                  ? '交易日期'
                  : kind === 'subscribe'
                    ? '成交净值日期'
                    : '发生日期'}
                <Input
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
                  <Input
                    type="number"
                    min={kind === 'subscribe' ? '0.01' : '0'}
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </label>
              )}
              {needsShares && (
                <label>
                  {kind === 'subscribe'
                    ? '回单确认份额'
                    : kind === 'redeem'
                      ? '赎回份额'
                      : '增加份额'}
                  <Input
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
                  <Input
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
              {!isSubscriptionDraft && (
                <>
                  <label>
                    同日顺序号
                    <Input
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
                    <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
                  </label>
                </>
              )}
              <p className="ledger-action__direction">{direction}</p>
            </>
          ) : (
            <>
              <label>
                平台实际份额
                <Input
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
                <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
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
            <Button
              type="button"
              variant="outline"
              className="ledger-action__secondary"
              onClick={close}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="submit" className="ledger-action__primary" disabled={busy}>
              {busy
                ? '处理中…'
                : mode === 'transaction'
                  ? isSubscriptionDraft
                    ? '保存待确认'
                    : '确认录入'
                  : '开始对账'}
            </Button>
          </footer>
        </form>
      </SheetContent>
    </Sheet>
  )
}
