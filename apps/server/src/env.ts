/**
 * 运行配置（设计 §十）。**全部可配**：使用者各自部署，不能把作者的端口与路径写死。
 *
 * 读环境变量集中在 `loadEnv`，其余代码不碰 `process.env`——测试能直接传一份假环境，
 * 不用改全局状态。
 */

/** API 端口，避开 Vite 的 5173 */
export const DEFAULT_PORT = 5178

/** 开发时前端 Vite dev server 的来源；生产由前端静态服务同源代理，不开宽 CORS */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:5173'

/** 相对路径按启动时的工作目录解析 */
export const DEFAULT_DB_PATH = './data/fundmanager.db'

export type Env = {
  readonly port: number
  readonly corsOrigin: string
  readonly dbPath: string
}

/**
 * 从环境变量读出配置，缺失项用默认值。
 *
 * @param source 环境变量来源，缺省 `process.env`（测试可传假对象）
 * @throws {RangeError} `PORT` 不是 1–65535 的整数——启动即失败，好过监听在一个随机端口上
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const rawPort = source.PORT
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`PORT 必须是 1–65535 的整数，当前为「${rawPort}」`)
  }
  return {
    port,
    corsOrigin: source.CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN,
    dbPath: source.DB_PATH ?? DEFAULT_DB_PATH,
  }
}
