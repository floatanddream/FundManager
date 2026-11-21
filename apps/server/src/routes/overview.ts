import type { FastifyInstance } from 'fastify'
import { getLedgerOverview, type OverviewDeps } from '../services/ledgerOverviewService.ts'

/** 装配账本总览路由，空账本保留零市值，未知账本明确返回 404。 */
export function registerOverviewRoutes(app: FastifyInstance, deps: OverviewDeps) {
  app.get<{ Params: { ledgerId: string } }>(
    '/api/ledgers/:ledgerId/overview',
    async (request, reply) => {
      const result = await getLedgerOverview(deps, request.params.ledgerId)
      return result ?? reply.code(404).send({ error: '账本不存在' })
    },
  )
}
