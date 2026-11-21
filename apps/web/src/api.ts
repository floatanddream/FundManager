/** 保留后端的时点与降级语义，展示层用它区分未知、缓存旧值和覆盖不足。 */
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

/** 账本总览的金额和覆盖只数由后端统一计算，日期对应同一估值窗口。 */
export type OverviewPosition = Position & {
  dailyGain: Sourced<number>
  holdingGainRate: Sourced<number>
}

export type Coverage = { included: number; total: number }

export type LedgerOverview = {
  valuationDate: string | null
  previousDate: string | null
  marketValue: Sourced<number>
  dailyGain: Sourced<number>
  marketValueCoverage: Coverage
  dailyGainCoverage: Coverage
  positions: OverviewPosition[]
}

/** 主题、宽基、披露行业和基金产品分类各自保留核验依据。 */
export type DirectionTag = {
  label: string
  kind: 'index_theme' | 'broad_index' | 'reported_industry' | 'fund_category'
  reportDate: string | null
  reference: string
}

export type Fund = { code: string; name: string; category: string }
export type NavPoint = { date: string; value: number }

/** 流水请求按账本视角记符号，申购金额和赎回份额为负。 */
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

export type PendingSubscription = {
  id: string
  fundCode: string
  orderDate: string
  amount: number
}
export type SubscriptionQuote = {
  shares: number | null
  nav: number | null
  navDate: string
  reason: string | null
}
export type ConfirmedSubscription = {
  id: string
  fundCode: string
  date: string
  sharesDelta: number
  status: 'confirmed'
}

type FundInfo = {
  fields: Record<string, string>
  benchmark: string | null
  trackingTarget: string | null
}

/** 两种净值口径各自带来源，切换时不能混用日期和降级说明。 */
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

// 显式空值表示由同源代理转发，未配置时才连接本地后端。
const base = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

/**
 * 统一 API 请求，让页面和抽屉共用后端给出的可操作错误。
 *
 * @throws {Error} 请求取消、后端不可达、响应失败或响应正文无法解析。
 */
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
    // 保留取消请求的语义，否则切换基金时会把主动取消误报成服务故障。
    if (signal?.aborted) throw error
    throw new Error('无法连接 FundManager 后端。请确认服务已启动，且 API 地址与跨域配置正确。')
  }
  if (!response.ok) {
    const data: { error?: unknown } | null = await response.json().catch(() => null)
    throw new Error(typeof data?.error === 'string' ? data.error : `请求失败（${response.status}）`)
  }
  return response.json() as Promise<T>
}

/** 账本标识由服务端生成，始终作为单个路径段传入。 */
const ledgerPath = (id: string) => `/ledgers/${encodeURIComponent(id)}`
/** 基金代码必须保留前导零，因此路径和表单中都使用字符串。 */
const fundPath = (code: string) => `/funds/${encodeURIComponent(code)}`

/**
 * 前端 API 入口，保留各响应的净值口径与可信度字段。
 *
 * @throws {Error} 任一请求被取消、返回失败响应或无法读取。
 */
export const api = {
  ledgers: (signal?: AbortSignal) => request<Sourced<Ledger[]>>('/ledgers', { signal }),
  addLedger: (name: string) => request<Sourced<Ledger>>('/ledgers', { body: { name } }),
  overview: (id: string, signal?: AbortSignal) =>
    request<Sourced<LedgerOverview>>(`${ledgerPath(id)}/overview`, { signal }),
  funds: (query: string, category: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q: query })
    if (category) params.set('category', category)
    return request<Sourced<Fund[]>>(`/funds?${params}`, { signal })
  },
  categories: (signal?: AbortSignal) =>
    request<Sourced<{ category: string; count: number }[]>>('/funds/categories', { signal }),
  fundInfo: (code: string, signal?: AbortSignal) =>
    request<Sourced<FundInfo>>(fundPath(code), { signal }),
  directions: (code: string, signal?: AbortSignal) =>
    request<Sourced<DirectionTag[]>>(`${fundPath(code)}/directions`, { signal }),
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
  subscriptions: (id: string, signal?: AbortSignal) =>
    request<PendingSubscription[]>(`${ledgerPath(id)}/subscriptions`, { signal }),
  addSubscription: (id: string, body: { fundCode: string; orderDate: string; amount: number }) =>
    request<PendingSubscription>(`${ledgerPath(id)}/subscriptions`, { body }),
  quoteSubscription: (id: string, subscriptionId: string, body: { navDate: string; fee: number }) =>
    request<SubscriptionQuote>(
      `${ledgerPath(id)}/subscriptions/${encodeURIComponent(subscriptionId)}/quote`,
      { body },
    ),
  confirmSubscription: (
    id: string,
    subscriptionId: string,
    body: { navDate: string; fee?: number; shares?: number; sequence?: number },
  ) =>
    request<ConfirmedSubscription>(
      `${ledgerPath(id)}/subscriptions/${encodeURIComponent(subscriptionId)}/confirm`,
      { body },
    ),
  reconcile: (id: string, body: { fundCode: string; claimedShares: number; asOf?: string }) =>
    request<Sourced<ReconcileResult>>(`${ledgerPath(id)}/reconcile`, { body }),
}
