import { expect, it } from 'vitest'
import { toHttpError } from './errors.ts'

it('超赎被翻译成可操作提示，不吐 core 原文', () => {
  const r = toHttpError(new TypeError('赎回 120 份但账面只有 100 份，流水不完整：t1'))
  expect(r).toEqual({ status: 400, message: '这笔赎回超过了账面份额，请先补录买入' })
})

it('同日的顺序问题与缺必填字段各有提示', () => {
  const msg = (m: string) => toHttpError(new TypeError(m)).message
  expect(msg('2026-01-05 有 2 笔流水，必须给 sequence（同日顺序不能靠入参顺序）：t1')).toBe(
    '同一天有多笔流水，需要指定先后顺序',
  )
  expect(msg('2026-01-05 有重复的 sequence 0：t2')).toBe('同一天的顺序号重复了')
  expect(msg('redeem 流水缺 sharesDelta，无法推导份额与成本：t3')).toBe('这笔记账缺少份额')
  expect(msg('split 流水缺 splitRatio，无法推导份额：t4')).toBe('这笔记账缺少份额')
})

it('未知 TypeError 给 400 加原文，非 TypeError 给 500 通用提示', () => {
  const text = 'periodsPerYear 必须是正数，收到：0'
  expect(toHttpError(new TypeError(text))).toEqual({ status: 400, message: text })
  const r = toHttpError(new Error('ECONNRESET'))
  expect(r.status).toBe(500)
  expect(r.message).not.toContain('ECONNRESET')
})
