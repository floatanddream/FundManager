import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.ts'
import { createSqliteProxy } from './sqliteProxy.ts'

/**
 * 建表语句。**与 `schema.ts` 必须一致**——见下方注释里的取舍。
 *
 * @remarks `transaction` 是 SQL 关键字，表名必须加引号，否则建表直接语法错。
 */
const ddl = [
  `CREATE TABLE IF NOT EXISTS "ledger" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "createdAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "transaction" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "fundCode" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sharesDelta" REAL,
    "splitRatio" REAL,
    "amount" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "sequence" INTEGER,
    "source" TEXT,
    "note" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "cache" (
    "key" TEXT PRIMARY KEY NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dataAsOf" TEXT NOT NULL,
    "capturedAt" TEXT NOT NULL,
    "expiresAt" INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "reconcile" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "fundCode" TEXT NOT NULL,
    "asOf" TEXT NOT NULL,
    "claimedShares" REAL NOT NULL,
    "derivedShares" REAL NOT NULL,
    "matched" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TEXT NOT NULL
  )`,
]

/** Drizzle 实例，表定义来自 `schema.ts`（`db.query.ledger` 等可用） */
export type AppDatabase = ReturnType<typeof createDatabase>

const createDatabase = (sqlite: DatabaseSync) => drizzle(createSqliteProxy(sqlite), { schema })

/**
 * 打开本地库并保证各表存在。
 *
 * @param location SQLite 文件路径；省略时为 `:memory:`（测试用）
 *
 * @remarks **不引入 drizzle-kit、不写迁移文件。** 这是个人单机本地库，没有多实例、
 * 没有线上数据需要演进；`CREATE TABLE IF NOT EXISTS` 就够（§9.5 最简优先）。
 * 代价是**改字段时要手工补 DDL 与 `schema.ts` 两处**——表结构与建表语句因此
 * 刻意写在同一份代码里，改一处时另一处就在旁边。
 */
export const openDatabase = (location = ':memory:'): { db: AppDatabase; sqlite: DatabaseSync } => {
  if (location !== ':memory:') {
    // 第一次跑时 data/ 之类目录还不存在：直接开库会报「unable to open database file」，
    // 那提示没说缺的是目录。建一下，让首次运行就能通。
    mkdirSync(dirname(location), { recursive: true })
  }
  const sqlite = new DatabaseSync(location)
  for (const statement of ddl) sqlite.exec(statement)
  return { db: createDatabase(sqlite), sqlite }
}
