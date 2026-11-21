import type { FastifyInstance } from 'fastify'
import { assertDate } from '@fundmanager/shared'
import {
  confirmSubscription,
  createSubscription,
  listSubscriptions,
  quoteSubscription,
  type SubscriptionDeps,
} from '../services/subscriptionService.ts'

function bodyFields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('请求体必须是一个 JSON 对象')
  return value as Record<string, unknown>
}

function numberField(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    throw new TypeError(`${field}必须为${minimum === 0 ? '非负数' : '正数'}`)
  return value
}

function dateField(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`请填写${field}`)
  return assertDate(value, field)
}

type LedgerParams = { ledgerId: string }
type DraftParams = LedgerParams & { id: string }
const path = '/api/ledgers/:ledgerId/subscriptions'
const draftError = { error: '待确认申购不存在' }

/** 金额申购入口只解析入参。报价、试算和持久化由 Service 编排。 */
export function registerSubscriptionRoutes(app: FastifyInstance, deps: SubscriptionDeps): void {
  app.get<{ Params: LedgerParams }>(path, async (request, reply) => {
    const result = await listSubscriptions(deps, request.params.ledgerId)
    return result ?? reply.code(404).send({ error: '账本不存在' })
  })

  app.post<{ Params: LedgerParams }>(path, async (request, reply) => {
    const body = bodyFields(request.body)
    const fundCode = body.fundCode
    if (typeof fundCode !== 'string' || !/^\d{6}$/.test(fundCode))
      throw new TypeError('基金代码必须是 6 位数字')
    const draft = await createSubscription(deps, request.params.ledgerId, {
      fundCode,
      orderDate: dateField(body.orderDate, '交易日期'),
      amount: numberField(body.amount, '申购金额', Number.MIN_VALUE),
    })
    return draft ? reply.code(201).send(draft) : reply.code(404).send({ error: '账本不存在' })
  })

  app.post<{ Params: DraftParams }>(`${path}/:id/quote`, async (request, reply) => {
    const { ledgerId, id } = request.params
    const body = bodyFields(request.body)
    const result = await quoteSubscription(deps, ledgerId, id, {
      navDate: dateField(body.navDate, '净值日期'),
      fee: numberField(body.fee, '实际申购费', 0),
    })
    return result ?? reply.code(404).send(draftError)
  })

  app.post<{ Params: DraftParams }>(`${path}/:id/confirm`, async (request, reply) => {
    const { ledgerId, id } = request.params
    const body = bodyFields(request.body)
    let sequence = null
    if (body.sequence !== undefined && body.sequence !== null) {
      sequence = numberField(body.sequence, '同日顺序号', 0)
      if (!Number.isSafeInteger(sequence)) throw new TypeError('同日顺序号必须是非负整数')
    }
    const result = await confirmSubscription(deps, ledgerId, id, {
      navDate: dateField(body.navDate, '净值日期'),
      fee: body.fee === undefined ? undefined : numberField(body.fee, '实际申购费', 0),
      shares:
        body.shares === undefined
          ? undefined
          : numberField(body.shares, '回单份额', Number.MIN_VALUE),
      sequence,
    })
    return result ?? reply.code(404).send(draftError)
  })
}
