/**
 * 组合风险路由（账本内，设计 §六）：组合是因为你持有才存在的数，路径带 `ledgerId`。
 *
 * 只做参数校验与调 Service，不写算式（§二 规则 1）。单基金风险在市场路由组
 * （`marketFunds.ts`），因为它描述的是基金本身，与是否持有无关。
 */
import type { FastifyInstance } from 'fastify'
import { getPortfolioRisk, type PortfolioRiskDeps } from '../services/riskService.ts'

export function registerPortfolioRoutes(app: FastifyInstance, deps: PortfolioRiskDeps): void {
  app.get<{ Params: { ledgerId: string } }>(
    '/api/ledgers/:ledgerId/portfolio/risk',
    async (request) => getPortfolioRisk(deps, request.params.ledgerId),
  )
}
