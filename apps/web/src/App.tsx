import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ChevronDown, Plus } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from './api.ts'
import { FundSearch, Portfolio } from './Workspaces.tsx'
import './App.css'

const LedgerAction = lazy(() => import('./LedgerAction.tsx'))
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: false } },
})

type Action = { mode: 'transaction' | 'reconcile'; fundCode?: string }

function LedgerSetup({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void
  onCancel?: () => void
}) {
  const [name, setName] = useState('')
  const client = useQueryClient()
  const create = useMutation({
    mutationFn: api.addLedger,
    onSuccess: async (result) => {
      if (!result.value) return
      await client.invalidateQueries({ queryKey: ['ledgers'] })
      onCreated(result.value.id)
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (name.trim() && !create.isPending) create.mutate(name.trim())
  }

  return (
    <section className="workspace-panel setup-panel">
      <h2>新建账本</h2>
      <p>账本中的流水和持仓保存在本机。</p>
      <form onSubmit={submit}>
        <label htmlFor="ledger-name">账本名称</label>
        <input
          id="ledger-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        {create.error && (
          <p role="alert" className="workspace-error">
            {create.error.message}
          </p>
        )}
        <div className="workspace-actions">
          {onCancel && (
            <button type="button" className="workspace-button secondary" onClick={onCancel}>
              取消
            </button>
          )}
          <button className="workspace-button" disabled={!name.trim() || create.isPending}>
            {create.isPending ? '正在创建…' : '创建账本'}
          </button>
        </div>
      </form>
    </section>
  )
}

function Workspace() {
  const [tab, setTab] = useState<'portfolio' | 'funds'>('portfolio')
  const [ledgerChoice, setLedgerChoice] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const [notice, setNotice] = useState('')
  const client = useQueryClient()

  const ledgers = useQuery({ queryKey: ['ledgers'], queryFn: ({ signal }) => api.ledgers(signal) })
  const list = ledgers.data?.value ?? []
  const ledger = list.find((entry) => entry.id === ledgerChoice) ?? list[0]

  function openTransaction(fundCode?: string) {
    if (!ledger) {
      setTab('portfolio')
      setCreating(true)
      return
    }
    setNotice('')
    setAction({ mode: 'transaction', fundCode })
  }

  function saved() {
    if (!ledger || action?.mode !== 'transaction') return
    setAction(null)
    setNotice('流水已录入')
    void client.invalidateQueries({ queryKey: ['positions', ledger.id] })
    void client.invalidateQueries({ queryKey: ['fund-return', ledger.id] })
  }

  return (
    <>
      <header className="workspace-header">
        <div className="workspace-toolbar">
          <button className="workspace-wordmark" onClick={() => setTab('portfolio')}>
            FundManager
          </button>
          <div className="workspace-ledger">
            <select
              aria-label="当前账本"
              value={ledger?.id ?? ''}
              disabled={ledgers.isPending || ledgers.isError}
              onChange={(event) => {
                if (event.target.value === 'new') {
                  setTab('portfolio')
                  setCreating(true)
                } else {
                  setLedgerChoice(event.target.value)
                  setCreating(false)
                  setNotice('')
                }
              }}
            >
              {!ledger && <option value="">选择账本</option>}
              {list.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
              <option value="new">新建账本</option>
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </div>
          <nav aria-label="主导航" className="workspace-nav">
            <button
              aria-current={tab === 'portfolio' ? 'page' : undefined}
              onClick={() => setTab('portfolio')}
            >
              组合
            </button>
            <button
              aria-current={tab === 'funds' ? 'page' : undefined}
              onClick={() => setTab('funds')}
            >
              基金查询
            </button>
          </nav>
          <button
            className="workspace-button toolbar-action"
            disabled={ledgers.isPending || ledgers.isError}
            onClick={() => openTransaction()}
          >
            <Plus size={17} aria-hidden="true" />
            录入流水
          </button>
        </div>
      </header>

      <main className="workspace-main">
        {notice && (
          <div className="workspace-notice" role="status">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice('')}>
              ×
            </button>
          </div>
        )}
        {tab === 'funds' ? (
          <FundSearch ledgerId={ledger?.id} onRecord={openTransaction} />
        ) : (
          <>
            <div className="workspace-page-heading">
              <h1>当前组合</h1>
            </div>
            {ledgers.isPending ? (
              <p className="workspace-panel workspace-empty" role="status">
                正在读取账本…
              </p>
            ) : ledgers.isError ? (
              <div className="workspace-panel workspace-empty">
                <p role="alert">{ledgers.error.message}</p>
                <button
                  className="workspace-button secondary"
                  onClick={() => void ledgers.refetch()}
                >
                  重试
                </button>
              </div>
            ) : creating || !ledger ? (
              <LedgerSetup
                onCreated={(id) => {
                  setLedgerChoice(id)
                  setCreating(false)
                }}
                onCancel={ledger ? () => setCreating(false) : undefined}
              />
            ) : (
              <Portfolio
                key={ledger.id}
                ledgerId={ledger.id}
                onSearch={() => setTab('funds')}
                onReconcile={(fundCode) => {
                  setNotice('')
                  setAction({ mode: 'reconcile', fundCode })
                }}
              />
            )}
          </>
        )}
      </main>

      {action && ledger && (
        <Suspense
          fallback={
            <div className="workspace-overlay-loading" role="status">
              正在打开表单…
            </div>
          }
        >
          <LedgerAction
            key={`${ledger.id}/${action.mode}/${action.fundCode ?? ''}`}
            {...action}
            ledgerId={ledger.id}
            onClose={() => setAction(null)}
            onSaved={saved}
          />
        </Suspense>
      )}
    </>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Workspace />
    </QueryClientProvider>
  )
}
