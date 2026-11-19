import { expect, it } from 'vitest'
import type { CashFlow } from './cashflow.ts'
import { MultipleRootsError, npv, xirr } from './xirr.ts'

const cf = (date: string, amount: number): CashFlow => ({ date, amount })

it('npv 零利率时等于简单求和，且拒绝非有限数金额', () => {
  expect(npv(0, [cf('2024-01-01', -1000), cf('2024-12-31', 1100)])).toBeCloseTo(100, 6)
  expect(() => npv(0.1, [cf('2024-01-01', Number.NaN)])).toThrow(TypeError)
})

it('npv 以最早一笔为贴现基准，非零利率下对输入顺序不敏感', () => {
  // 定义是「距最早一笔的天数」。若取首元素作基准，乱序时基准错，但数值看着合理。
  const ordered = [cf('2024-01-01', -1000), cf('2024-07-01', 500), cf('2025-01-01', 600)]
  const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!]
  expect(npv(0.1, shuffled)).toBeCloseTo(npv(0.1, ordered), 10)
})

it('持有满一年赚 10% / 亏 10% → 年化 ±10%', () => {
  expect(xirr([cf('2024-01-01', -1000), cf('2024-12-31', 1100)])).toBeCloseTo(0.1, 6)
  expect(xirr([cf('2024-01-01', -1000), cf('2024-12-31', 900)])).toBeCloseTo(-0.1, 6)
})

it('解出的收益率使净现值为零（自洽性）', () => {
  const flows = [
    cf('2024-01-01', -1000),
    cf('2024-03-15', -2000),
    cf('2024-07-01', 500),
    cf('2025-01-01', 2800),
  ]
  const r = xirr(flows)
  expect(r).not.toBeNull()
  expect(npv(r!, flows)).toBeCloseTo(0, 4)
})

it('现金流乱序输入也能算出同样结果', () => {
  const ordered = [cf('2024-01-01', -1000), cf('2024-07-01', 500), cf('2025-01-01', 600)]
  const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!]
  expect(xirr(shuffled)).toBeCloseTo(xirr(ordered)!, 10)
})

it('无解情形一律返回 null', () => {
  expect(xirr([cf('2024-01-01', -1000), cf('2024-07-01', -500)])).toBeNull() // 全部同号
  expect(xirr([cf('2024-01-01', -1000)])).toBeNull() // 只有一笔
  expect(xirr([cf('2024-01-01', -1000), cf('2024-01-01', 1000)])).toBeNull() // 同日相抵
})

it('多解现金流 → 抛 MultipleRootsError，错误信息列出全部根', () => {
  // 10% / 20% / 30% 三个年化率都让 NPV 归零：收益率不唯一，不能挑一个当答案
  const flows = [
    cf('2021-01-01', -1000),
    cf('2022-01-01', 3600),
    cf('2023-01-01', -4310),
    cf('2024-01-01', 1716),
  ]
  let caught: unknown
  try {
    xirr(flows)
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(MultipleRootsError)
  expect((caught as MultipleRootsError).roots).toHaveLength(3)
  expect((caught as Error).message).toContain('多个解')
  expect((caught as Error).message).toContain('10.00%')
})

it('多次转向但只有一个解时照常返回，不误报多解', () => {
  // 符号变化 3 次（会触发扫描），但 NPV 在区间内只有 4.9476% 一个根
  const flows = [
    cf('2021-01-01', -1000),
    cf('2022-01-01', 600),
    cf('2023-01-01', -100),
    cf('2024-01-01', 600),
  ]
  expect(xirr(flows)).toBeCloseTo(0.0494758, 6)
})
