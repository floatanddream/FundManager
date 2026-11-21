import type { NavConfirmed } from '@fundmanager/shared'

/** 按确认净值与申购费计算到账份额。 */
export function subscriptionShares(amount: number, fee: number, nav: NavConfirmed): number {
  if (!Number.isFinite(amount) || amount <= 0) throw new TypeError('申购金额必须为正数')
  if (!Number.isFinite(fee) || fee < 0 || fee >= amount)
    throw new TypeError('申购费必须非负且小于申购金额')
  if (!Number.isFinite(nav.value) || nav.value <= 0) throw new TypeError('确认净值必须为正数')
  return (amount - fee) / nav.value
}
