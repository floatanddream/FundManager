import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from './api.ts'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.tsx'
import { Input } from './components/ui/input.tsx'
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.tsx'
import { FundSearch, Portfolio } from './Workspaces.tsx'
import {
  applyTheme,
  readThemePreference,
  saveThemePreference,
  type ThemePreference,
} from './theme.ts'
import './App.css'

const LedgerAction = lazy(() => import('./LedgerAction.tsx'))
const Subscriptions = lazy(() =>
  import('./Subscriptions.tsx').then((module) => ({ default: module.Subscriptions })),
)
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: false } },
})

type Action = { mode: 'transaction' | 'reconcile'; fundCode?: string }

/** 创建完成后再切换账本，让选择器和持仓使用同一份账本列表。 */
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

  /** 忽略重复提交与空白名称，避免创建无效账本。 */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (name.trim() && !create.isPending) create.mutate(name.trim())
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>
          <h2>新建账本</h2>
        </CardTitle>
        <CardDescription>账本中的流水和持仓保存在本机。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <label className="grid gap-2">
            账本名称
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          {create.error && (
            <Alert variant="destructive">
              <AlertDescription>{create.error.message}</AlertDescription>
            </Alert>
          )}
          <div className="workspace-actions">
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel}>
                取消
              </Button>
            )}
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? '正在创建…' : '创建账本'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

/** 维持账本、页面和抽屉的选择状态，切换账本时重建持仓视图。 */
function Workspace({
  themePreference,
  onThemeChange,
}: {
  themePreference: ThemePreference
  onThemeChange: (preference: ThemePreference) => void
}) {
  const [tab, setTab] = useState<'portfolio' | 'funds'>('portfolio')
  const [ledgerChoice, setLedgerChoice] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const [notice, setNotice] = useState('')
  const client = useQueryClient()

  const ledgers = useQuery({ queryKey: ['ledgers'], queryFn: ({ signal }) => api.ledgers(signal) })
  const list = ledgers.data?.value ?? []
  const ledger = list.find((entry) => entry.id === ledgerChoice) ?? list[0]

  /** 流水必须属于一个账本，首次使用时先引导建账。 */
  function openTransaction(fundCode?: string) {
    if (!ledger) {
      setTab('portfolio')
      setCreating(true)
      return
    }
    setNotice('')
    setAction({ mode: 'transaction', fundCode })
  }

  /** 流水写入后同时刷新持仓和 XIRR，避免两处展示不同版本的账本。 */
  function saved(result: 'pending-subscription' | 'transaction') {
    if (!ledger || action?.mode !== 'transaction') return
    setAction(null)
    if (result === 'pending-subscription') {
      setTab('portfolio')
      setNotice('已保存待确认申购')
      void client.invalidateQueries({ queryKey: ['subscriptions', ledger.id] })
      return
    }
    setNotice('流水已录入')
    void client.invalidateQueries({ queryKey: ['ledger-overview', ledger.id] })
    void client.invalidateQueries({ queryKey: ['fund-return', ledger.id] })
  }

  return (
    <>
      <header className="border-b">
        <div className="workspace-toolbar">
          <Button variant="ghost" onClick={() => setTab('portfolio')}>
            FundManager
          </Button>
          <NativeSelect
            className="workspace-ledger"
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
            {!ledger && <NativeSelectOption value="">选择账本</NativeSelectOption>}
            {list.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.name}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="new">新建账本</NativeSelectOption>
          </NativeSelect>
          <nav aria-label="主导航" className="workspace-nav">
            <Button
              variant={tab === 'portfolio' ? 'secondary' : 'ghost'}
              aria-current={tab === 'portfolio' ? 'page' : undefined}
              onClick={() => setTab('portfolio')}
            >
              组合
            </Button>
            <Button
              variant={tab === 'funds' ? 'secondary' : 'ghost'}
              aria-current={tab === 'funds' ? 'page' : undefined}
              onClick={() => setTab('funds')}
            >
              基金查询
            </Button>
          </nav>
          <Button
            className="toolbar-action"
            disabled={ledgers.isPending || ledgers.isError}
            onClick={() => openTransaction()}
          >
            <Plus size={17} aria-hidden="true" />
            录入流水
          </Button>
          <NativeSelect
            className="theme-select"
            aria-label="主题模式"
            value={themePreference}
            onChange={(event) => onThemeChange(event.target.value as ThemePreference)}
          >
            <NativeSelectOption value="system">跟随系统</NativeSelectOption>
            <NativeSelectOption value="light">亮色</NativeSelectOption>
            <NativeSelectOption value="dark">暗色</NativeSelectOption>
          </NativeSelect>
        </div>
      </header>

      <main className="workspace-main">
        {notice && (
          <Alert className="mb-4 flex items-center justify-between gap-3" role="status">
            <AlertTitle>{notice}</AlertTitle>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭提示"
              onClick={() => setNotice('')}
            >
              <X aria-hidden="true" />
            </Button>
          </Alert>
        )}
        {tab === 'funds' ? (
          <FundSearch ledgerId={ledger?.id} onRecord={openTransaction} />
        ) : (
          <>
            {(ledgers.isPending || ledgers.isError || creating || !ledger) && (
              <div className="workspace-page-heading">
                <h1>账本总览</h1>
              </div>
            )}
            {ledgers.isPending ? (
              <Alert role="status">
                <AlertDescription>正在读取账本…</AlertDescription>
              </Alert>
            ) : ledgers.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{ledgers.error.message}</AlertDescription>
                <div>
                  <Button variant="outline" onClick={() => void ledgers.refetch()}>
                    重试
                  </Button>
                </div>
              </Alert>
            ) : creating || !ledger ? (
              <LedgerSetup
                onCreated={(id) => {
                  setLedgerChoice(id)
                  setCreating(false)
                }}
                onCancel={ledger ? () => setCreating(false) : undefined}
              />
            ) : (
              <>
                <Suspense fallback={<p className="workspace-subtle">正在读取待确认申购…</p>}>
                  <Subscriptions
                    key={ledger.id}
                    ledgerId={ledger.id}
                    onConfirmed={() => setNotice('申购已确认入账')}
                  />
                </Suspense>
                <Portfolio
                  key={ledger.id}
                  ledgerId={ledger.id}
                  onSearch={() => setTab('funds')}
                  onReconcile={(fundCode) => {
                    setNotice('')
                    setAction({ mode: 'reconcile', fundCode })
                  }}
                />
              </>
            )}
          </>
        )}
      </main>

      {action && ledger && (
        <Suspense
          fallback={
            <div
              className="pointer-events-none fixed inset-0 z-50 grid place-items-center"
              role="status"
            >
              <Alert className="w-fit">
                <AlertDescription>正在打开表单…</AlertDescription>
              </Alert>
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

/** 装配工作台所用的查询缓存和主题偏好。 */
export default function App() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference)

  useEffect(() => {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
    const syncTheme = () => applyTheme(themePreference, systemTheme.matches)
    syncTheme()
    // 只有系统模式跟随设备变化，手动选择在当前会话中持续生效。
    if (themePreference === 'system') {
      systemTheme.addEventListener('change', syncTheme)
      return () => systemTheme.removeEventListener('change', syncTheme)
    }
  }, [themePreference])

  /** 先更新当前会话，再尝试保存，浏览器禁用存储时仍可切换。 */
  function changeTheme(preference: ThemePreference) {
    setThemePreference(preference)
    saveThemePreference(preference)
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Workspace themePreference={themePreference} onThemeChange={changeTheme} />
    </QueryClientProvider>
  )
}
