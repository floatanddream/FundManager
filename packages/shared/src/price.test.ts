import { expect, expectTypeOf, it } from 'vitest'
import { isConfirmed, marketPrice, navConfirmed, navEstimate } from './price.ts'
import type { AnyPrice, MarketPrice, NavConfirmed, NavEstimate } from './price.ts'

it('三种价格各自构造，kind 相互区分', () => {
  const nav = navConfirmed(1.539, '2026-11-16')
  expect(nav.kind).toBe('nav')
  expect(nav.value).toBe(1.539)
  expect(nav.date).toBe('2026-11-16')

  const est = navEstimate(1.5379, '2026-11-17T14:32:00+08:00', '上证科创板50成份指数')
  expect(est.kind).toBe('estimate')
  expect(est.basis).toBe('上证科创板50成份指数')

  expect(marketPrice(4.042, '2026-11-17T16:14:55+08:00').kind).toBe('price')
})

it('确认净值拒绝带时间的日期', () => {
  expect(() => navConfirmed(1.539, '2026-11-16T00:00:00')).toThrow(TypeError)
})

it('isConfirmed 只对确认净值为真', () => {
  expect(isConfirmed(navConfirmed(1.0, '2026-11-16'))).toBe(true)
  expect(isConfirmed(navEstimate(1.0, '2026-11-17T14:32:00+08:00', 'x'))).toBe(false)
  expect(isConfirmed(marketPrice(1.0, '2026-11-17T16:14:55+08:00'))).toBe(false)
})

it('估值与场内价在类型层面不可当作确认净值使用', () => {
  // 本设计的核心安全机制：传错东西编译期就该报错，而不是运行时才发现。
  // 用 @ts-expect-error 断言调用不通过编译——若哪天类型被放宽到能通过，
  // 该指令变成「无用」，typecheck 反而失败，守卫依然生效。
  const takesConfirmed = (n: NavConfirmed): number => n.value
  expectTypeOf(takesConfirmed).toBeCallableWith(navConfirmed(1.0, '2026-11-16'))
  // @ts-expect-error 估值不能传给只接受 NavConfirmed 的位置
  takesConfirmed(navEstimate(1.0, '2026-11-17T14:32:00+08:00', 'x'))
  // @ts-expect-error 场内成交价不能传给只接受 NavConfirmed 的位置
  takesConfirmed(marketPrice(1.0, '2026-11-17T16:14:55+08:00'))
})

it('AnyPrice 是三种类型的联合', () => {
  expectTypeOf<AnyPrice>().toEqualTypeOf<NavConfirmed | NavEstimate | MarketPrice>()
})
