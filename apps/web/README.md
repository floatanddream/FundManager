# FundManager 前端

在仓库根目录安装依赖后，用一条命令同时启动前后端。

```sh
pnpm dev
```

访问 <http://localhost:3001>。前端默认请求 `http://localhost:3000/api`。如果修改了后端端口，在前端启动或构建时设置 `VITE_API_URL` 为 API 的来源地址，不含 `/api`。跨域部署时，把后端的 `CORS_ORIGIN` 设为前端页面的来源。通过同源反向代理转发 `/api` 时，把 `VITE_API_URL` 设为显式空值后构建。

首次打开可创建本地账本。通过基金查询进入详情，再录入第一笔流水。持仓页可查看净值、收益与风险指标，并核对平台份额。

工作台使用 shadcn/ui 的 Base Nova 默认组件样式与中性主题，支持亮色和暗色。组件源码位于 `src/components/ui/`，页面样式负责双栏布局和数据排版。

运行 `pnpm --filter web build` 构建静态文件，输出位于 `apps/web/dist`。
