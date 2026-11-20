import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import type { FundDataSource } from '@fundmanager/datasource'
import type { AppDatabase } from './db/client.ts'
import { toHttpError } from './errors.ts'
import { DEFAULT_CORS_ORIGIN } from './env.ts'
import { createLedgerRepository } from './repository/ledgerRepository.ts'
import { createReconcileRepository } from './repository/reconcileRepository.ts'
import { createTransactionRepository } from './repository/transactionRepository.ts'
import { registerLedgerRoutes } from './routes/ledgers.ts'
import { registerMarketFundRoutes } from './routes/marketFunds.ts'
import { registerPortfolioRoutes } from './routes/portfolio.ts'
import { registerPositionRoutes } from './routes/positions.ts'
import { registerReturnRoutes } from './routes/returns.ts'
import { registerTransactionRoutes } from './routes/transactions.ts'

export type AppDeps = {
  readonly db: AppDatabase
  /** 外部数据源。Task 2 的路由还用不到，后续 Service 从这里取 */
  readonly dataSource: FundDataSource
  /** 允许的前端来源；缺省为开发时的 Vite dev server */
  readonly corsOrigin?: string
  /** 是否打访问/错误日志；入口启动时开，测试里保持安静 */
  readonly logger?: boolean
}

/**
 * **唯一装配点**：`db → repositories → dataSource → services → routes`（设计 §五）。
 *
 * 依赖全部从参数进，不在内部读环境、开库、建 HTTP 内核——测试与入口各传各的。
 *
 * @returns 尚未 `listen` 的实例；测试用 `inject` 打，入口负责监听
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false })
  app.register(cors, { origin: deps.corsOrigin ?? DEFAULT_CORS_ORIGIN })

  app.setErrorHandler((error: unknown, request, reply) => {
    // Fastify v5 把这里声明为 unknown，而内置错误（坏 JSON、错误的 content-type）带 statusCode
    const { statusCode, message: rawMessage } = error as { statusCode?: unknown; message?: unknown }
    // Fastify 自身的客户端错误自带 4xx 状态码。不原样放行的话，前端把请求写错会被报成 500，排障方向就反了
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: String(rawMessage ?? '请求有误') })
    }
    const { status, message } = toHttpError(error)
    // 500 的内部细节不外泄给前端，但服务端得留下原始错误，否则出事只剩一句「内部错误」
    if (status === 500) request.log.error({ err: error })
    return reply.code(status).send({ error: message })
  })

  registerLedgerRoutes(app, { ledgerRepository: createLedgerRepository(deps.db) })
  registerMarketFundRoutes(app, { dataSource: deps.dataSource })
  const transactionRepository = createTransactionRepository(deps.db)
  const ledgerRepository = createLedgerRepository(deps.db)
  registerPositionRoutes(app, { transactionRepository, dataSource: deps.dataSource })
  registerReturnRoutes(app, { transactionRepository, dataSource: deps.dataSource })
  registerPortfolioRoutes(app, { transactionRepository, dataSource: deps.dataSource })
  registerTransactionRoutes(app, {
    transactionRepository,
    ledgerRepository,
    reconcileRepository: createReconcileRepository(deps.db),
  })
  return app
}
