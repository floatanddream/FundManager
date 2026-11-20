export type Sourced<T> = {
  value: T | null
  reason: string | null
  source: string
  dataAsOf: string
  capturedAt: string
  stale: boolean
  loss: string | null
}

export type Ledger = { id: string; name: string }

export type Position = {
  fundCode: string
  shares: number
  marketValue: Sourced<number>
  unrealizedGain: Sourced<number>
  realizedGain: number
  cost: Sourced<number>
}

export type Fund = { code: string; name: string; category: string }
export type NavPoint = { date: string; value: number }

export type TransactionInput = {
  fundCode: string
  date: string
  kind: 'subscribe' | 'redeem' | 'dividend_cash' | 'dividend_reinvest' | 'split'
  amount: number
  sharesDelta?: number | null
  splitRatio?: number | null
  sequence?: number | null
  note?: string
}

type FundInfo = {
  fields: Record<string, string>
  benchmark: string | null
  trackingTarget: string | null
}

type NavResult = {
  nav: Sourced<{ rows: { nav: NavPoint }[] }>
  adjusted: Sourced<NavPoint[]>
}

type ReconcileResult = {
  matched: boolean
  claimedShares: number
  derivedShares: number
  difference: number
  lastMatchedOn: string | null
}

const base = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

async function request<T>(
  path: string,
  options: { signal?: AbortSignal; body?: object } = {},
): Promise<T> {
  const { signal, body } = options
  let response: Response
  try {
    response = await fetch(`${base}/api${path}`, {
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error('无法连接 FundManager 后端。请确认服务已启动，且 API 地址与跨域配置正确。')
  }
  if (!response.ok) {
    const data: { error?: unknown } | null = await response.json().catch(() => null)
    throw new Error(typeof data?.error === 'string' ? data.error : `请求失败（${response.status}）`)
  }
  return response.json() as Promise<T>
}

const ledgerPath = (id: string) => `/ledgers/${encodeURIComponent(id)}`
const fundPath = (code: string) => `/funds/${encodeURIComponent(code)}`

export const api = {
  ledgers: (signal?: AbortSignal) => request<Sourced<Ledger[]>>('/ledgers', { signal }),
  addLedger: (name: string) => request<Sourced<Ledger>>('/ledgers', { body: { name } }),
  positions: (id: string, signal?: AbortSignal) =>
    request<Sourced<Position[]>>(`${ledgerPath(id)}/positions`, { signal }),
  funds: (query: string, category: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q: query })
    if (category) params.set('category', category)
    return request<Sourced<Fund[]>>(`/funds?${params}`, { signal })
  },
  categories: (signal?: AbortSignal) =>
    request<Sourced<{ category: string; count: number }[]>>('/funds/categories', { signal }),
  fundInfo: (code: string, signal?: AbortSignal) =>
    request<Sourced<FundInfo>>(fundPath(code), { signal }),
  nav: (code: string, signal?: AbortSignal) =>
    request<NavResult>(`${fundPath(code)}/nav`, { signal }),
  fundRisk: (code: string, signal?: AbortSignal) =>
    request<{ fundCode: string; maxDrawdown: Sourced<number> }>(`${fundPath(code)}/risk`, {
      signal,
    }),
  fundReturn: (id: string, code: string, signal?: AbortSignal) =>
    request<Sourced<{ xirr: Sourced<number> }>>(`${ledgerPath(id)}${fundPath(code)}/return`, {
      signal,
    }),
  addTransaction: (id: string, body: TransactionInput) =>
    request<Sourced<unknown>>(`${ledgerPath(id)}/transactions`, { body }),
  reconcile: (id: string, body: { fundCode: string; claimedShares: number; asOf?: string }) =>
    request<Sourced<ReconcileResult>>(`${ledgerPath(id)}/reconcile`, { body }),
}
