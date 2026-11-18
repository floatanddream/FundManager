# 数据源层设计（`packages/datasource`）

> 2026-11-18 · 依据 `docs/CONSTRAINTS.md` §1 / §4 / §5 / §8 / §9.2 与 `docs/research/2026-11-18-datasource-inventory.md`（20 个端点逐条实测）
> 本文件是**设计**；任务拆分见随后的计划。

## 一、这层存在的理由

不是「把数据抓下来」。是**抓下来的同时知道它有多可信、有多旧**。

项目四条红线里有两条直接落在这层：

- **A3 静默使用陈旧/错误数据** —— 旧数字被当成当前值
- **§4 规则 4** —— 失败就标 `stale` 并显示，绝不默默返回旧值

所以这层的核心产出不是 `T`，是 `T + 来源 + 数据时点 + 新鲜度`。

## 二、目标

- 20 个已实测端点全部接入
- 上层按**能力**取数，不感知端点（`取 000001 的净值历史`，而不是 `打 lsjz`）
- 每端点的请求头、编码、**双重校验**（HTTP 码 + 业务码）正确
- 缓存 + 降级：主源失败换备源；仍失败则返回带 `stale` 的旧值，或明确失败——**没有第三种**
- fixture + 契约测试两层（§9.2），fixture 带元信息与重抓脚本
- 换源只改装配点（§1 的 `FundDataSource` 缝）

## 三、非目标

- 不做任何业务计算（`core` 的事）
- 不落库（计划 4）
- 不做估值、归因、预警
- 不追实时：净值是 T-1；行情/K 线端点接进来，但 MVP 不依赖它们

## 四、这层的敌人（反目标）

| | 表现 | 必须怎样 |
|---|---|---|
| A3 | 接口挂了，安静返回上次的值 | 返回必须携带 `stale` + `dataAsOf`；**或**明确抛错 |
| 软失败 | HTTP 200 但 body 是错误页/`ErrCode:-999` | 先校验业务码；**只看状态码一律视为 bug** |
| 解析失败伪装成空 | 解析器返回 `[]` 而实际是结构变了 | 解析失败抛异常（§8.3「参数非法」类），**不得返回空集合** |
| UA 门禁被当成限流 | 对 `ErrCode:61136403`「网络繁忙」做退避重试，永远失败 | 该错误码**不重试**，直接判为配置错误并抛出可自解释的信息 |

## 五、四类实测坑（来自盘点，实现时必须逐条对应）

1. **编码**：`qt.gtimg.cn` 返回 **GBK**；`pingzhongdata` 带 **UTF-8 BOM**；`fqkline` 响应头写 UTF-8 但历史上有 GBK 风险
2. **请求头分端点，必须逐个区分**：`api.fund.eastmoney.com/f10/*` **必需 Referer**（缺失 → 200 + `ErrCode:-999`）；`FundArchivesDatas.aspx` 必需 Referer（缺失 → 反爬 HTML）；`fundmobapi` **不能带桌面 Windows Chrome UA**
3. **软 404**：`fundgz` 失效后返回 200 + 「页面未找到」HTML
4. **变量名不统一**：`pingzhongdata` 是 `var x=…`、`jjcc` 是 `var apidata=`、`gmbd` 是 `var gmbd_apidata=`（**不是** `apidata`）

## 六、架构：三层 + 一道缝

```
capabilities/     ← 上层只用这层。按能力取数，内含主备降级链
endpoints/        ← 每端点一个薄模块：URL 构造 + 解析纯函数
http/             ← 共享内核：请求头、超时、退避、解码、双重校验
CacheStore        ← 接口（§1 的缝）。现在内存实现，计划 4 换 SQLite
```

流向单向：`capabilities → endpoints → http`。**反向依赖一律不允许**（endpoint 不知道 capability 存在）。

**为什么按能力而不按端点组织**（选 C 而非纯 A/B）：净值历史在**三个端点都有**（`pingzhongdata.Data_netWorthTrend`、`api/f10/lsjz`、`fundmobapi/FundMNHisNetList`），天生就是一条降级链。按端点组织就得让上层自己知道主备关系——那正是将来「换源」时要改的地方，与本层存在的意义相反。

### 6.1 `http/` 内核

单一职责：把「一次带业务语义的请求」做对一次，其余端点不必各自操心。

- **请求头注入**：按端点的头需求表注入 `Referer` / `User-Agent`
- **超时**：默认 15s，可配
- **退避**：指数退避；默认请求间隔 **≥300ms**（实测 ≥200ms 已足够，取 300 留余量）
- **不重试的错误**：业务码类错误（`ErrCode` 非 0、`Success:false`）**不重试** —— 重试它们只是在放大同一个错误
- **解码**：按响应头 `charset` 选解码器（显式支持 `gbk`）；strip UTF-8 BOM；解码后才交给解析器
- **双重校验**：HTTP 非 2xx → 抛；HTTP 2xx 但业务码失败 → 抛。**两个检查都要有**

### 6.2 `endpoints/` 适配器

每端点一个模块，导出 **URL 构造函数** + **解析纯函数**：

```ts
// 形如
export function navHistoryUrl(code: string, range: DateRange): string
export function parseNavHistory(raw: string): RawNavRow[]   // 纯函数，吃 fixture 就能测
```

**解析器必须是纯函数，输入原始字符串、输出结构化数据，不做 IO、不读时钟。** 这是 §9.2 两层测试能成立的前提。

### 6.3 `capabilities/` 能力层

上层接口。每个能力：

- 声明**主备端点链**（按盘点里的稳定性排序，静态页优先）
- 声明 **TTL** 与 **`dataAsOf` 怎么算**（来自数据本身，不是抓取时刻）
- 失败时依次降级；全链失败 → 查 `CacheStore`：有旧值则返回并**标 `stale`**，无则抛

返回值统一形状：

```ts
type Fetched<T> = {
  value: T
  source: string         // 哪个端点给的 —— 换源/排障要看
  dataAsOf: string       // 数据本身的时点（净值日/报告期），不是抓取时刻
  capturedAt: string     // 抓取时刻
  stale: boolean         // 来自缓存降级 —— 数据**旧**
  loss: string | null    // 来自更弱的端点时，**失去了什么**；主源为 null
}
```

**`dataAsOf` 与 `capturedAt` 必须分开。** 净值是 T-1，两者常差一天；混用会让「这条数据是今天的吗」无法回答。

### 6.4 两种降级必须分开表达

`stale` 与 `loss` 解决的是两个不同问题，对用户的含义也不同：

- **`stale`（数据旧）** —— 绝对时点问题：「你看到的是 3 天前的」
- **`loss`（口径弱）** —— 覆盖问题：「这是持仓，但只剩前十大」

每个能力在降级链里**声明备源的损失**（见 §七表最后一列）。界面据损失程度决定打扰程度：

| 损失程度 | 例 | 界面处理 |
|---|---|---|
| 数值等价，只少附加字段 | 净值历史丢分红/拆分字段 | 静默降级；`loss` 照带，排障可见 |
| 覆盖明显变小 | 持仓由全量退化为仅前十大；规模丢份额与申赎 | **必须显示**，且标注口径与时点 |

**为什么不一律报警**：净值等价的降级会天天出现，报警就变成噪音——那正是反目标 A2（预警不归因 → 两周内被全部屏蔽）。按损失程度分级，与 §4 规则 4「估算必须带报告期、覆盖比例、算法名」是同一条纪律。

## 七、能力清单与降级链（实现按此表）

| 能力 | 主 | 备 | TTL | 降级后失去了什么 |
|---|---|---|---|---|
| 净值历史 | `f10/lsjz` | `pingzhongdata.Data_netWorthTrend` → `fundmobapi/FundMNHisNetList` | 1 天 | 净值数值等价，但**丢分红/拆分字段** |
| 基金概况（业绩基准、跟踪标的） | `jbgk_{code}.html` | **无备源** —— 移动端 `FundMNBasicInformation`/`FundMNDetailInformation` 实测都不含这两项 | 7 天 | — |
| 持仓（按期） | `FundArchivesDatas?type=jjcc` | `fundmobapi/FundMNInverstPosition` | 1 天 | 由**全量**（半年报/年报）退化为**仅前十大**；换来个股行业与增减持 |
| 行业配置（基金维度） | `f10/HYPZ/` | **无备源** —— 移动端只给个股维度（`INDEXNAME`），口径不同，不可相代 | 7 天 | — |
| 资产配置 | `fundmobapi/FundMNAssetAllocationNew` | `pingzhongdata.Data_assetAllocation` | 7 天 | 等价（实测数值一致） |
| 规模 / 份额时序 | `FundArchivesDatas?type=gmbd` | `pingzhongdata.Data_fluctuationScale` | 7 天 | 备源**只有规模，无份额、无申赎流量** |
| 分红 + 份额折算 | `fhsp_{code}.html`（两张表） | `f10/lsjz` 的 `FHFCZ`/`FHSP` 字段 | 1 天 | JSON 版**缺权益登记日与发放日** |
| 公告列表 | `f10/JJGG` | `f10/FHGG` | 1 天 | 备源**只有分红公告** |
| 财务指标 | `f10/GetArrayCwzb` | — | 30 天 |
| 换手率 | `f10/JJHSL/` | — | 30 天 |
| 基金代码表 | `fundcode_search.js` | — | 7 天 |
| 实时行情 / 日 K 线 | `qt.gtimg.cn` / `fqkline` | — | 不缓存 |
| 个股行业分类 | `push2/stock/get?fields=f127` | — | 30 天 |
| 板块成分 | `push2/clist/get` | — | 1 天 |

## 八、需要显式处理的解析陷阱（实现时逐条对照）

按盘点 §6 的 19 条，其中**必须在代码里留注释说明为什么这么写**的是：

- `jjcc` 一个响应含多个报告期，且**表头列数与数据列不一致**（历史报告「最新价」列是空 `<td>`），按位置取「占净值比例」会错位；半年报/年报块**无视 `topline`**，须按块判断这是全量还是前十大
- `GetArrayCwzb` 是**列式字典**（按索引对齐），长度不一致时以最短为准**并告警**
- `jbgk` 是 `<th>标签</th><td>值</td>` 平铺，同一行可能夹多组，**按 `<th>` 文本定位**，不要按行取
- `lsjz` 的分红/拆分信息藏在**普通净值行的附加字段**里；`FHFCBZ` 的取值语义（`0`=分红、`106`=拆分）**只有 2 个样本，未穷举** → 代码标注「部分验证」，用前扩样本
- 两套行业口径**不可混用**：`HYPZ.HYMC` 是国民经济行业分类（「制造业」），`push2.f127` 是细分行业（「白酒Ⅱ」）

## 九、缓存

```ts
interface CacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>
  set<T>(key: string, entry: CacheEntry<T>): Promise<void>
}
```

**现在：内存实现。** 落 SQLite 表要等计划 4（`node:sqlite` + Drizzle proxy 适配器）。接口现在就定，实现换的时候业务代码零改动 —— 这正是 §1 三条缝之一。

TTL 未过期 → 直接用缓存（不算 `stale`，因为数据本来就该是这个时点）。
TTL 过期但取数失败 → 返回旧值 + `stale: true`。**这是唯一允许用旧值的路径。**

## 十、测试（§9.2 两层）

**单元测试（不打网络，每次跑）**：解析器吃 fixture。fixture 存**原始响应字节，不清洗**（清洗后无法验证解析器，且编码陷阱只有原始字节才暴露）。每个 fixture 带 `manifest.json` 元信息：`sourceUrl` / `capturedAt`（抓取时刻，带时区）/ `dataAsOf`（数据时点）/ `requestHeaders` / `sha256` / `bytes`。

**契约测试（打真网络，允许因接口变动而红）**：按 manifest 的 `sourceUrl` + `requestHeaders` 重抓，比对 `sha256` 与结构是否仍在。接口挂了要被它**发现**，但不能把日常测试搞红。

**重抓脚本** `scripts/refresh-fixtures.ts`，走本层的真实代码路径。

**不固化 fixture 的端点**：`fundcode_search.js`（3.2 MB，解析极简）、公告、`push2` 系列、实时行情（仅存 1 个小样本做字段位回归）。

## 十一、这是谁的决定

| 决定 | 谁定的 | 理由 |
|---|---|---|
| 全做 20 个端点 | 使用者 | 研究已完成，边际成本低 |
| 按能力组织（方案 C）而非纯按端点 | 使用者采纳推荐 | 净值历史等天然多源，换源只改装配点 |
| 分红/份额折算纳入本层 | 控制方 | 「全做」的自然含义；但只有取数，**是否自动入账留给计划 4** |
| 缓存先内存实现 | 控制方 | SQLite 属计划 4；§1 的缝本来就允许换实现 |
| 分红/折算字段标「部分验证」 | 控制方 | `FHFCBZ` 语义仅 2 个样本 |
| `dataAsOf` 与 `capturedAt` 分离 | 控制方 | 净值 T-1，混用就无法回答「是不是今天的」 |

## 十二、留给实现者的

- 各解析器的具体容错策略（哪里抛、哪里跳过并告警）
- fixture 抓取的样本选取（覆盖有分红 / 有拆分 / 联接 / 主动 / 指数各一）
- `CacheStore` 的 key 设计
- 契约测试的漂移判定阈值（结构变了 vs 只是数据更新）
- 是否需要把盘点文档中的端点清单搬进代码内的注册表

## 十三、builder check 后补定的接口细节

（一个未参与讨论的构建者读了本文后提出 8 个会卡住的问题；以下为控制方裁定，其中两条是本文原有的**事实错误**，已就地修正见 §七的表）

**`FundDataSource` 落地（§1 的缝）**：定义为一个 interface，每个能力一个方法，返回 `Fetched<T>`。默认实现由 endpoints 组合而成。「换源只改装配点」= 换掉这个 interface 的实现，装配点在 `apps/server` 一处。上层依赖 interface，不依赖具体端点。

**HTTP 内核的边界**：内核负责**原始字节到 `unknown`**——注入请求头、超时、退避、按 `charset` 解码、JSON 解析。**业务码校验（`ErrCode` / `Success`）归各端点的解析器**，因为只有它知道该看哪个字段。内核只保证「HTTP 2xx 且拿到了可解码的 body」。这与「解析交给 parser」不再矛盾。

**内核形态（需微调 §8.5）**：内核有状态（请求间隔、退避计数），故用 class，位于 `packages/datasource`。`CONSTRAINTS.md` §8.5 原文说 class「仅出现在 `apps/server` 层」，而它自己举的例子恰恰是「HTTP 客户端」——该条改为「**仅出现在有 IO 的层**（`datasource` / `apps/server`）；`core` 与解析逻辑一律纯函数」。

**请求头来源**：每 endpoint 模块自带 `headers` 声明，不建中心注册表。

**分页**：**capability 层负责翻页**；endpoint 导出「带页码的 URL 构造 + 单页解析」。解析是纯函数这条前提不受影响。

**endpoint 粒度**：**每端点一个模块，导出全量解析**（如 `parsePingzhongdata(raw)` 一次返回所有变量）；capability 在解析结果上做切片。好处是同一份响应只解析一次，且保住「endpoint 不知道 capability 存在」。

**Zod 归属**：**外部响应形状的 schema 属 `packages/datasource`**（是数据源实现细节，不是共享契约）；**领域类型属 `packages/shared`**（`NavConfirmed` 等已在那里）。解析器出口 = Zod 校验后的类型。

**`Fetched<T>` 增加 `capturedAt`**：§6.3 强调要与 `dataAsOf` 分开，类型里必须两个都有。
各能力 `dataAsOf` 取值规则：净值为最新净值日；持仓/行业/资产/规模为报告期；分红折算为最近事件日；**无天然时点的**（代码表、个股行业分类）取 `capturedAt` 的日期并在文档注明。

**fixture 元信息**：**每个 fixture 目录一份 `manifest.json`**（不是每文件一份，也不是全仓库集中一份）——重抓脚本按目录遍历，元信息与文件同生共死。

**契约测试与日常测试分离**：命名 `*.contract.test.ts`，放 `packages/datasource/test/contract/`；根 `vitest.config.ts` 的 `include` 排除该目录（现为 `packages/*/src/**/*.test.ts`，会把它一起捞进来）；新增 `pnpm test:contract` 单独跑。同时把 `packages/datasource` 接入根 `typecheck` 脚本（现只覆盖 `shared` 与 `core`）。
