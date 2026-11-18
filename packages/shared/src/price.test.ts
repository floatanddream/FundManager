import { describe, expect, expectTypeOf, it } from 'vitest'
import { isConfirmed, marketPrice, navConfirmed, navEstimate } from './price.ts'
import type { AnyPrice, MarketPrice, NavConfirmed, NavEstimate } from './price.ts'

describe('三种价格类型', () => {
  it('构造确认净值', () => {
    const p = navConfirmed(1.539, '2026-11-16')
    expect(p.kind).toBe('nav')
    expect(p.value).toBe(1.539)
    expect(p.date).toBe('2026-11-16')
  })

  it('确认净值拒绝带时间的日期', () => {
    expect(() => navConfirmed(1.539, '2026-11-16T00:00:00')).toThrow(TypeError)
  })

  it('构造盘中估值时必带基准说明', () => {
    const e = navEstimate(1.5379, '2026-11-17T14:32:00+08:00', '上证科创板50成份指数')
    expect(e.kind).toBe('estimate')
    expect(e.basis).toBe('上证科创板50成份指数')
  })

  it('构造场内成交价', () => {
    const m = marketPrice(4.042, '2026-11-17T16:14:55+08:00')
    expect(m.kind).toBe('price')
  })

  it('isConfirmed 只对确认净值为真', () => {
    expect(isConfirmed(navConfirmed(1.0, '2026-11-16'))).toBe(true)
    expect(isConfirmed(navEstimate(1.0, '2026-11-17T14:32:00+08:00', 'x'))).toBe(false)
    expect(isConfirmed(marketPrice(1.0, '2026-11-17T16:14:55+08:00'))).toBe(false)
  })

  it('估值与场内价在类型层面不可当作确认净值使用', () => {
    // 本设计的核心安全机制：传错东西，编译期就该报错，而不是运行时才发现。
    // expect-type 不支持对 toBeCallableWith 取反（负向匹配器上它是 never），
    // 只能按官方推荐用 @ts-expect-error 断言调用不通过编译；这样若哪天类型被
    // 放宽到能通过，typecheck 会因「未使用的 @ts-expect-error」而失败，守卫依然生效。
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
})
