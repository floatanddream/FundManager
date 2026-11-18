# 二、分层规矩

```
Route (Fastify)    只做 HTTP：校验入参、调 Service、返回
   ↓
Service            编排：取数 → 算 → 存 → 通知。不含算式
   ↓
   ├── Repository   本地 SQLite 持久化（可靠，不会挂）
   ├── DataSource   外部数据获取（会挂，需重试/缓存/降级）
   └── core         纯计算，无 IO
```

**规矩 1：Service 不算数，core 才算数。**
Service 只搬运数据。任何计算都调用 `core`。理由：`core` 是纯函数，测试不需要 mock 数据库和网络——而算错了亏的是钱。

**规矩 2：Repository 与 DataSource 不合并。**
两者失败模式不同：本地库可靠，外部接口会挂。混在一起，缓存与降级语义无法表达。

**规矩 3：`packages/core` 不 import 任何框架、不 import 任何 IO。**
它是纯函数库。这条保证了后端框架选择可逆（换框架只改壳）。

---
