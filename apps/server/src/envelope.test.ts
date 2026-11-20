import { expect, it } from 'vitest'
import { fromDerived, fromFetched, type Sourced } from './envelope.ts'

const src = (
  dataAsOf: string,
  o: { stale?: boolean; loss?: string | null } = {},
): Sourced<number> => ({
  value: 1,
  reason: null,
  source: 'f10/lsjz',
  dataAsOf,
  capturedAt: '2026-11-19T10:00:00+08:00',
  stale: o.stale ?? false,
  loss: o.loss ?? null,
  provenance: [],
})

it('派生值的 dataAsOf 取最早的那个输入', () => {
  expect(fromDerived(42, null, [src('2026-11-18'), src('2026-09-30')]).dataAsOf).toBe('2026-09-30')
})

it('任一输入 stale，派生值就 stale', () => {
  expect(fromDerived(42, null, [src('2026-09-30', { stale: true }), src('2026-11-18')]).stale).toBe(
    true,
  )
  expect(fromDerived(42, null, [src('2026-09-30'), src('2026-11-18')]).stale).toBe(false)
})

it('各输入的 loss 拼接带出；全空则 null', () => {
  const r = fromDerived(42, null, [
    src('2026-09-30', { loss: '仅前十大' }),
    src('2026-11-18', { loss: '净值缺分红字段' }),
  ])
  expect(r.loss).toBe('仅前十大；净值缺分红字段')
  expect(fromDerived(42, null, [src('2026-09-30')]).loss).toBeNull()
})

it('算不出来时 value 为 null 且带 reason', () => {
  const r = fromDerived<number>(null, '成本未知', [src('2026-09-30')])
  expect(r.value).toBeNull()
  expect(r.reason).toBe('成本未知')
})

it('直接来自数据源时 reason 为 null、provenance 为空，stale 与 loss 原样带出', () => {
  const e = fromFetched({
    value: 1.5,
    source: 'f10/lsjz',
    dataAsOf: '2026-11-18',
    capturedAt: '2026-11-19T10:00:00+08:00',
    stale: true,
    loss: '仅前十大',
  })
  expect(e).toMatchObject({
    value: 1.5,
    reason: null,
    stale: true,
    loss: '仅前十大',
    provenance: [],
  })
})
