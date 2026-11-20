import type { FastifyInstance } from 'fastify'
import { fromFetched, type Sourced } from '../envelope.ts'
import type { createLedgerRepository } from '../repository/ledgerRepository.ts'

/** 账本对外的形状；库里的 `currency` / `createdAt` 不在这条契约里，不随响应漏出去 */
export type LedgerSummary = { readonly id: string; readonly name: string }

type LedgerRepository = ReturnType<typeof createLedgerRepository>

/** 当前时刻，带中国时区的 ISO 8601——与数据源层 `capturedAt` 同一格式 */
const capturedAtNow = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')

/**
 * 本地账本数据的信封。
 *
 * 账本内容不来自外部：它的可信度由账本本身保证、由对账守（设计 §七），
 * 所以 `stale` 恒 false、无口径损失。字段仍填满，前端不必为两种形状写两套解析。
 */
const envelope = <T>(value: T): Sourced<T> => {
  const capturedAt = capturedAtNow()
  return fromFetched({
    value,
    source: 'repository/ledger',
    dataAsOf: capturedAt.slice(0, 10),
    capturedAt,
    stale: false,
    loss: null,
  })
}

/**
 * 账本列表与新建。
 *
 * 两条路由都只是搬运，没有可编排的东西，所以不经 Service 直接调 Repository
 * （§9.5：不造没有内容的层）。等出现「建账本还要初始化别的表」这类逻辑再抽。
 */
export function registerLedgerRoutes(
  app: FastifyInstance,
  deps: { readonly ledgerRepository: LedgerRepository },
): void {
  app.get('/api/ledgers', async () => {
    const ledgers = await deps.ledgerRepository.list()
    return envelope(ledgers.map(({ id, name }): LedgerSummary => ({ id, name })))
  })

  app.post('/api/ledgers', async (request, reply) => {
    const name = (request.body as { name?: unknown } | null)?.name
    // 空名称会让账本列表出现一条点不到的条目；在此拦下，走统一错误翻译成 400
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('账本名称不能为空')
    }
    const id = await deps.ledgerRepository.create(name.trim())
    return reply.code(201).send(envelope({ id, name: name.trim() } satisfies LedgerSummary))
  })
}
