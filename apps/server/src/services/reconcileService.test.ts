import { expect, it } from 'vitest'
import type { LedgerTransaction } from '@fundmanager/core'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'
import { createLedgerRepository } from '../repository/ledgerRepository.ts'
import { createReconcileRepository } from '../repository/reconcileRepository.ts'
import { createTransactionRepository } from '../repository/transactionRepository.ts'
import { getLastReconcile, reconcileFund, type ReconcileDeps } from './reconcileService.ts'

const tx = (o: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
  id: `t-${o.date ?? '2026-01-05'}`,
  ledgerId: 'L1',
  fundCode: '000001',
  date: '2026-01-05',
  kind: 'subscribe',
  sharesDelta: 1000,
  splitRatio: null,
  amount: -1500,
  status: 'confirmed',
  sequence: null,
  note: null,
  ...o,
})

/** 真 `:memory:` 库：对账要落记录，假 Repository 断言不了「记了什么」 */
const fresh = async (txs: readonly LedgerTransaction[] = [tx()]) => {
  const { db, sqlite } = openDatabase()
  // 账本用字面量 id 直接插：对账要求账本真实存在，而 create() 只生成随机 id
  sqlite
    .prepare('INSERT INTO ledger (id, name, createdAt) VALUES (?, ?, ?)')
    .run('L1', '测试账本', '2026-01-01T00:00:00+08:00')
  const transactionRepository = createTransactionRepository(db)
  for (const t of txs) await transactionRepository.add(t)
  const deps: ReconcileDeps = {
    transactionRepository,
    ledgerRepository: createLedgerRepository(db),
    reconcileRepository: createReconcileRepository(db),
  }
  return { db, sqlite, deps, transactionRepository }
}

it('份额对得上就 matched，上次对得上的日期一并带出', async () => {
  const { deps } = await fresh()
  const r = await reconcileFund(deps, 'L1', { fundCode: '000001', claimedShares: 1000 })
  expect(r.value).toMatchObject({ matched: true, derivedShares: 1000, lastMatchedOn: null })
})

it('对不上时给差异，且这条记录不算「上次对得上」', async () => {
  const { deps } = await fresh()
  const bad = await reconcileFund(deps, 'L1', { fundCode: '000001', claimedShares: 900 })
  expect([bad.value!.matched, bad.value!.difference]).toEqual([false, 100])
  // 对不上的记录不能当作「账是对的」的证据
  expect((await getLastReconcile(deps, 'L1', '000001')).value!.lastMatchedOn).toBeNull()

  const good = await reconcileFund(deps, 'L1', { fundCode: '000001', claimedShares: 1000 })
  expect(good.value!.matched).toBe(true)
  expect((await getLastReconcile(deps, 'L1', '000001')).value!.lastMatchedOn).toBe(good.value!.asOf)
})

it('对账绝不改流水：全量重推只回报结论', async () => {
  const { deps, transactionRepository } = await fresh()
  await reconcileFund(deps, 'L1', { fundCode: '000001', claimedShares: 1 })
  await reconcileFund(deps, 'L1', { fundCode: '000001', claimedShares: 1000 })
  expect(await transactionRepository.listByFund('L1', '000001')).toHaveLength(1)
})

it('回看历史对账时只显示截止日以前可见的匹配记录', async () => {
  const { deps } = await fresh()
  const input = { fundCode: '000001', claimedShares: 1000 }
  await reconcileFund(deps, 'L1', { ...input, asOf: '2026-01-10' })
  await reconcileFund(deps, 'L1', { ...input, asOf: '2026-01-20' })
  const earlier = await reconcileFund(deps, 'L1', { ...input, asOf: '2026-01-15' })
  expect(earlier.value?.lastMatchedOn).toBe('2026-01-10')
  expect((await getLastReconcile(deps, 'L1', '000001')).value?.lastMatchedOn).toBe('2026-01-20')
})

it('账本里没有这只基金的流水：推出来是 0 份，照常给结论而不是报错', async () => {
  const { deps } = await fresh()
  const r = await reconcileFund(deps, 'L1', { fundCode: '000002', claimedShares: 0 })
  expect(r.value).toMatchObject({ matched: true, derivedShares: 0, claimedShares: 0 })
})

it('未知账本对账 / 查上次对账都被拒，且库里不留任何对账记录', async () => {
  const { deps, sqlite } = await fresh()
  await expect(
    reconcileFund(deps, 'NOPE', { fundCode: '000001', claimedShares: 1000 }),
  ).rejects.toThrow(/账本 NOPE 不存在/)
  await expect(getLastReconcile(deps, 'NOPE', '000001')).rejects.toThrow(/账本 NOPE 不存在/)
  // 表没有外键：不查账本的话这一行会静默写进去
  const count = sqlite.prepare('SELECT COUNT(*) AS n FROM reconcile').get() as { n: number }
  expect(count.n).toBe(0)
})

it('账本已坏（超赎）时对账失败，不落一条假结论', async () => {
  const { deps, db } = await fresh([tx({ kind: 'redeem', sharesDelta: -1200, amount: 1800 })])
  await expect(reconcileFund(deps, 'L1', { fundCode: '000001', claimedShares: 0 })).rejects.toThrow(
    /赎回 1200 份但账面只有 0 份/,
  )
  expect(await createReconcileRepository(db).lastMatchedAt('L1', '000001')).toBeNull()
})

// 路由层：两个端点都走信封；`reconcile/last` 必须指明基金
const app = () => {
  const { db, sqlite } = openDatabase()
  sqlite
    .prepare('INSERT INTO ledger (id, name, createdAt) VALUES (?, ?, ?)')
    .run('L1', '测试账本', '2026-01-01T00:00:00+08:00')
  const repo = createTransactionRepository(db)
  return { app: buildApp({ db, dataSource: null as never }), repo }
}

it('对账路由：POST 给结论，GET last 给上次对得上的日期；缺 fundCode 为 400', async () => {
  const { app: a, repo } = app()
  await repo.add(tx())
  const r = await a.inject({
    method: 'POST',
    url: '/api/ledgers/L1/reconcile',
    payload: { fundCode: '000001', claimedShares: 1000 },
  })
  expect(r.statusCode).toBe(200)
  expect(JSON.parse(r.body)).toMatchObject({ value: { matched: true, derivedShares: 1000 } })

  const last = await a.inject({
    method: 'GET',
    url: '/api/ledgers/L1/reconcile/last?fundCode=000001',
  })
  expect(JSON.parse(last.body).value.lastMatchedOn).toBe(JSON.parse(r.body).value.asOf)
  expect(
    (await a.inject({ method: 'GET', url: '/api/ledgers/L1/reconcile/last' })).statusCode,
  ).toBe(400)
})

it('对账路由：未知账本是 400，不是 200', async () => {
  const { app: a } = app()
  const r = await a.inject({
    method: 'POST',
    url: '/api/ledgers/NOPE/reconcile',
    payload: { fundCode: '000001', claimedShares: 1000 },
  })
  expect([r.statusCode, JSON.parse(r.body).error]).toEqual([400, '账本 NOPE 不存在'])
})
