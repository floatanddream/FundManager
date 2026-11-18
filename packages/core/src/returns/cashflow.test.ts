import { describe, expect, it } from 'vitest'
import { normalizeFlows } from './cashflow.ts'
import type { CashFlow } from './cashflow.ts'

describe('现金流归一化', () => {
  it('按日期升序排序，不理会输入顺序', () => {
    const input: CashFlow[] = [
      { date: '2025-01-01', amount: 600 },
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: 500 },
    ]
    expect(normalizeFlows(input).map((f) => f.date)).toEqual([
      '2024-01-01',
      '2024-07-01',
      '2025-01-01',
    ])
  })

  it('同日期多笔合并求和', () => {
    const input: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-01-01', amount: -500 },
    ]
    expect(normalizeFlows(input)).toEqual([{ date: '2024-01-01', amount: -1500 }])
  })

  it('合并后金额归零的笔次被剔除', () => {
    const input: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-01-01', amount: 1000 },
      { date: '2024-07-01', amount: 500 },
    ]
    expect(normalizeFlows(input)).toEqual([{ date: '2024-07-01', amount: 500 }])
  })

  it('不修改入参', () => {
    const input: CashFlow[] = [
      { date: '2025-01-01', amount: 600 },
      { date: '2024-01-01', amount: -1000 },
    ]
    normalizeFlows(input)
    expect(input[0]!.date).toBe('2025-01-01')
  })

  it('日期非法抛异常', () => {
    expect(() => normalizeFlows([{ date: '2024/01/01', amount: -1000 }])).toThrow(TypeError)
  })

  it('金额非有限数抛异常', () => {
    expect(() => normalizeFlows([{ date: '2024-01-01', amount: Number.NaN }])).toThrow(TypeError)
  })
})
