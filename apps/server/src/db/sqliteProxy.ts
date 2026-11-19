import type { DatabaseSync } from 'node:sqlite'

/**
 * `drizzle-orm/sqlite-proxy` 的适配器：把 Drizzle 生成好的 SQL 交给 `node:sqlite` 执行。
 *
 * @remarks Drizzle 不认识 `node:sqlite`（`CONSTRAINTS/01`），官方给的接入方式就是
 * sqlite-proxy：Drizzle 负责拼 SQL 与解码结果，这里只负责执行。回调签名见
 * `drizzle-orm/sqlite-proxy` 的 `AsyncRemoteCallback`。
 *
 * @remarks **必须 `setReturnArrays(true)`**：Drizzle 按列**位置**解码（`mapResultRow`
 * 用 `row[columnIndex]`），而 `node:sqlite` 默认返回对象。返回对象会让 Drizzle 把每行
 * 的字段都解成 `undefined`——不报错，只是数据全空，正是最难查的那种。
 */
export const createSqliteProxy =
  (sqlite: DatabaseSync) =>
  async (
    query: string,
    params: unknown[],
    method: 'run' | 'all' | 'values' | 'get',
  ): Promise<{ rows: unknown[] }> => {
    const stmt = sqlite.prepare(query)
    // node:sqlite 的绑定值类型是 SQLInputValue；Drizzle 传下来的参数类型是 unknown
    const args = params as Parameters<typeof stmt.run>

    if (method === 'run') {
      stmt.run(...args)
      // Drizzle 的 sqlite-proxy 对 `run` 返回值不感兴趣，只取 rows 的存在性
      return { rows: [] }
    }

    stmt.setReturnArrays(true)
    if (method === 'get') {
      // 没查到行时 Drizzle 的 mapGetResult 见到 undefined / 空数组都返回 undefined；
      // `@types/node` 不知道 setReturnArrays 已生效，仍按对象行标注，故断言成 unknown[]
      const row = stmt.get(...args) as unknown[] | undefined
      return { rows: row === undefined ? [] : row }
    }
    return { rows: stmt.all(...args) as unknown[] }
  }
