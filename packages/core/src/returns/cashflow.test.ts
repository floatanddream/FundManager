import { expect, it } from 'vitest'
import type { CashFlow } from './cashflow.ts'
import { normalizeFlows } from './cashflow.ts'

const cf = (date: string, amount: number): CashFlow => ({ date, amount })

it('按日期升序排序，不理会输入顺序', () => {
  const input = [cf('2025-01-01', 600), cf('2024-01-01', -1000), cf('2024-07-01', 500)]
  const dates = normalizeFlows(input).map((f) => f.date)
  expect(dates).toEqual(['2024-01-01', '2024-07-01', '2025-01-01'])
})

it('同日多笔合并求和，合并后归零的笔次被剔除', () => {
  const merged = [cf('2024-01-01', -1000), cf('2024-01-01', -500)]
  expect(normalizeFlows(merged)).toEqual([cf('2024-01-01', -1500)])

  const netted = [cf('2024-01-01', -1000), cf('2024-01-01', 1000), cf('2024-07-01', 500)]
  expect(normalizeFlows(netted)).toEqual([cf('2024-07-01', 500)])
})

it('不修改入参', () => {
  const input = [cf('2025-01-01', 600), cf('2024-01-01', -1000)]
  normalizeFlows(input)
  expect(input[0]!.date).toBe('2025-01-01')
})

it('日期非法或金额非有限数抛异常', () => {
  expect(() => normalizeFlows([cf('2024/01/01', -1000)])).toThrow(TypeError)
  expect(() => normalizeFlows([cf('2024-01-01', Number.NaN)])).toThrow(TypeError)
})
