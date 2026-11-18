# 一、技术栈（已确认，不可擅自更改）

```
monorepo      pnpm workspace（apps/*, packages/*）
语言          TypeScript（strict）
运行时        Node 24 —— 原生执行 .ts、原生 fetch、原生 node:sqlite
后端          Fastify + Service / Repository 分层
数据库        node:sqlite（Node 内置）+ Drizzle ORM
校验          Zod（共享契约放 packages/shared）
前端          React 19 + Vite + shadcn/ui + Tailwind
图表          ECharts（手写 React wrapper）
数据请求      TanStack Query
测试          Vitest
定时任务      CLI + Windows 计划任务（非常驻进程）
通知          node-notifier（桌面通知）
缓存          SQLite 表
```

### 已实测的硬事实（2026-11-17，本机 Node v24.21.0）

| 事实 | 影响 |
|---|---|
| Node 原生执行 `.ts` ✅ | 不需要 tsx |
| Node **执行不了装饰器** ❌ `SyntaxError` | **不用 NestJS**（它全靠装饰器）|
| `node:sqlite` 可用 ✅ | **不用 `better-sqlite3`**（原生模块，Windows 需编译，Node 24 可能无预编译包）|
| Node 自带 `fetch` ✅ | 不需要 axios |
| `registry.npmjs.org` 可达 ✅ | 可正常装包 |
| **相对导入必须带 `.ts` 后缀** | 用 `.js` 后缀指向 `.ts` 文件会 `ERR_MODULE_NOT_FOUND`（实测）。与 TypeScript 官方推荐的 `.js` 约定**相反**，因为本项目无构建步骤、由 Node 直接执行 |
| **Drizzle 不支持 `node:sqlite`** | 需用 `drizzle-orm/sqlite-proxy` 自建约 15 行适配器（已实测跑通）|

### 明确不用

| 不用 | 理由 |
|---|---|
| Redis | 部署形态是**各自部署**（见 §7），每个实例仍是单进程单用户，跨进程缓存/会话/分布式限流/任务队列一个都不存在。Windows 无官方版，需 WSL/Docker。**接口留着（`CacheStore`），实现不写** |
| NestJS | 复杂度在 `core` 与 `datasource`，`apps/server` 很薄，框架的结构价值无处施展。且需额外构建步骤 |
| Prisma | 需 codegen + 引擎二进制，过重 |
| Turborepo | 项目规模用不上 |
| Redux | 读数据看板，TanStack Query 足够 |
| `better-sqlite3` / `tsx` / `axios` | 见上表，Node 24 已内置替代 |

### 预留的扩展缝（三条，均为「一个接口 + 一处装配」）

| 会变的 | 接口 | 现在 | 将来 |
|---|---|---|---|
| 缓存 | `CacheStore` | SQLite 表 | Redis |
| 数据库 | Drizzle | node:sqlite | Postgres |
| 数据源 | `FundDataSource` | 天天基金 / 腾讯 | 换源 |

换实现时**业务代码零改动**。装配点全局只有一处。

---
