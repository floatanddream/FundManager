import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 设计 §七 的三张账本表，外加数据源层的 `cache` 表。
 *
 * @remarks 表名用**单数**、列名用 camelCase。`transaction` 是 SQL 关键字，
 * 建表与查询都必须加引号——Drizzle 生成 SQL 时会自动加，手写 DDL 时不能忘。
 *
 * @remarks 这张 schema 只负责类型与查询构造；**真正建表的是 `client.ts` 里手写的
 * `CREATE TABLE IF NOT EXISTS`**。两边字段必须一致，改一边就得改另一边。
 */

export const ledger = sqliteTable('ledger', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('CNY'),
  /** ISO 8601 时间戳。业务日期用 `date` 列，别混用 */
  createdAt: text('createdAt').notNull(),
})

export const transaction = sqliteTable('transaction', {
  id: text('id').primaryKey(),
  ledgerId: text('ledgerId').notNull(),
  fundCode: text('fundCode').notNull(),
  /** 业务日期，只许 `YYYY-MM-DD`（§8.2） */
  date: text('date').notNull(),
  kind: text('kind', {
    enum: ['subscribe', 'redeem', 'dividend_cash', 'dividend_reinvest', 'split'],
  }).notNull(),
  /** 份额增减量；`split` 时为 null */
  sharesDelta: real('sharesDelta'),
  /** 份额折算**比例**；非 `split` 时为 null。与 `sharesDelta` 互斥（设计 §七） */
  splitRatio: real('splitRatio'),
  /** 流向账本为正，流出为负 */
  amount: real('amount').notNull(),
  status: text('status', { enum: ['confirmed', 'pending'] }).notNull(),
  /** 流水来源，供排障：手工录入还是某个数据源 */
  source: text('source'),
  note: text('note'),
  createdAt: text('createdAt').notNull(),
})

export const reconcile = sqliteTable('reconcile', {
  id: text('id').primaryKey(),
  ledgerId: text('ledgerId').notNull(),
  fundCode: text('fundCode').notNull(),
  /** 对账截止的业务日期，`YYYY-MM-DD` */
  asOf: text('asOf').notNull(),
  /** 用户声称的实际份额 */
  claimedShares: real('claimedShares').notNull(),
  /** 从全部已确认流水重推出来的份额 */
  derivedShares: real('derivedShares').notNull(),
  matched: integer('matched', { mode: 'boolean' }).notNull(),
  note: text('note'),
  createdAt: text('createdAt').notNull(),
})

/**
 * 数据源层 `CacheStore` 的落库形态（计划 3 留的扩展缝）。
 *
 * @remarks `value` 存 **JSON 文本**而非 blob——出问题时能直接 `SELECT` 出来看。
 * 信封各字段单列，便于排查「这条数据多旧」。
 */
export const cache = sqliteTable('cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  source: text('source').notNull(),
  dataAsOf: text('dataAsOf').notNull(),
  capturedAt: text('capturedAt').notNull(),
  /** 过期时刻，epoch 毫秒 */
  expiresAt: integer('expiresAt').notNull(),
})
