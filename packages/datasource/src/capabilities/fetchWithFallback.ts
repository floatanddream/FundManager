/**
 * `fetchWithFallback` —— 实现降级、缓存、`stale`、`loss` 的**唯一**地方。
 *
 * 所有能力都走它，不在能力模块里各写一套。语义（设计 §6.3/§6.4/§九）：
 *
 * 1. **TTL 未过期** → 直接用缓存，`stale: false`（数据本来就该是这个时点，不算降级）
 * 2. **TTL 过期或未命中** → 依次跑 `sources`；成功则写缓存，`stale: false`
 * 3. **全链失败** → 取缓存（**不看是否过期**）：有旧值则返回并标 `stale: true`，无则抛
 *
 * 第 3 条是**唯一**允许用旧值的路径。解析失败（`ParseError`）、业务码失败（`BusinessCodeError`）、
 * 传输失败（`HttpError`）以及任何来源抛出的错误，都被视为该源失败并继续降级。
 */
import type { CacheEntry, CacheStore } from '../cache/cacheStore.ts'
import { BusinessCodeError, DataSourceError } from '../http/errors.ts'

import type { Fetched } from './types.ts'

/** 一次取值尝试：成功则给值；`dataAsOf` 省略表示「无天然时点」，由内核回退到抓取日。 */
export type FallbackRun<T> = () => Promise<{ readonly value: T; readonly dataAsOf?: string }>

/**
 * 降级链上的一环。
 *
 * `loss` 声明**相对主源**失去了什么口径（如「仅前十大」），降级到本环时记入 `Fetched.loss`。
 * 主源不设。数值等价的降级（净值丢分红字段）也照样写 `loss`——让上层决定显不显示。
 */
export type FallbackSource<T> = {
  readonly name: string
  readonly run: FallbackRun<T>
  readonly loss?: string
}

export type FetchWithFallbackSpec<T> = {
  /** 缓存键；同一查询必须稳定 */
  readonly key: string
  /** 命中缓存的存活时长（ms）；`0` 表示不缓存 */
  readonly ttlMs: number
  readonly sources: readonly FallbackSource<T>[]
  readonly cache?: CacheStore
  /** 不读也不写缓存（行情 / K 线：天然带时点，缓存只会给出陈旧值） */
  readonly noCache?: boolean
  /**
   * 口径损失**与值相关**时（如持仓是否为全量）用它——这样 TTL 命中缓存的旧值时
   * 仍能从值重算出 `loss`，不必把它塞进缓存记录。
   */
  readonly lossFor?: (value: T) => string | null
  /** 当 dataAsOf 是业务时点且只允许前进时启用（目前仅净值历史）。 */
  readonly monotonicDataAsOf?: boolean
  /** 注入当前时刻，仅为测试可确定；缺省用真实时钟 */
  readonly now?: () => Date
}

// 同一进程内按 cache store + key 串行比较/写入，防止较晚返回的旧响应覆盖新值。
const cacheWriteTails = new WeakMap<CacheStore, Map<string, Promise<void>>>()
async function setMonotonic<T>(
  cache: CacheStore,
  key: string,
  entry: CacheEntry<T>,
): Promise<boolean> {
  let tails = cacheWriteTails.get(cache)
  if (tails === undefined) {
    tails = new Map()
    cacheWriteTails.set(cache, tails)
  }
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  tails.set(key, tail)
  await previous
  try {
    const existing = await cache.get<T>(key)
    if (existing !== undefined && existing.dataAsOf > entry.dataAsOf) return false
    await cache.set(key, entry)
    return true
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000

/** 抓取时刻，带 `+08:00` 时区（中国自 1991 年起无夏令时，偏移恒定）。 */
function capturedAtOf(now: Date): string {
  const iso = new Date(now.getTime() + CHINA_OFFSET_MS).toISOString()
  return `${iso.slice(0, 19)}+08:00`
}

/**
 * 按降级链取数，返回带出处、时点、新鲜度、口径损失的信封。
 *
 * @throws {DataSourceError} 全部来源失败**且**无缓存旧值。若全链均为业务码失败，
 *   错误信息会带上可操作提示（可能缺 Referer 或 UA 被拒）
 */
export async function fetchWithFallback<T>(spec: FetchWithFallbackSpec<T>): Promise<Fetched<T>> {
  const now = spec.now ? spec.now() : new Date()
  const capturedAt = capturedAtOf(now)
  const useCache = spec.cache !== undefined && spec.noCache !== true && spec.ttlMs > 0

  /** 从值重算口径损失：优先用该来源声明的 loss，否则用与值相关的 lossFor。 */
  const lossOf = (sourceName: string, value: T): string | null => {
    const source = spec.sources.find((s) => s.name === sourceName)
    return source?.loss ?? spec.lossFor?.(value) ?? null
  }

  // 1. TTL 未过期：直接用缓存，不算降级
  if (useCache) {
    const hit = await spec.cache!.get<T>(spec.key)
    const effectiveExpiry = spec.monotonicDataAsOf
      ? Math.min(hit?.expiresAt ?? 0, Date.parse(hit?.capturedAt ?? '') + spec.ttlMs)
      : (hit?.expiresAt ?? 0)
    if (hit !== undefined && effectiveExpiry > now.getTime()) {
      return {
        value: hit.value,
        source: hit.source,
        dataAsOf: hit.dataAsOf,
        capturedAt: hit.capturedAt,
        stale: false,
        loss: lossOf(hit.source, hit.value),
      }
    }
  }

  // 2. 依次降级；成功即写缓存返回
  const failures: { source: string; error: unknown }[] = []
  let cached: CacheEntry<T> | undefined
  if (useCache && spec.monotonicDataAsOf) cached = await spec.cache!.get<T>(spec.key)
  for (const source of spec.sources) {
    try {
      const { value, dataAsOf } = await source.run()
      const asOf = dataAsOf ?? capturedAt.slice(0, 10)
      if (spec.monotonicDataAsOf && cached !== undefined && asOf < cached.dataAsOf) {
        failures.push({
          source: source.name,
          error: new DataSourceError(`数据日期 ${asOf} 早于缓存 ${cached.dataAsOf}`),
        })
        continue
      }
      if (useCache) {
        const entry = {
          value,
          source: source.name,
          dataAsOf: asOf,
          capturedAt,
          expiresAt: now.getTime() + spec.ttlMs,
        }
        if (spec.monotonicDataAsOf) {
          const written = spec.cache!.setIfNotOlder
            ? await spec.cache!.setIfNotOlder(spec.key, entry)
            : await setMonotonic(spec.cache!, spec.key, entry)
          if (!written) {
            const newest = await spec.cache!.get<T>(spec.key)
            failures.push({
              source: source.name,
              error: new DataSourceError(
                `数据日期 ${asOf} 不晚于并发缓存 ${newest?.dataAsOf ?? '未知'}`,
              ),
            })
            continue
          }
        } else await spec.cache!.set(spec.key, entry)
      }
      return {
        value,
        source: source.name,
        dataAsOf: asOf,
        capturedAt,
        stale: false,
        loss: source.loss ?? spec.lossFor?.(value) ?? null,
      }
    } catch (error) {
      failures.push({ source: source.name, error })
    }
  }

  // 3. 全链失败：取缓存旧值（不看是否过期，这是唯一允许用旧值的路径）并标 stale
  if (useCache) {
    const stale = await spec.cache!.get<T>(spec.key)
    if (stale !== undefined) {
      return {
        value: stale.value,
        source: stale.source,
        dataAsOf: stale.dataAsOf,
        capturedAt: stale.capturedAt,
        stale: true,
        loss: lossOf(stale.source, stale.value),
      }
    }
  }

  throw buildFailure(spec.key, failures)
}

/** 组装失败错误。全链均为业务码失败时补上可操作提示——作者调试过的坑，使用者没有那段经验。 */
function buildFailure(
  key: string,
  failures: readonly { source: string; error: unknown }[],
): DataSourceError {
  const detail = failures
    .map(
      ({ source, error }) => `${source}：${error instanceof Error ? error.message : String(error)}`,
    )
    .join('；')
  const allBusinessCode =
    failures.length > 0 && failures.every((f) => f.error instanceof BusinessCodeError)
  const hint = allBusinessCode
    ? '。全部来源都是业务码失败（HTTP 200 也可能是错误页），可能是缺少 Referer 或 UA 被拒'
    : ''
  return new DataSourceError(`${key} 的全部数据源都失败了 —— ${detail}${hint}`, {
    cause: failures.at(-1)?.error,
  })
}
