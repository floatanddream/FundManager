import { describe, expect, it } from 'vitest'
import type { CashFlow } from './cashflow.ts'
import { npv, xirr } from './xirr.ts'

describe('npv', () => {
  it('零利率时等于简单求和', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-12-31', amount: 1100 },
    ]
    expect(npv(0, flows)).toBeCloseTo(100, 6)
  })
})

describe('xirr', () => {
  it('持有满一年、赚 10% → 年化 10%', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-12-31', amount: 1100 },
    ]
    expect(xirr(flows)).toBeCloseTo(0.1, 6)
  })

  it('持有满一年、亏 10% → 年化 -10%', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-12-31', amount: 900 },
    ]
    expect(xirr(flows)).toBeCloseTo(-0.1, 6)
  })

  it('解出的收益率使净现值为零（自洽性）', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-03-15', amount: -2000 },
      { date: '2024-07-01', amount: 500 },
      { date: '2025-01-01', amount: 2800 },
    ]
    const r = xirr(flows)
    expect(r).not.toBeNull()
    expect(npv(r!, flows)).toBeCloseTo(0, 4)
  })

  it('现金流乱序输入也能算出同样结果（Review Focus #4）', () => {
    const ordered: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: 500 },
      { date: '2025-01-01', amount: 600 },
    ]
    const shuffled: CashFlow[] = [ordered[2]!, ordered[0]!, ordered[1]!]
    expect(xirr(shuffled)).toBeCloseTo(xirr(ordered)!, 10)
  })

  it('全部现金流同号 → null，不死循环（Review Focus #1）', () => {
    const allOut: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: -500 },
    ]
    expect(xirr(allOut)).toBeNull()
  })

  it('只有一笔现金流 → null（Review Focus #6）', () => {
    expect(xirr([{ date: '2024-01-01', amount: -1000 }])).toBeNull()
  })

  it('空数组 → null', () => {
    expect(xirr([])).toBeNull()
  })

  it('同日一进一出相抵后无解 → null', () => {
    const flows: CashFlow[] = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-01-01', amount: 1000 },
    ]
    expect(xirr(flows)).toBeNull()
  })
})
