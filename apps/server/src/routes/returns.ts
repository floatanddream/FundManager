/**
 * 收益路由（账本内，设计 §六）：XIRR 没有你的流水就算不出来，路径带 `ledgerId`。
 *
 * 只做参数校验与调 Service，不写算式（§二 规则 1）。
 */
import type { FastifyInstance } from 'fastify'
import { getFundReturn, type ReturnDeps } from '../services/returnService.ts'

/** 公募基金代码均为 6 位数字；格式不对在入口拦下，不让上游用「查无此基金」当成功 */
const FUND_CODE = /^\d{6}$/

/**
 * 校验基金代码。
 *
 * @throws {TypeError} 不是 6 位数字——走统一错误翻译成 400
 */
const assertFundCode = (fundCode: string): string => {
  if (!FUND_CODE.test(fundCode)) {
    throw new TypeError(`基金代码必须是 6 位数字，收到「${fundCode}」`)
  }
  return fundCode
}

export function registerReturnRoutes(app: FastifyInstance, deps: ReturnDeps): void {
  app.get<{ Params: { ledgerId: string; fundCode: string } }>(
    '/api/ledgers/:ledgerId/funds/:fundCode/return',
    async (request, reply) => {
      const result = await getFundReturn(
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
