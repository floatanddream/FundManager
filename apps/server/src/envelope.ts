import type { Fetched } from '@fundmanager/datasource'

/**
 * 返回信封：每个可能来自外部数据的数字都带出处与时点（设计 §七）。
 *
 * `value: null` 表示**算不出来**（原因见 `reason`），不是 0；`stale` 与 `loss` 必须分开——
 * 前者是数据旧，后者是口径弱。
 */
/**
 * 信封去掉 `value` 后的那部分——`provenance` 只用这个。
 *
 * 为什么不能直接放 `Sourced<unknown>`：派生值的 `provenance` 会装下**整段净值序列**
 * （6000+ 行）。一个持仓列表把每只基金的完整历史都带一遍，响应能到几 MB，
 * 而前端要的只是「这个数取自哪里、多旧、丢了什么口径」——`value` 一点用都没有。
 */
export type SourcedMeta = Omit<Sourced<unknown>, 'value' | 'provenance'>

export type Sourced<T> = {
  readonly value: T | null
  /** `value` 为 null 时的可读原因（如「成本未知」）；有值时为 null */
  readonly reason: string | null
  /** 数据来自哪个端点（如 `'f10/lsjz'`）；派生值为各输入的来源 */
  readonly source: string
  /** 数据本身的时点：净值日 / 报告期，`YYYY-MM-DD`；派生值取**最早**的输入 */
  readonly dataAsOf: string
  /** 抓取时刻，带时区（+08:00） */
  readonly capturedAt: string
  /** 来自缓存降级——数据旧；派生值**任一**输入 stale 即 stale */
  readonly stale: boolean
  /** 来自更弱的源，失去了什么口径（如「仅前十大」）；派生值为各输入 loss 拼接 */
  readonly loss: string | null
  /** 派生值的各输入标注（**不含 value**，见 `SourcedMeta`）；直接来自外部数据时为空 */
  readonly provenance: readonly SourcedMeta[]
}

/**
 * 把数据源的 `Fetched<T>` 原样搬进信封。
 *
 * `provenance` 为空：它就是外部数据本身，出处已经在 `source` / `dataAsOf` 里。
 */
export function fromFetched<T>(f: Fetched<T>): Sourced<T> {
  return {
    value: f.value,
    reason: null,
    source: f.source,
    dataAsOf: f.dataAsOf,
    capturedAt: f.capturedAt,
    stale: f.stale,
    loss: f.loss,
    provenance: [],
  }
}

/**
 * 由若干输入派生的值（持仓、盈亏、风险指标）的信封。
 *
 * 时点取**最早**的输入：派生值只和它最旧的那部分数据一样可靠，取最新会让人以为
 * 整体都是新的。各输入的 loss 拼接后带出，不让「口径弱」在汇总时消失。
 *
 * @param inputs 参与的输入信封，至少一项
 * @throws {TypeError} `inputs` 为空——没有输入的派生值无从标注时点
 */
export function fromDerived<T>(
  value: T | null,
  reason: string | null,
  inputs: readonly Sourced<unknown>[],
): Sourced<T> {
  if (inputs.length === 0) throw new TypeError('派生值至少需要一个输入')

  // 日期是定长 YYYY-MM-DD，字典序即时间序；capturedAt 取最晚（此时各输入都已在手）
  const dataAsOf = inputs.reduce((a, i) => (i.dataAsOf < a ? i.dataAsOf : a), inputs[0]!.dataAsOf)
  const capturedAt = inputs.reduce(
    (a, i) => (i.capturedAt > a ? i.capturedAt : a),
    inputs[0]!.capturedAt,
  )
  const losses = inputs.flatMap((i) => (i.loss === null ? [] : [i.loss]))

  return {
    value,
    reason,
    source: [...new Set(inputs.map((i) => i.source))].join('；'),
    dataAsOf,
    capturedAt,
    stale: inputs.some((i) => i.stale),
    loss: losses.length === 0 ? null : losses.join('；'),
    provenance: inputs.map(toMeta),
  }
}

/** 剥掉 `value` 与嵌套的 `provenance`，只留出处与可信度——见 `SourcedMeta` 的说明 */
function toMeta(s: Sourced<unknown>): SourcedMeta {
  const { value: _value, provenance: _provenance, ...meta } = s
  return meta
}
