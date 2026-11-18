import { decodeBody } from './encoding.ts'
import { HttpError } from './errors.ts'

/** 一次请求的规格。请求头由各端点模块按自己的需求声明，内核不预设。 */
export type HttpRequestSpec = {
  readonly url: string
  readonly headers?: Record<string, string>
  /** 响应体的字符集，缺省 utf-8；如腾讯行情族要传 'gbk' */
  readonly charset?: string
}

/** 内核的产出：HTTP 状态码 + 已按 charset 解码、已去 BOM 的文本。业务码校验不在此处。 */
export type HttpResponse = {
  readonly status: number
  readonly text: string
}

export type HttpClientOptions = {
  /** 真实 fetch，或测试里的假函数。作为普通参数注入，内核不关心它从哪来。 */
  readonly fetch: typeof globalThis.fetch
  /** 两次请求的最小间隔（ms），默认 300——实测 ≥200ms 足够，取 300 留余量 */
  readonly minIntervalMs?: number
  /** 单次请求超时（ms），默认 15000 */
  readonly timeoutMs?: number
  /** 传输失败的重试次数，默认 2（即最多发 3 次） */
  readonly maxRetries?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 数据源层的共享 HTTP 内核：注入请求头、限流、超时、退避、按 charset 解码。
 *
 * 有状态（上次请求时刻），故用 class。它**只负责「原始字节到文本」**：
 * 保证「HTTP 2xx 且拿到了可解码的 body」即返回；`JSON.parse` 与业务码校验
 * （`ErrCode`/`Success`）归各端点解析器——业务码落在响应哪个字段只有解析器知道。
 *
 * 只对**可重试的传输失败**（网络错误、超时、5xx）退避重试——4xx 不重试（请求本身不对，
 * 重发不会成功，见 `#fetchWithRetry`）。业务码错误由解析器抛，
 * 而解析器在内核之外，故它天然不会被重试——这正是设计要的。
 */
export class HttpClient {
  readonly #fetch: typeof globalThis.fetch
  readonly #minIntervalMs: number
  readonly #timeoutMs: number
  readonly #maxRetries: number
  #lastRequestAt = 0

  constructor(options: HttpClientOptions) {
    this.#fetch = options.fetch
    this.#minIntervalMs = options.minIntervalMs ?? 300
    this.#timeoutMs = options.timeoutMs ?? 15000
    this.#maxRetries = options.maxRetries ?? 2
  }

  /**
   * 发一次请求，返回已解码的文本。
   *
   * @throws {HttpError} 未拿到 2xx。网络错误、超时、5xx 会退避重试至耗尽；**4xx 不重试**，立即抛
   * @throws {RangeError} charset 不被本机 Node 支持
   */
  async request(spec: HttpRequestSpec): Promise<HttpResponse> {
    const res = await this.#fetchWithRetry(spec)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, text: decodeBody(bytes, spec.charset) }
  }

  /** 传输失败退避重试；一旦拿到 2xx 响应即返回，body 的解码交给调用方。 */
  async #fetchWithRetry(spec: HttpRequestSpec): Promise<Response> {
    let lastError: HttpError | undefined
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      await this.#throttle()
      // 4xx 是「请求本身不对」（如 FundArchivesDatas 缺 Referer 被反爬返回 404），
      // 重发永远不会成功——标记为不可重试，失败即返回，不浪费退避等待
      let nonRetryable = false
      try {
        const res = await this.#fetch(spec.url, {
          headers: spec.headers,
          signal: AbortSignal.timeout(this.#timeoutMs),
        })
        if (!res.ok) {
          nonRetryable = res.status < 500
          throw new HttpError(`HTTP ${res.status}：${spec.url}`)
        }
        return res
      } catch (err) {
        lastError =
          err instanceof HttpError
            ? err
            : new HttpError(`请求失败（网络错误或超时）：${spec.url}`, { cause: err })
        if (nonRetryable) break
        if (attempt < this.#maxRetries) {
          // 第 n 次重试等待 minIntervalMs * 2^n：attempt 即刚失败的这次下标，也是重试序号
          await sleep(this.#minIntervalMs * 2 ** attempt)
        }
      }
    }
    throw lastError ?? new HttpError(`请求失败：${spec.url}`)
  }

  /** 距上次请求不足 minIntervalMs 就先等，避免打太快触发反爬。 */
  async #throttle(): Promise<void> {
    const wait = this.#lastRequestAt + this.#minIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    this.#lastRequestAt = Date.now()
  }
}
