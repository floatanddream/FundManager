import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { subscriptionShares } from './subscription.ts'

it('按申购金额扣除手续费后除以精确确认净值', () => {
  expect(subscriptionShares(1000, 10, navConfirmed(1.25, '2026-11-20'))).toBeCloseTo(792, 10)
})
