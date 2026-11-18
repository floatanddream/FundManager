/**
 * fixture 重抓脚本（计划 Task 10）。
 *
 * 按各 `test/fixtures/<端点>/manifest.json` 里每个文件的 `sourceUrl` + `requestHeaders`
 * 重新拉取真实响应，写回 fixture 文件，并更新该文件的 `capturedAt` / `bytes` / `sha256`。
 *
 * **走本层的真实代码路径**（`HttpClient`：请求头注入、限流、超时、退避、按 charset 解码），
 * 不另写一套 HTTP——否则重抓脚本与真实链路会漂移，抓回来的样本就不再代表真实行为。
 *
 * 放 `src/` 下**是有意为之**：`packages/datasource/tsconfig.json` 只 include `src`，
 * 放这里才被 `typecheck` 覆盖。它是一次性运维脚本，**不从 `index.ts` 导出**。
 *
 * 用法：
 *   node packages/datasource/src/refresh-fixtures.ts                    # 重抓全部端点
 *   node packages/datasource/src/refresh-fixtures.ts pingzhongdata qt   # 只重抓指定端点目录
 *
 * 两条**不覆盖**的规则（防止重抓把有价值的样本毁掉）：
 * 1. `notes` 含「截断样本」的文件不重抓——如 `fundcode_search` 只存了首尾若干条，
 *    重抓会写入 3.2 MB 全量，覆盖掉刻意的截断样本。
 * 2. `encoding` 是本机 Node 无法编码的字符集（如 `gbk`）的文件只告警跳过——
 *    本机 Node 没有 GBK 编码器，硬按 UTF-8 写回会把内容写坏。
 *
 * **`dataAsOf` 不由本脚本更新**：数据时点（净值日 / 报告期）要从响应内容里按端点各自
 * 的规则算，通用脚本算不出；更新它需要端点级知识，超出本脚本职责。重抓后请自行核对。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { HttpClient } from './http/client.ts'

const FIXTURES_DIR = fileURLToPath(new URL('../test/fixtures/', import.meta.url))

/** `notes` 里出现该字样即视为截断样本：重抓会覆盖它，故跳过。 */
const TRUNCATED_MARKER = '截断样本'

type FixtureFile = {
  file: string
  sourceUrl: string
  requestHeaders?: Record<string, string>
  encoding?: string
  notes?: string
  capturedAt?: string
  bytes?: number
  sha256?: string
  [key: string]: unknown
}

type Manifest = { endpoint: string; files: FixtureFile[] }

/**
 * fixture 声明的 `encoding` → `HttpClient` 的 `charset`。
 * `utf-8-bom` 也按 `utf-8` 解——`decodeBody` 会按字节剥掉 BOM。
 */
function charsetOf(encoding: string | undefined): string | undefined {
  return encoding === 'gbk' ? 'gbk' : undefined
}

/** 把解码后的文本按 fixture 声明的编码写回字节；本机 Node 无此编码器时返回 `null`（调用方跳过）。 */
function encodeFixture(text: string, encoding: string | undefined): Buffer | null {
  if (encoding === undefined || encoding === 'utf-8') return Buffer.from(text, 'utf8')
  if (encoding === 'utf-8-bom') {
    // decodeBody 解码时剥掉了 BOM，这里按原编码把它加回去
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
  }
  return null
}

/** 带时区（`+08:00`，与既有 manifest 一致）的抓取时刻。中国自 1991 年起无夏令时，+08:00 恒定。 */
function nowIso(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex')

type Outcome = 'written' | 'skipped' | 'failed'

async function refreshFile(http: HttpClient, dir: string, entry: FixtureFile): Promise<Outcome> {
  if (entry.notes?.includes(TRUNCATED_MARKER)) {
    console.log(`  [跳过] 截断样本，不覆盖：${entry.file}`)
    return 'skipped'
  }
  let text: string
  try {
    const res = await http.request({
      url: entry.sourceUrl,
      headers: entry.requestHeaders,
      charset: charsetOf(entry.encoding),
    })
    text = res.text
  } catch (err) {
    console.error(`  [失败] 未写回：${entry.file} —— ${(err as Error).message}`)
    return 'failed'
  }
  const buffer = encodeFixture(text, entry.encoding)
  if (buffer === null) {
    console.warn(`  [跳过] 本机 Node 无法以 ${entry.encoding} 编码写回：${entry.file}`)
    return 'skipped'
  }
  writeFileSync(join(FIXTURES_DIR, dir, entry.file), buffer)
  entry.capturedAt = nowIso()
  entry.bytes = buffer.length
  entry.sha256 = sha256(buffer)
  console.log(`  [更新] ${entry.file}（${buffer.length} 字节）`)
  return 'written'
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  const dirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => only.length === 0 || only.includes(name))

  if (dirs.length === 0) {
    console.error(`没有匹配的 fixture 目录：${only.join(', ') || '(全部)'}`)
    process.exitCode = 1
    return
  }

  const http = new HttpClient({ fetch: globalThis.fetch })
  const tally = { written: 0, skipped: 0, failed: 0 }
  for (const dir of dirs) {
    const manifestPath = join(FIXTURES_DIR, dir, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    console.log(`${dir}（${manifest.endpoint}）`)
    for (const entry of manifest.files) {
      tally[await refreshFile(http, dir, entry)]++
    }
    // 无论是否有文件更新都重写 manifest：capturedAt 已就地改了，且保持 JSON 格式稳定
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  console.log(`\n完成：更新 ${tally.written}，跳过 ${tally.skipped}，失败 ${tally.failed}`)
  if (tally.failed > 0) process.exitCode = 1
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  await main()
}
