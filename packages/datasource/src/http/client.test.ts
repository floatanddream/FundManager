import { expect, it } from 'vitest'
import { HttpClient } from './client.ts'
import { HttpError } from './errors.ts'

/** 造一个假的 fetch：第 n 次调用返回第 n 个预设响应（越界则重复最后一个） */
const fakeFetch = (...responses: Response[]): typeof globalThis.fetch => {
  let i = 0
  return async () => responses[Math.min(i++, responses.length - 1)]!
}

const gbkHiShen300 = new Uint8Array([0xbb, 0xa6, 0xc9, 0xee, 0x33, 0x30, 0x30]) // GBK 字节，解出「沪深300」
const utf8BomA = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]) // UTF-8 BOM + 'a'

it('非 2xx 抛 HttpError', async () => {
  const c = new HttpClient({
    fetch: fakeFetch(new Response('nope', { status: 500 })),
    minIntervalMs: 0,
  })
  await expect(c.request({ url: 'https://x' })).rejects.toThrow(HttpError)
})

it('网络失败会重试，重试到成功为止', async () => {
  let calls = 0
  const flaky = (async () => {
    calls++
    if (calls < 3) throw new Error('ECONNRESET')
    return new Response('ok')
  }) as typeof globalThis.fetch
  const c = new HttpClient({ fetch: flaky, maxRetries: 2, minIntervalMs: 0 })
  await expect(c.request({ url: 'https://x' })).resolves.toEqual({ status: 200, text: 'ok' })
  expect(calls).toBe(3)
})

it('按 charset 解码 GBK，且默认解码时去掉 UTF-8 BOM', async () => {
  const c = new HttpClient({
    fetch: fakeFetch(new Response(gbkHiShen300), new Response(utf8BomA)),
    minIntervalMs: 0,
  })
  expect(await c.request({ url: 'https://x', charset: 'gbk' })).toEqual({
    status: 200,
    text: '沪深300',
  })
  expect((await c.request({ url: 'https://x' })).text).toBe('a') // BOM 已被去掉
})
