/**
 * 入口：读环境变量、开库、装配数据源、监听。
 *
 * 启动：`pnpm --filter @fundmanager/server start`（即 `node src/server.ts`，Node 24 直接跑 TS）。
 */
import { HttpClient, createFundDataSource } from '@fundmanager/datasource'
import { buildApp } from './app.ts'
import { openDatabase } from './db/client.ts'
import { loadEnv } from './env.ts'
import { createSqliteCacheStore } from './repository/sqliteCacheStore.ts'

const env = loadEnv()
const { db } = openDatabase(env.dbPath)

const dataSource = createFundDataSource({
  http: new HttpClient({ fetch: globalThis.fetch }),
  // 缓存落本地库：进程重启后旧值仍是降级时唯一的来源
  cache: createSqliteCacheStore(db),
})

const app = buildApp({ db, dataSource, corsOrigin: env.corsOrigin, logger: true })
await app.listen({ port: env.port })
console.log(`API 已启动：http://localhost:${env.port}`)
