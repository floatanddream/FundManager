import { expect, it } from 'vitest'
import { assertDate, daysBetween } from './date.ts'

it('合法日期原样返回', () => {
  expect(assertDate('2026-11-16')).toBe('2026-11-16')
  expect(assertDate('2024-02-29')).toBe('2024-02-29') // 闰年 2 月 29 日合法
})

it('非法日期抛异常', () => {
  expect(() => assertDate('2024/01/01')).toThrow(TypeError)
  // 带时间的字符串：Date.parse 依有无时区分别按 UTC / 本地解释，同一天差 8 小时
  expect(() => assertDate('2024-01-01T00:00:00')).toThrow(TypeError)
  expect(() => assertDate('2024-01-01T00:00:00+08:00')).toThrow(TypeError)
  // 不存在的日期：正则挡不住，JavaScript 会把它滚到下个月
  expect(() => assertDate('2024-02-31')).toThrow(TypeError)
  expect(() => assertDate('2024-13-01')).toThrow(TypeError)
  expect(() => assertDate('2023-02-29')).toThrow(TypeError)
})

it('日期差按天算，逆序为负，非法日期抛异常', () => {
  expect(daysBetween('2024-01-01', '2024-01-02')).toBe(1)
  expect(daysBetween('2024-03-01', '2024-01-01')).toBe(-60)
  expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366) // 闰年
  expect(daysBetween('2025-01-01', '2026-01-01')).toBe(365)
  expect(() => daysBetween('2024-01-01', 'nope')).toThrow(TypeError)
})
