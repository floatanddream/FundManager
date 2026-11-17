# AGENTS.md

## 这个项目是什么

**开源的**中国场外公募基金**持仓穿透与风险分析**工具。做穿透、组合级风险、归因式预警、决策辅助。

**不是**记账工具的替代品。

### 部署形态：各自部署（self-host）

使用者各自 fork、各自在本机跑一份，**数据各自留在本地**。没有中心服务器，不提供多用户共用的托管实例。

因此：

- **代码里不得硬编码本机信息**（路径、特定持有人的数据）
- **配置要可配**，不能写死作者偏好
- **首次运行要能跑通**——别人 clone 下来得能装能跑
- **错误信息要能自解释**——作者调试过的坑，使用者没有那段经验

### 开源带来的红线

仓库公开，**个人持仓、成本价、账户信息绝不可提交**。`.gitignore` 已屏蔽 `data/`、`*.db`、`.env`。

文档与示例中**只能用公开基金代码**（如 `011609`），不得出现真实持仓组合。

---

## 先读这个

**`docs/CONSTRAINTS.md` 是权威约束文件。动手前必读。** 本文件只讲怎么在这个仓库里干活，约束以那份为准。

---

## 最容易犯的四个错

若你要改代码，先确认不违反这四条。它们是这个项目里唯一真正重要的东西。

**1. 不要把估值当净值用。**
三种价格在类型上隔离（`NavConfirmed` / `NavEstimate` / `MarketPrice`），收益与风险计算**只接受 `NavConfirmed`**。盘中估值是估算，误差可超 1%。

**2. 不要在 Service 里写算式。**
所有计算调用 `packages/core`。Service 只搬运数据。`core` 必须保持纯函数、无 IO、不 import 任何框架——**这是整个系统可测试的前提**。

**3. 不要给主动基金估值。**
只有指数基金/ETF 联接能算盘中估值。主动基金季报持仓最长滞后 4.5 个月。绕过这条 = 给用户一个假数字。

**4. 不要静默使用陈旧数据。**
数据源会挂（已有实例：天天基金的盘中估值接口 404）。失败就标记 `stale` 并显示出来，绝不默默返回旧值。

---

## 目录结构（目标形态）

```
FundManager/
├── apps/
│   ├── server/           Fastify + Service/Repository + 定时任务 CLI
│   └── web/              React + Vite + shadcn/ui + ECharts
├── packages/
│   ├── core/             纯计算引擎（无 IO，不 import 框架）
│   ├── datasource/       外部数据源适配 + 缓存 + 降级
│   └── shared/           Zod 契约 + 共享类型
└── docs/
    └── CONSTRAINTS.md    权威约束
```

分层流向：`Route → Service → { Repository | DataSource | core }`

**Repository（本地 SQLite）与 DataSource（外部接口）不合并** —— 失败模式不同。

---

## 当前状态

**没有任何业务代码。** 目前只有：

```
README.md              项目说明 + 免责声明
LICENSE                MIT
.gitignore             已屏蔽个人数据
AGENTS.md              本文件
docs/CONSTRAINTS.md    权威约束
package.json           空脚手架
pnpm-workspace.yaml    空脚手架
```

未安装依赖、**尚未 `git init`**（使用者明确要求暂不初始化，不要擅自执行）。

新增文件前先确认目录约定（见上），不要凭空造结构。

---

## 环境与命令

环境：Windows 11 · Node v24.21.0 · pnpm 12.21.0 · git 2.56.0

| 用途 | 命令 | 状态 |
|---|---|---|
| 装依赖 | `pnpm install` | 尚未执行 |
| 跑 TS | `node path/to/file.ts` | ✅ 已验证可用，**不需要 tsx** |
| 测试 | `pnpm vitest` | 待建 |
| 开发 | 待定 | 待建 |

### Windows / Git Bash 注意

- Git Bash 的 `/tmp` 映射到 `C:\Users\<user>\AppData\Local\Temp`。**Windows 原生程序（如 Python）不认识 `/tmp`**，需用 `cygpath -w /tmp` 转换
- Python 可用绝对路径调用；跑读取外部下载文件时用 `python -I`

---

## 编码约定

- **数据挂在「账本」下，不是挂在「用户」下**。现在只有 1 个账本，将来可以是 N 个。这是唯一一个「后补很痛」的设计决定——往所有表加字段并回填数据，比一开始设计好贵得多。其余都能后补
- **相对导入必须带 `.ts` 后缀**（`import { x } from './price.ts'`）。**不能用 `.js`** —— 实测 Node 报 `ERR_MODULE_NOT_FOUND`。这与 TypeScript 官方推荐相反，但本项目由 Node 直接执行、无构建步骤，只能如此
- **TypeScript strict**，ESM（根 `package.json` 已是 `"type": "module"`）
- **不要用装饰器** —— Node 原生跑 `.ts` 会 `SyntaxError`（已实测）
- **`packages/core` 的每个函数都要有测试**，用手算案例验证。算错了亏的是真钱
- 抓取层统一走 `packages/datasource` 的接口，不要在业务代码里直接 `fetch` 外部 URL
- 外部接口返回的 JS 文件（`pingzhongdata/*.js`）用 `node:vm` 沙箱或正则解析，**不要 `eval`**

---

## 数据源要点

致富的坑都在这。细节见 `docs/CONSTRAINTS.md` §5。

- 腾讯的行情接口返回 **GBK 编码**，需转码
- 名称含「联接」的基金买的是 ETF，**必须穿透**，其「股票仓位」字段是障眼法（实测 0.41%）
- 有效暴露取自**业绩比较基准**，不是股票仓位字段
- 持仓只能拿到**前 20 大**，不是全部 —— 相关指标都是估计值，界面须标注口径
- 分红/份额折算**没有自动数据源**，只能手工录入 + 提示用户确认

---

## 关于用户提问的边界

- **不下单**：不碰交易接口、不存平台凭证、不模拟客户端操作。用户手工操作后回记
- **不预测涨跌**：只能描述当前风险、给概率区间、做历史情景压力测试
- 用户是中文使用者，**界面与文档用中文**
