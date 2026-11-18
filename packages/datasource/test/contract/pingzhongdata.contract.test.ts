import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { parsePingzhongdata } from '../../src/endpoints/pingzhongdata.ts'
import { HttpClient } from '../../src/http/client.ts'
import type { HttpRequestSpec } from '../../src/http/client.ts'

/**
 * 契约测试：`pingzhongdata` 端点（净值历史的主备来源之一）。打真网络，允许因接口变动而红。
 *
 * 请求参数与请求头**一律从 fixture 的 `manifest.json` 取**，不在这里另拼——不同端点的头需求
 * 不同（`api.fund/f10/*` 必需 Referer、`fundmobapi` 必需带 `Mobile` 的 UA），自己拼迟早拼错，
 * 而错的头会得到 HTTP 200 的错误页（软失败），比连不上更难查。
 *
 * **为什么不测 `push2`**：`push2.eastmoney.com` 在本机被网络拦截（DNS 返回 `127.255.0.1`，
 * curl / node 全连不上），它的契约测试在这台机器上**必定失败，且原因是网络而非接口变动**。
 * 加进来会变成一个「永远是红的」测试，久了没人看（§9.2）。要补它在能直连的环境加，并依赖
 * 下面 `fetchReal` 的失败分类区分「网络不通」与「接口变了」。
 */

type ManifestEntry = {
  file: string
  sourceUrl: string
  fundCode?: string
  requestHeaders?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../fixtures/pingzhongdata/manifest.json', import.meta.url), 'utf8'),
) as { files: ManifestEntry[] }

const entry = manifest.files[0]!
const http = new HttpClient({ fetch: globalThis.fetch })

/**
 * 打真网络。失败分成两类，一眼能分清是「本机网络不通」还是「接口结构变了」：
 * - 网络层失败（连不上 / 超时 / 非 2xx）→ 在此抛出，信息点明是网络问题
 * - 结构层失败（解析器抛 `ParseError`）→ 由下面的解析断言抛出，信息点明「结构可能已变」
 */
async function fetchReal(spec: HttpRequestSpec): Promise<string> {
  try {
    return (await http.request(spec)).text
  } catch (cause) {
    throw new Error(
      `网络层失败（不是接口变动）：${spec.url}\n${(cause as Error).message}\n` +
        `若本机对该 host 有网络拦截（如 push2 实测 DNS 返回 127.255.0.1），请换能直连的环境再跑。`,
      { cause },
    )
  }
}

it('pingzhongdata：端点仍可达、结构仍能解析、关键字段仍在', async () => {
  const text = await fetchReal({ url: entry.sourceUrl, headers: entry.requestHeaders })
  const data = parsePingzhongdata(text)

  expect(data.fundCode).toBe(entry.fundCode)
  expect(data.fundName.length).toBeGreaterThan(0)
  // 净值历史仍在：至少一条，且最新一条的净值与日期形状合理
  expect(data.navTrend.length).toBeGreaterThan(0)
  const latest = data.navTrend.at(-1)!
  expect(latest.nav).toBeGreaterThan(0)
  expect(latest.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  // 其余关键变量仍在（规模 / 经理）——任一名改了，解析器会抛 ParseError，此处也会红
  expect(data.scaleHistory.length).toBeGreaterThan(0)
  expect(data.managers.length).toBeGreaterThan(0)
})
