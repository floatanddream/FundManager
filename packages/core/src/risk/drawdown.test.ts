import { expect, it } from 'vitest'
import { navConfirmed } from '@fundmanager/shared'
import { currentDrawdown, drawdownRecoveryDays, maxDrawdown } from './drawdown.ts'

/** 从 2024-01-01 起逐日递增地搭一条序列 */
const series = (values: readonly number[]): ReturnType<typeof navConfirmed>[] =>
  values.map((v, i) => navConfirmed(v, `2024-01-${String(i + 1).padStart(2, '0')}`))

it('最大回撤取峰值到谷底的最大跌幅', () => {
  expect(maxDrawdown(series([1, 2, 1, 3]))).toBe(0.5) // 峰值 2 → 谷底 1
  expect(maxDrawdown(series([1, 2, 3]))).toBe(0) // 单调上升无回撤
})

it('序列不足两点 → null', () => {
  expect(maxDrawdown([])).toBeNull()
  expect(maxDrawdown(series([1]))).toBeNull()
  expect(drawdownRecoveryDays(series([1]))).toBeNull()
  expect(currentDrawdown([])).toBeNull()
  expect(currentDrawdown(series([1]))).toBeNull()
})

it('日期乱序抛异常（Review Focus #1）', () => {
  expect(() => maxDrawdown([navConfirmed(1, '2024-01-02'), navConfirmed(2, '2024-01-01')])).toThrow(
    TypeError,
  )
})

it('[1, 2, 1, 1, 1, 2] 的回撤修复期是 3 天', () => {
  // 峰值 01-02（值 2）→ 谷底 01-03（值 1）→ 01-06 回到 2
  expect(drawdownRecoveryDays(series([1, 2, 1, 1, 1, 2]))).toBe(3)
})

it('修复期无解时返回 null（从未回撤或结束时仍未修复）', () => {
  expect(drawdownRecoveryDays(series([1, 2, 3]))).toBeNull()
  // 谷底 01-03 之后再没回到峰值 2（Review Focus #4）
  expect(drawdownRecoveryDays(series([1, 2, 1, 1]))).toBeNull()
})

it('净值收复差一个 ulp 也算已修复', () => {
  // 2 − 1e-15 在 float64 里小于 2，精确比较会误报「仍在亏」（01-03 谷底，01-04 收复）
  expect(drawdownRecoveryDays(series([1, 2, 1, 2 - 1e-15]))).toBe(1)
})

it('当前回撤 = (历史峰值 − 末点) / 峰值', () => {
  expect(currentDrawdown(series([1, 2, 1, 1.5]))).toBe(0.25)
  expect(currentDrawdown(series([1, 2, 1, 3]))).toBe(0)
})
