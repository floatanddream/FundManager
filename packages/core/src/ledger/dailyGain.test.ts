import { navConfirmed } from '@fundmanager/shared'
import { describe, expect, it } from 'vitest'
import { calculateDailyGain, type LedgerTransaction } from '../index.ts'

const tx = (
  id: string,
  date: string,
  kind: LedgerTransaction['kind'],
  sharesDelta: number | null,
  amount: number,
  splitRatio: number | null = null,
  sequence = 0,
): LedgerTransaction => ({
  id,
  ledgerId: 'l',
  fundCode: '011609',
  date,
  kind,
  sharesDelta,
  splitRatio,
  amount,
  status: 'confirmed',
  sequence,
  note: null,
})
const base = {
  ledgerId: 'l',
  fundCode: '011609',
  previousDate: '2026-11-19',
  valuationDate: '2026-11-20',
}

it('把申购、现金分红与份额折算按外部现金流口径计入日收益', () => {
  const transactions = [
    tx('buy', '2026-11-19', 'subscribe', 100, -100),
    tx('split', '2026-11-20', 'split', null, 0, 2),
    tx('div', '2026-11-20', 'dividend_cash', null, 10, null, 1),
  ]
  expect(
    calculateDailyGain({
      ...base,
      transactions,
      previousNav: navConfirmed(1, base.previousDate),
      latestNav: navConfirmed(0.5, base.valuationDate),
    }),
  ).toBeCloseTo(10)
})

it('把同窗全赎基金纳入收益，缺少有份额一端净值则不可计算', () => {
  const transactions = [
    tx('buy', base.previousDate, 'subscribe', 100, -100),
    tx('sell', base.valuationDate, 'redeem', -100, 105),
  ]
  expect(
    calculateDailyGain({
      ...base,
      transactions,
      previousNav: navConfirmed(1, base.previousDate),
      latestNav: null,
    }),
  ).toBeCloseTo(5)
  expect(
    calculateDailyGain({
      ...base,
      transactions,
      previousNav: null,
      latestNav: navConfirmed(1.05, base.valuationDate),
    }),
  ).toBeNull()
})
