import { expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { openDatabase } from './db/client.ts'

// 账本路由不碰数据源，传 null 省掉一个 15 个方法的假实现（§8.9）
const app = () => buildApp({ db: openDatabase().db, dataSource: null as never })

it('没有账本时返回空列表（200，不是 404），信封字段齐全', async () => {
  const r = await app().inject({ method: 'GET', url: '/api/ledgers' })
  expect(r.statusCode).toBe(200)
  expect(JSON.parse(r.body)).toMatchObject({ value: [], reason: null, stale: false, loss: null })
})

it('POST 建账本返回 201 与 id，随后列表里就是它', async () => {
  const a = app()
  const created = await a.inject({ method: 'POST', url: '/api/ledgers', payload: { name: '实盘' } })
  expect(created.statusCode).toBe(201)
  const { value: ledger } = JSON.parse(created.body)
  const list = await a.inject({ method: 'GET', url: '/api/ledgers' })
  expect(JSON.parse(list.body).value).toEqual([{ id: ledger.id, name: '实盘' }])
})

it('空名（含纯空格）被拒为 400，且不落库', async () => {
  const a = app()
  const r = await a.inject({ method: 'POST', url: '/api/ledgers', payload: { name: '   ' } })
  expect(r.statusCode).toBe(400)
  expect(JSON.parse(r.body).error).toContain('名称')
  expect(JSON.parse((await a.inject({ method: 'GET', url: '/api/ledgers' })).body).value).toEqual(
    [],
  )
})
