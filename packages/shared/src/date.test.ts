import { describe, expect, it } from 'vitest'
import { assertDate, daysBetween } from './date.ts'

describe('assertDate', () => {
  it('合法日期原样返回', () => {
    expect(assertDate('2026-11-16')).toBe('2026-11-16')
  })

  it('斜杠格式抛异常', () => {
    expect(() => assertDate('2024/01/01')).toThrow(TypeError)
  })

  it('带时间的字符串抛异常（Review Focus #2）', () => {
    // 实测 Date.parse('2024-01-01') 按 UTC 解释、'2024-01-01T00:00:00' 按本地解释，
    // 同一天差 8 小时，会让日期静默错位一天。必须在这里拦住。
    expect(() => assertDate('2024-01-01T00:00:00')).toThrow(TypeError)
    expect(() => assertDate('2024-01-01T00:00:00+08:00')).toThrow(TypeError)
  })

  it('不存在的日期抛异常（Review Focus #3）', () => {
    // 正则挡不住这个，JavaScript 会把它滚到 3 月 2 日
    expect(() => assertDate('2024-02-31')).toThrow(TypeError)
    expect(() => assertDate('2024-13-01')).toThrow(TypeError)
    expect(() => assertDate('2023-02-29')).toThrow(TypeError)
  })

  it('闰年 2 月 29 日合法', () => {
    expect(assertDate('2024-02-29')).toBe('2024-02-29')
  })
})

describe('daysBetween', () => {
  it('相邻两天相差 1', () => {
    expect(daysBetween('2024-01-01', '2024-01-02')).toBe(1)
  })

  it('逆序为负数', () => {
    expect(daysBetween('2024-03-01', '2024-01-01')).toBe(-60)
  })

  it('闰年整年 366 天', () => {
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366)
  })

  it('平年整年 365 天', () => {
    expect(daysBetween('2025-01-01', '2026-01-01')).toBe(365)
  })

  it('非法日期同样抛异常', () => {
    expect(() => daysBetween('2024-01-01', 'nope')).toThrow(TypeError)
  })
})
