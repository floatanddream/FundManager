import { expect, it } from 'vitest'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'
import { createLedgerRepository } from '../repository/ledgerRepository.ts'
import { createTransactionRepository } from '../repository/transactionRepository.ts'
import { addTransaction, type NewTransaction, type TransactionDeps } from './transactionService.ts'

const buy = (o: Partial<NewTransaction> = {}): NewTransaction => ({
  fundCode: '000001',
  date: '2026-01-05',
  kind: 'subscribe',
  sharesDelta: 100,
  splitRatio: null,
  amount: -150,
  sequence: null,
  note: null,
  ...o,
})

/** 真 `:memory:` 库上的 Repository——坏数据有没有落库，只有库知道 */
const fresh = async (ledgerId = 'L1') => {
  const { db, sqlite } = openDatabase()
  // 账本用字面量 id 直接插：录入要求账本真实存在，而 create() 只生成随机 id
  sqlite
    .prepare('INSERT INTO ledger (id, name, createdAt) VALUES (?, ?, ?)')
    .run(ledgerId, '测试账本', '2026-01-01T00:00:00+08:00')
  const repo = createTransactionRepository(db)
  const deps: TransactionDeps = {
    transactionRepository: repo,
    ledgerRepository: createLedgerRepository(db),
  }
  return { deps, list: () => repo.listByFund(ledgerId, '000001') }
}

it('正常买入写库：状态 confirmed，带生成的 id', async () => {
  const { deps, list } = await fresh()
  const saved = await addTransaction(deps, 'L1', buy())
  expect(saved.value).toMatchObject({ ledgerId: 'L1', kind: 'subscribe', status: 'confirmed' })
  expect(saved.value!.id).toBeTruthy()
  expect(await list()).toHaveLength(1)
})

it('同日 sequence 重复在提交前被拦下，坏数据不入库', async () => {
  const { deps, list } = await fresh()
  await addTransaction(deps, 'L1', buy({ sequence: 0 }))
  // 第二笔同日 sequence 与第一笔撞车；先存后炸会让之后每条路由都失败
  await expect(
    addTransaction(
      deps,
      'L1',
      buy({ kind: 'split', sharesDelta: null, splitRatio: 0.5, sequence: 0 }),
    ),
  ).rejects.toThrow(TypeError)
  expect(await list()).toHaveLength(1)
})

it('超赎与同日缺 sequence 都在提交前被拦下，库不变', async () => {
  const { deps, list } = await fresh()
  await expect(
    addTransaction(deps, 'L1', buy({ kind: 'redeem', sharesDelta: -120, amount: 180 })),
  ).rejects.toThrow(/赎回 120 份但账面只有 0 份/)
  expect(await list()).toHaveLength(0)

  await addTransaction(deps, 'L1', buy())
  await expect(
    addTransaction(deps, 'L1', buy({ kind: 'dividend_cash', sharesDelta: null, amount: 5 })),
  ).rejects.toThrow(/必须给 sequence/)
  expect(await list()).toHaveLength(1)
})

it('缺份额由推导报错并拦下，不入库', async () => {
  const { deps, list } = await fresh()
  await expect(
    addTransaction(deps, 'L1', buy({ sharesDelta: null, amount: -100 })),
  ).rejects.toThrow(/缺 sharesDelta/)
  expect(await list()).toHaveLength(0)
})

// 路由层：真库 + Fastify inject，断言错误被翻译且坏数据没有把后续路由弄坏
const app = () => {
  const { db, sqlite } = openDatabase()
  // 录入要求账本真实存在（防止流水挂在不存在的 ledgerId 下），路由测试也要先建一本
  sqlite
    .prepare('INSERT INTO ledger (id, name, createdAt) VALUES (?, ?, ?)')
    .run('L1', '测试账本', '2026-01-01T00:00:00+08:00')
  return { app: buildApp({ db, dataSource: null as never }), repo: createTransactionRepository(db) }
}

it('路由把超赎翻译成可操作提示而非 TypeError 原文；被拒的那笔没有入库', async () => {
  const { app: a, repo } = app()
  const picked = await a.inject({
    method: 'POST',
    url: '/api/ledgers/L1/transactions',
    payload: {
      fundCode: '000001',
      date: '2026-01-05',
      kind: 'subscribe',
      sharesDelta: 100,
      amount: -150,
    },
  })
  expect(picked.statusCode).toBe(201)
  expect(JSON.parse(picked.body).value.status).toBe('confirmed')

  const over = await a.inject({
    method: 'POST',
    url: '/api/ledgers/L1/transactions',
    payload: {
      fundCode: '000001',
      date: '2026-01-06',
      kind: 'redeem',
      sharesDelta: -120,
      amount: 180,
    },
  })
  expect(over.statusCode).toBe(400)
  expect(JSON.parse(over.body).error).toBe('这笔赎回超过了账面份额，请先补录买入')

  expect((await repo.listByFund('L1', '000001')).map((t) => t.kind)).toEqual(['subscribe'])
  // 账面仍是 100 份，赎回 100 份应当通过
  const ok = await a.inject({
    method: 'POST',
    url: '/api/ledgers/L1/transactions',
    payload: {
      fundCode: '000001',
      date: '2026-01-07',
      kind: 'redeem',
      sharesDelta: -100,
      amount: 150,
    },
  })
  expect(ok.statusCode).toBe(201)
})

it('路由对缺金额、坏日期、坏基金代码给 400，不落库', async () => {
  const { app: a, repo } = app()
  const post = (payload: object) =>
    a.inject({ method: 'POST', url: '/api/ledgers/L1/transactions', payload })
  const base = { fundCode: '000001', date: '2026-01-05', kind: 'subscribe', sharesDelta: 100 }
  expect((await post(base)).statusCode).toBe(400) // 缺 amount
  expect((await post({ ...base, date: '2026/01/05', amount: -1 })).statusCode).toBe(400)
  expect((await post({ ...base, fundCode: 'abc', amount: -1 })).statusCode).toBe(400)
  expect(await repo.listByFund('L1', '000001')).toEqual([])
})
