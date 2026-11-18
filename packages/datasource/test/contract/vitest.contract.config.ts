/**
 * 契约测试配置（`CONSTRAINTS/09-process.md` §9.2 的第二层）。
 *
 * **打真网络**，断言端点仍可达、结构仍能解析、关键字段仍在；**允许因接口变动而红**——
 * 接口挂了要被它发现，但绝不能把日常测试搞红。故它与根 `vitest.config.ts` 的
 * `include`（只覆盖各包 `src` 目录下的单测，不含本目录）刻意不重叠：`pnpm test` 一次也捞不到它。
 *
 * `root` 显式指到仓库根：本配置文件在 `packages/datasource/test/contract/` 下，
 * 不显式指定的话 `include` 的相对基准会落到配置目录，glob 就匹配不到了。
 */
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  test: {
    include: ['packages/datasource/test/contract/**/*.contract.test.ts'],
    environment: 'node',
    // 真网络 + 内核的退避重试（默认最多 3 次），给足超时；失败要看得见，不因超时静默通过
    testTimeout: 30000,
  },
})
