/**
 * 持仓路由（账本内，设计 §六）：持仓是因为你持有才存在的数，路径带 `ledgerId`。
 *
 * 只做参数校验与调 Service，不写算式（§二 规则 1）。
 */
import type { FastifyInstance } from 'fastify'
import { getFundPosition, listPositions, type PositionDeps } from '../services/positionService.ts'

/** 公募基金代码均为 6 位数字；格式不对在入口拦下，不让上游用「查无此基金」当成功 */
const FUND_CODE = /^\d{6}$/

/**
 * @throws {TypeError} 不是 6 位数字——走统一错误翻译成 400
 */
const assertFundCode = (fundCode: string): string => {
  if (!FUND_CODE.test(fundCode)) {
    throw new TypeError(`基金代码必须是 6 位数字，收到「${fundCode}」`)
  }
  return fundCode
}

export function registerPositionRoutes(app: FastifyInstance, deps: PositionDeps): void {
  app.get<{ Params: { ledgerId: string } }>('/api/ledgers/:ledgerId/positions', async (request) =>
    listPositions(deps, request.params.ledgerId),
  )

  app.get<{ Params: { ledgerId: string; fundCode: string } }>(
    '/api/ledgers/:ledgerId/positions/:fundCode',
    async (request, reply) => {
      const result = await getFundPosition(
        deps,
        request.params.ledgerId,
        assertFundCode(request.params.fundCode),
      )
      // 一笔流水都没有：查错了对象，而不是「0 份额持仓」
      if (result === null) return reply.code(404).send({ error: '该账本没有这只基金的流水' })
      return result
    },
  )
}
