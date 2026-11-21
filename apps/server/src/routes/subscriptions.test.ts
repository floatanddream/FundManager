import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/client.ts'

it('待申购精确报价、确认并在重复请求时返回原流水', async () => {
  const { db, sqlite } = openDatabase()
  const source = {
    navHistory: async () => ({
      value: {
        fundCode: '011609',
        rows: [
          { nav: navConfirmed(1.25, '2025-11-20'), accNav: 1.25, growthRate: null, event: null },
        ],
      },
      stale: false,
    }),
  }
  const app = buildApp({ db, dataSource: source as never })
  const ledger = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/ledgers', payload: { name: '测试' } })).body,
  ).value
  const created = await app.inject({
    method: 'POST',
    url: `/api/ledgers/${ledger.id}/subscriptions`,
    payload: { fundCode: '011609', orderDate: '2025-11-19', amount: 1000 },
  })
  expect(created.statusCode).toBe(201)
  const draft = JSON.parse(created.body)
  const overview = await app.inject(`/api/ledgers/${ledger.id}/overview`)
  expect(overview.json().value).toMatchObject({ marketValue: { value: 0 }, positions: [] })
  const quote = await app.inject({
    method: 'POST',
    url: `/api/ledgers/${ledger.id}/subscriptions/${draft.id}/quote`,
    payload: { navDate: '2025-11-20', fee: 10 },
  })
  expect(JSON.parse(quote.body)).toMatchObject({
    shares: 792,
    nav: 1.25,
    navDate: '2025-11-20',
    reason: null,
  })
  const url = `/api/ledgers/${ledger.id}/subscriptions/${draft.id}/confirm`
  const payload = { navDate: '2025-11-20', fee: 10, sequence: 0 }
  const first = JSON.parse((await app.inject({ method: 'POST', url, payload })).body)
  expect(first).toMatchObject({ id: draft.id, date: payload.navDate, sharesDelta: 792 })
  const retry = JSON.parse(
    (await app.inject({ method: 'POST', url, payload: { navDate: '2025-11-20', fee: 10 } })).body,
  )
  expect(retry).toEqual(first)
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "transaction"').get()).toMatchObject({
    count: 1,
  })
  expect(
    JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/ledgers/${ledger.id}/subscriptions` })).body,
    ),
  ).toEqual([])
  await app.close()
  sqlite.close()
})

it('无精确净值时不给报价，且允许用户按对账单份额确认', async () => {
  const { db, sqlite } = openDatabase()
  const source = {
    navHistory: async () => ({ value: { fundCode: '011609', rows: [] }, stale: false }),
  }
  const app = buildApp({ db, dataSource: source as never })
  const ledger = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/ledgers', payload: { name: '测试' } })).body,
  ).value
  const draft = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: `/api/ledgers/${ledger.id}/subscriptions`,
        payload: { fundCode: '011609', orderDate: '2025-11-19', amount: 1000 },
      })
    ).body,
  )
  const q = await app.inject({
    method: 'POST',
    url: `/api/ledgers/${ledger.id}/subscriptions/${draft.id}/quote`,
    payload: { navDate: '2025-11-20', fee: 0 },
  })
  expect(JSON.parse(q.body).shares).toBeNull()
  const c = await app.inject({
    method: 'POST',
    url: `/api/ledgers/${ledger.id}/subscriptions/${draft.id}/confirm`,
    payload: { navDate: '2025-11-20', shares: 800 },
  })
  expect(JSON.parse(c.body).sharesDelta).toBe(800)
  await app.close()
  sqlite.close()
})

it('同一申购被同时确认时，两个响应返回同一笔已保存的流水', async () => {
  const { db, sqlite } = openDatabase()
  const app = buildApp({ db, dataSource: {} as never })
  try {
    const ledger = (
      await app.inject({ method: 'POST', url: '/api/ledgers', payload: { name: '测试' } })
    ).json().value
    const path = `/api/ledgers/${ledger.id}/subscriptions`
    const { id } = (
      await app.inject({
        method: 'POST',
        url: path,
        payload: { fundCode: '011609', orderDate: '2025-11-19', amount: 1000 },
      })
    ).json()
    const responses = await Promise.all(
      [801, 802].map((shares) =>
        app.inject({
          method: 'POST',
          url: `${path}/${id}/confirm`,
          payload: { navDate: '2025-11-20', shares },
        }),
      ),
    )
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200])
    expect(responses[0]!.json()).toEqual(responses[1]!.json())
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "transaction"').get()).toMatchObject({
      count: 1,
    })
  } finally {
    await app.close()
    sqlite.close()
  }
})
