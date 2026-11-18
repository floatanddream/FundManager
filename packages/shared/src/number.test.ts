import { expect, it } from 'vitest'
import { approxEqual } from './number.ts'

it('相同，或只差浮点误差的两个数，都算相等', () => {
  expect(0.1 + 0.2 === 0.3).toBe(false) // 0.1 + 0.2 在 float64 下是 0.30000000000000004
  expect(approxEqual(1.539, 1.539)).toBe(true)
  expect(approxEqual(0.1 + 0.2, 0.3)).toBe(true)
})

it('超出容差则不相等', () => {
  expect(approxEqual(1.539, 1.54)).toBe(false)
})

it('大数值下相对容差生效', () => {
  // 账本累加 1000 笔后误差可达 1e-5 量级，绝对容差 1e-9 挡不住
  expect(Math.abs(633333.2814000114 - 633333.2814)).toBeGreaterThan(1e-9)
  expect(approxEqual(633333.2814000114, 633333.2814)).toBe(true)
})

it('NaN 与 Infinity 一律不相等', () => {
  expect(approxEqual(Number.NaN, Number.NaN)).toBe(false)
  expect(approxEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false)
})
