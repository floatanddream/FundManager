/**
 * 数据源层错误的基类。
 *
 * 存在的意义是让上层能一次捕获「这一层的全部失败」，而不必逐个认具体子类；
 * 同时让「传输失败」与「业务码失败」在类型上分开——**是否重试由内核按状态码判定**
 * （4xx 不重试、5xx 与网络错误退避重试），故重试与否不再由类型承载。
 */
export class DataSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DataSourceError'
  }
}

/**
 * 传输层失败：HTTP 非 2xx、网络错误、超时。
 *
 * @remarks 网络错误、超时、5xx **可重试**——换个时刻再发一次可能就好了，内核的退避重试针对的正是它们。
 * 4xx（及未跟随的 3xx）**不重试**：请求本身不对，重发永远不会成功（如缺 Referer 的反爬 404）。
 */
export class HttpError extends DataSourceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HttpError'
  }
}

/**
 * 业务码失败：body 里 `ErrCode` 非 0 / `Success:false`。
 *
 * @remarks 这一类**恒不重试**——HTTP 200 也照样是失败，重发只会放大同一个错误
 * （已知 `ErrCode:-999` 是缺 Referer、`61136403` 是 UA 被拒，退避多久都不会变好）。
 * 检查发生在解析器里，而解析器在内核之外，故结构上不可能被内核重试。
 */
export class BusinessCodeError extends DataSourceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BusinessCodeError'
  }
}

/**
 * 响应结构与预期不符（解析不出，而不是「解析出来是空的」）。
 *
 * @remarks 结构变了却返回空集合，用户会看到「这只基金没有持仓」而非「解析失败」——
 * 那正是最危险的静默错值。故结构不符一律抛此错误，绝不退化成空集合。
 */
export class ParseError extends DataSourceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ParseError'
  }
}
