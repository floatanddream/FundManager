# 五、数据源现状（实测，2026-11-17 / 11-18）

### 可用

| 用途 | 端点 |
|---|---|
| 净值历史/费率/经理/规模/同类排名/资产配置 | `fund.eastmoney.com/pingzhongdata/{code}.js` |
| 全量基金代码表（28,356 只） | `fund.eastmoney.com/js/fundcode_search.js` |
| **跟踪标的 + 业绩比较基准（含权重）** | `fundf10.eastmoney.com/jbgk_{code}.html` |
| **持仓（按期）** | `FundArchivesDatas.aspx?type=jjcc&code={code}&topline=N&year=Y&month=M` |
| **持仓（JSON，额外带行业与增减持）** | `fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE={code}` |
| **分红 + 份额折算（服务端渲染）** | `fundf10.eastmoney.com/fhsp_{code}.html`（两张表：分红 `table.cfxq`、拆分 `table.fhxq`） |
| **分红 / 拆分（JSON）** | `api.fund.eastmoney.com/f10/lsjz`（分红、拆分日的行带 `FHFCZ`/`FHFCBZ`/`FHSP` 字段） |
| **行业配置（基金维度，按报告期）** | `api.fund.eastmoney.com/f10/HYPZ/?fundCode={code}&year={year}` |
| **规模 / 份额时序** | `FundArchivesDatas.aspx?type=gmbd&code={code}` |
| 基金公告 / 分红公告 | `api.fund.eastmoney.com/f10/JJGG`、`/f10/FHGG` |
| 财务指标 | `api.fund.eastmoney.com/f10/GetArrayCwzb` |
| **个股行业分类** | `push2.eastmoney.com/api/qt/stock/get?secid={m}.{code}&fields=f127` |
| 板块/指数成分股 | `push2.eastmoney.com/api/qt/clist/get?fs=b:{板块}` |
| 实时指数 / 场内 ETF / 个股 | `qt.gtimg.cn/q=sh000300`（**GBK 编码**） |
| 日 K 线 | `web.ifzq.gtimg.cn/appstock/app/fqkline/get` |

### 抓取注意（2026-11-18 实测）

- **`api.fund.eastmoney.com/f10/*` 需要带 `Referer`**。缺失时返回 **HTTP 200 但 `ErrCode:-999`** ——只看状态码会误判成功
- **`fundmobapi.eastmoney.com` 有 UA 门禁**：典型桌面 Chrome 的 UA **被拒**，`ErrCode: 61136403`，而 `ErrMsg` 是**误导性的「网络繁忙」**（不是限流）。带 `Mobile` 的 UA 稳定通过
- 限流观察：各端点以 200–250ms 间隔连打 15–20 次**均无异常**

### 持仓披露频率（2026-11-18 实测，重要）

**半年报与年报披露全部持仓，一季报与三季报只有前十大。** 实测 `000001`：

| 报告期 | 股票数 | 占净值 | 性质 |
|---|---|---|---|
| 2026年1季度 | 10 | 27.15% | 只有前十大 |
| **2026年2季度（半年报）** | **77** | **79.96%** | **全量** |
| 2026年3季度 | 10 | 39.93% | 只有前十大 |
| **2025年4季度（年报）** | **132** | **79.41%** | **全量** |

因此：

- 想要**完整持仓名单**，看半年报/年报——但可能已滞后 4.5～11 个月
- 想要**最新权重**，看季报前十大——但只覆盖约 40%
- **两者拼接**是目前最优：新前十权重 + 旧全量尾部（见 §4 规则 4）

**移动端接口的两项额外信息**（网页接口没有）：

```
中际旭创  5.26%  通信   减持-1.19
新易盛    3.60%  通信   新增3.6       ← 增减持方向，能看出经理在往哪走
```

字段：`GPDM` 代码 / `GPJC` 名称 / `JZBL` 占净值比例 / `INDEXNAME` 行业 / `PCTNVCHGTYPE`+`PCTNVCHG` 增减持。
**这同时解决了此前用 `type=hytz` 取不到行业分类的问题。**

### 不可用

> **2026-11-18 修正。** 原表有三处错误，均由实测推翻，逐条列出以免再犯。

| 用途 | 端点 | 状态 |
|---|---|---|
| 盘中估值 | `fundgz.1234567.com.cn/js/{code}.js` | ❌ **软 404**：HTTP **200** + 「页面未找到」HTML。**不是 404！只看状态码会误判成功** |
| 分红/拆分（部分） | `api.fund.eastmoney.com/f10/JJFH`、`JJCF` | ❌ HTTP 200 + `ErrCode:4` |
| `type=fhsp` / `type=hytz` / `type=jjgg` | `FundArchivesDatas.aspx` | ❌ 返回空（HTTP 200 + `var apidata=`，仅 12 字节） |
| 基金评级 / GPTop10 | `api.fund.eastmoney.com/F10/JJPJ/`、`f10/FundGPTop10/` | ❌ 结构化 404 |

**⚠️ 原文档此处曾写「`api.fund.eastmoney.com/f10/*` **整族失效**」——不成立。**
该族中 `lsjz`/`HYPZ`/`FHGG`/`JJGG`/`GetArrayCwzb`/`JJHSL` **均可用**（需 Referer，见上），
失效的只有 `JJFH` 与 `JJCF` 两个。**按「整族失效」设计会白白放弃一批可用数据源。**

**⚠️ 原文档曾写「分红/份额折算无自动来源」「行业配置无来源」——两条均已推翻。**
替代端点见上表「可用」区（`fhsp_{code}.html`、`lsjz`、`HYPZ`）。

### 必须记住的口径限制

- **最新持仓只有前十大**（季报），**完整持仓只在半年报与年报**。两者都已滞后：季报约 1.5～4.5 个月，半年报/年报约 4.5～11 个月。因此重叠度、行业暴露、估值全部建立在**不完整且陈旧**的数据上——界面必须**同时**标注口径与数据时点，缺一即误导
- **场外基金没有实时净值**。净值由基金公司收盘后计算公布（约 19:00–23:00）。「此刻净值」不存在
- **联接基金要穿透**（名称含「联接」的，买的是对应 ETF）
- **分红/份额折算已有自动来源**（`fhsp_{code}.html`、`lsjz`），但**仍须用户确认后才入账**。现金分红与红利再投是两种不同事件（前者份额不变、现金离开；后者份额增加），自动判错会让账**静默出错**。**能取到数据 ≠ 能自动记账**
- **份额折算必须支持**：实测 `510300` 历史含「拆分：每份基金份额折算」，用户无操作份额也会变

### 解析注意

`pingzhongdata/{code}.js` 是 JS 赋值语句，不是 JSON。用 `node:vm` 沙箱或正则提取，**不要 `eval`**。

---
