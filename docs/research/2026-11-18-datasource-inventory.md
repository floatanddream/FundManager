# 数据源端点清单（逐条实测）

> **本文所有端点均为本机实测**，除非行内明确标注「未实测 / 推测」。
>
> | 项 | 值 |
> |---|---|
> | 实测日期 | 2026-11-18 |
> | 实测环境 | Windows 11 · Node v24.21.0 · curl 8.22.0 (mingw) |
> | 样本基金 | `000001` 华夏成长混合（主动混合）、`510300` 沪深300ETF（场内，含份额折算）、`011609`（联接）、`161725`（LOF） |
> | 方法 | `curl` 逐条请求，响应落盘到 `%TEMP%\fundresearch\`，再离线检查字节数 / 内容 / 编码 |
>
> **与 `docs/CONSTRAINTS/05-data-sources.md` §5 的关系**：本文**不推翻**该节结论，而是补全、细化、并对两处做了**修正**（见下）。凡与 §5 冲突处，以本文实测为准，需回写 §5。
>
> **两处修正（重要）**：
> 1. `fundgz.1234567.com.cn/js/{code}.js` 不是硬 `404`，而是**软 404**——HTTP 返回 **200**，body 是「页面未找到」HTML 错误页。只查状态码的客户端会误判成功。§5 写的「404」需改为「200 + 错误页」。
> 2. §5 说 `api.fund.eastmoney.com/f10/*` 「整族失效」——**不成立**。实测该 host 下 `lsjz` / `HYPZ` / `FHGG` / `JJGG` / `GetArrayCwzb` / `JJHSL` 六个端点**全部可用**（均需 Referer）。失效的只是 `JJFH` / `JJCF` 两个具体路径。

---

## 0. 总览

| # | 用途 | Host | 状态 | 需 Referer | 需移动 UA | 编码 |
|---|---|---|---|---|---|---|
| 1 | 净值历史/费率/经理/规模/排名/资产配置/股票仓位 | fund.eastmoney.com | ✅ | ✗ | ✗ | UTF-8 |
| 2 | 全量基金代码表（28,356 只） | fund.eastmoney.com | ✅ | ✗ | ✗ | UTF-8 |
| 3 | 基金概况（含跟踪标的/业绩比较基准） | fundf10.eastmoney.com | ✅ | ✗ | ✗ | UTF-8 |
| 4 | 持仓（网页，按期，HTML） | fundf10.eastmoney.com | ✅ | **✓** | ✗ | UTF-8 |
| 5 | 规模/份额时序（HTML） | fundf10.eastmoney.com | ✅ **新** | **✓** | ✗ | UTF-8 |
| 6 | **分红 + 拆分折算（HTML，服务端渲染）** | fundf10.eastmoney.com | ✅ **新** | ✗ | ✗ | UTF-8 |
| 7 | 历史净值（JSON，含分红/拆分事件） | api.fund.eastmoney.com | ✅ **新** | **✓** | ✗ | UTF-8 |
| 8 | **行业配置（JSON，按报告期）** | api.fund.eastmoney.com | ✅ **新** | **✓** | ✗ | UTF-8 |
| 9 | 分红公告列表（JSON） | api.fund.eastmoney.com | ✅ **新** | **✓** | ✗ | UTF-8 |
| 10 | 全部公告列表（JSON） | api.fund.eastmoney.com | ✅ **新** | **✓** | ✗ | UTF-8 |
| 11 | 财务指标（JSON） | api.fund.eastmoney.com | ✅ **新** | **✓** | ✗ | UTF-8 |
| 12 | 换手率（JSON） | api.fund.eastmoney.com | ✅ **新** | **✓** | ✗ | UTF-8 |
| 13 | 持仓（JSON，带行业+增减持） | fundmobapi.eastmoney.com | ✅ | ✗ | **✓** | UTF-8 |
| 14 | 资产配置（JSON） | fundmobapi.eastmoney.com | ✅ **新** | ✗ | **✓** | UTF-8 |
| 15 | 历史净值（JSON，移动端） | fundmobapi.eastmoney.com | ✅ **新** | ✗ | **✓** | UTF-8 |
| 16 | 基本信息 / 详情（JSON） | fundmobapi.eastmoney.com | ✅ **新** | ✗ | **✓** | UTF-8 |
| 17 | 实时行情（指数/ETF/个股） | qt.gtimg.cn | ✅ | ✗ | ✗ | **GBK** |
| 18 | 日 K 线 | web.ifzq.gtimg.cn | ✅ | ✗ | ✗ | UTF-8(头) / GBK 风险 |
| 19 | 个股行业分类（f127） | push2.eastmoney.com | ✅ | ✗ | ✗ | UTF-8 |
| 20 | 板块/指数成分股 | push2.eastmoney.com | ✅ | ✗ | ✗ | UTF-8 |
| ✗ | 盘中估值 | fundgz.1234567.com.cn | ❌ **软 404** | — | — | — |

**本表共实测 20 个可用端点；其中 10 个为本次新发现**（§2）。

---

## 1. 端点清单（逐条实测）

### 1.1 `fund.eastmoney.com/pingzhongdata/{code}.js`

| 字段 | 值 |
|---|---|
| 用途 | 净值历史、累计净值、费率、基金经理、规模、同类排名、资产配置、股票仓位测算、持有人结构、收益率区间 |
| 完整 URL | `https://fund.eastmoney.com/pingzhongdata/000001.js` |
| 必需请求头 | **无**（不带 Referer / 不带特殊 UA 均实测 200） |
| 编码 | UTF-8 **带 BOM**（`﻿` 开头）；响应头 `Content-Type: application/javascript` |
| 响应格式 | **JS 赋值语句**（不是 JSON） |
| 实测结果 | HTTP **200**，**766,796** 字节。`Last-Modified: Wed, 18 Nov 2026 02:36:07 GMT`，body 内含 `/*2026-11-18 10:36:07*/` 时间戳 |
| 时效性 | **天级**（净值 T-1 更新；body 内时间戳每次拉取前重算） |

**实测包含的变量**（`grep -oE 'var [A-Za-z_]\w*'` 全量）：

```
fS_name fS_code fund_sourceRate fund_Rate fund_minsg
stockCodes stockCodesNew zqCodes zqCodesNew swithSameType
syl_1n syl_6y syl_3y syl_1y          ← 近1年/6月/3月/1月 收益率
Data_netWorthTrend                   ← 单位净值走势 [{x:ts, y:nav, equityReturn, unitMoney}]
Data_ACWorthTrend                    ← 累计净值走势 [[ts, value], ...]
Data_grandTotal                      ← 累计收益率 vs 同类/沪深300
Data_currentFundManager              ← 现任经理（含照片、任职天数、评分、管理规模）
Data_assetAllocation                 ← 资产配置（股票/债券/现金占净比 + 净资产）
Data_fundSharesPositions             ← 股票仓位测算图
Data_holderStructure                 ← 机构/个人/内部持有比例
Data_fluctuationScale                ← 规模变动（季度净资产 + 环比 mom）
Data_buySedemption                   ← 申购赎回走势
Data_performanceEvaluation           ← 业绩评价（五维雷达）
Data_rateInSimilarType               ← 同类排名（百分位）
Data_rateInSimilarPersent
ishb
```

样本（实测 `000001`）：
- `Data_assetAllocation.series[0]` 股票占净比 `[79.42,72.51,79.98,78.21]`
- `Data_netWorthTrend[0]` = `{"x":1008604800000,"y":1.0,"equityReturn":0,"unitMoney":""}`（`x` 为 **epoch 毫秒**）
- `Data_holderStructure` 类别 `["2024-12-31","2025-06-30","2025-12-31","2026-06-30"]`

---

### 1.2 `fund.eastmoney.com/js/fundcode_search.js`

| 字段 | 值 |
|---|---|
| 用途 | 全量基金代码、名称、拼音缩写、类型 |
| 完整 URL | `https://fund.eastmoney.com/js/fundcode_search.js` |
| 必需请求头 | **无** |
| 编码 | UTF-8 带 BOM；`application/javascript` |
| 响应格式 | JS：`var r = [[...],[...]]` |
| 实测结果 | HTTP **200**，**3,231,854** 字节 |
| 时效性 | 天级（新基金上市时更新） |

每行 5 元组：`["000001","HXCZHH","华夏成长混合","混合型-灵活","HUAXIACHENGZHANGHUNHE"]` = 代码/拼音简写/名称/类型/全拼。

---

### 1.3 `fundf10.eastmoney.com/jbgk_{code}.html`

| 字段 | 值 |
|---|---|
| 用途 | 基金概况：**跟踪标的**、**业绩比较基准（含权重）**、费率、成立日期/规模、净资产规模、份额规模、经理、托管人 |
| 完整 URL | `https://fundf10.eastmoney.com/jbgk_000001.html` |
| 必需请求头 | **无**（实测不带 Referer 也 200） |
| 编码 | `text/html; charset=utf-8` |
| 响应格式 | HTML 表格（服务端渲染，**静态**，无需 JS） |
| 实测结果 | HTTP **200**，**50,446** 字节 |
| 时效性 | 季度（规模字段）/ 事件驱动（经理、费率） |

实测提取（`<th>...</th><td>...</td>` 结构）：
- `业绩比较基准` → `中证800成长指数收益率*70%+中债-综合全价(总值)指数收益率*30%`
- `跟踪标的` → `该基金无跟踪标的`（主动基金）；联接/指数基金此处给出标的指数

`<th>` 标签全量：基金全称/基金简称/基金代码/基金类型/发行日期/成立日期规模/净资产规模/份额规模/基金管理人/基金托管人/基金经理人/成立来分红/管理费率/托管费率/销售服务费率/最高认购费率/最高申购费率/最高赎回费率/**业绩比较基准**/**跟踪标的**。

---

### 1.4 `fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc`

| 字段 | 值 |
|---|---|
| 用途 | 基金持仓（股票投资明细），**按期** |
| 完整 URL | `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=000001&topline=10&year=2026&month=6` |
| 必需请求头 | **`Referer` 必需**。不带 → 返回 `<!DOCTYPE html ...>` 反爬错误页（不是数据） |
| 编码 | `text/html; charset=utf-8` |
| 响应格式 | JS 变量 **`var apidata={ content:"<div…HTML…>" }`**；`content` 内是 HTML 表格 |
| 实测结果 | HTTP **200**，约 **45 KB** |
| 时效性 | 季度（报告期后约 15 天披露） |

**参数语义（实测，与常识不同）**：
- `year` **有效**：`year=2026` → 返回 2026 年 **全部季度**（1/2/3 季度）合并在一个响应里
- `month` **被忽略**：`month=3/6/9/12` 返回内容完全相同
- `topline` **只对季报生效**：`topline=3` → 季报块各 3 行；`topline=10` → 各 10 行；`topline=100` → 仍 10 行（季报本来只有前十大）
- **半年报/年报块不受 `topline` 限制**，始终返回全量（实测 `000001` 2026 年 2 季度块恒为 77 行）

实测各块行数（含表头 `<tr>`）：`topline=10` → 3季度=11 行、**2季度=78 行（全量）**、1季度=11 行。

表头：`序号 / 股票代码 / 股票名称 / 最新价 / 涨跌幅 / 相关资讯 / 占净值比例 / 持股数（万股）/ 持仓市值（万元）`。

---

### 1.5 `fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd` 【新】

| 字段 | 值 |
|---|---|
| 用途 | **基金规模 / 份额时序**（本次补测目标之一） |
| 完整 URL | `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&code=000001&page=1` |
| 必需请求头 | **`Referer` 必需**（不带返回反爬 HTML） |
| 编码 | UTF-8 |
| 响应格式 | JS 变量 **`var gmbd_apidata={ content:"<table…>" }`**——注意变量名是 `gmbd_apidata`，**不是** `apidata` |
| 实测结果 | HTTP **200**，**60,750** 字节，**101 行**，覆盖 **2001-12-18 → 2026-09-30**（季度全历史） |
| 时效性 | 季度 |

表头：`日期 / 期间申购（亿份）/ 期间赎回（亿份）/ 期末总份额（亿份）/ 期末净资产（亿元）/ 净资产变动率`。

样本：`<tr><td>2026-09-30</td><td>1.51</td><td>1.68</td><td>23.89</td><td>29.19</td><td>-25.89%</td></tr>`

> 注：`pingzhongdata` 的 `Data_fluctuationScale` 只有规模（净资产）时序；本端点额外提供**份额**与申购赎回流量。

---

### 1.6 `fundf10.eastmoney.com/fhsp_{code}.html` 【新 · 解决分红/拆分缺口】

| 字段 | 值 |
|---|---|
| 用途 | **分红送配详情（每10份分红、权益登记日、除息日、发放日）+ 拆分折算（拆分日、类型、比例）** |
| 完整 URL | `https://fundf10.eastmoney.com/fhsp_000001.html`（`510300` 可看拆分） |
| 必需请求头 | **无**（实测不带 Referer 也 200） |
| 编码 | `text/html; charset=utf-8` |
| 响应格式 | HTML 表格，**服务端渲染**（不靠 JS，`id="dlcontent"` 是空的但表格本身在 HTML 里） |
| 实测结果 | HTTP **200**，约 **45–47 KB** |
| 时效性 | 事件驱动 |

**分红表**（`table.cfxq`）列：`年份 / 权益登记日 / 除息日 / 每10份分红 / 分红发放日`
实测 `000001`：`2025年 | 2025-09-22 | 2025-09-22 | 每10份派现金0.1000元 | 2025-09-23`

**拆分折算表**（`table.fhxq`）列：`年份 / 拆分折算日 / 拆分类型 / 拆分折算比例`
实测 `510300`：`2012年 | 2012-05-11 | 份额折算 | 1:0.3709`

> 这是**唯一**能同时拿到分红与份额折算的端点。页面上另有「分红送配公告」区块（JS 加载 `/f10/FHGG`，见 1.9）。

---

### 1.7 `api.fund.eastmoney.com/f10/lsjz` 【新】

| 字段 | 值 |
|---|---|
| 用途 | **历史净值（单位/累计/日增长率）+ 分红拆分事件字段** |
| 完整 URL | `https://api.fund.eastmoney.com/f10/lsjz?fundCode=000001&pageIndex=1&pageSize=20&startDate=2025-09-19&endDate=2025-09-23` |
| 必需请求头 | **`Referer` 必需**（如 `https://fundf10.eastmoney.com/jjjz_000001.html`）。缺失 → HTTP 200 但 body 是 `{"Data":"","ErrCode":-999,...}` |
| 编码 | UTF-8 |
| 响应格式 | **JSON**（`callback=?` 时变 JSONP 包一层） |
| 实测结果 | HTTP **200**，单页约 0.8–1.1 KB；`ErrCode:0`，`Data.LSJZList[]` |
| 时效性 | **T-1**（实测最新 `FSRQ=2026-11-17`，查询日 2026-11-18） |

字段：`FSRQ` 日期 / `DWJZ` 单位净值 / `LJJZ` 累计净值 / `JZZZL` 日增长率 / `SGZT` 申购状态 / `SHZT` 赎回状态 / `NAVTYPE` / **`FHFCZ`** / **`FHFCZ10`** / **`FHFCBZ`** / **`FHSP`**。
另有顶层 `FundType` / `Feature` / `TotalCount` / `PageSize` / `PageIndex`。

**分红 / 拆分实测**（这是缺口的关键）：
- 分红（`000001`，`FSRQ=2025-09-22`）：`FHFCZ:"0.01"`, `FHFCZ10:"0.1"`, `FHFCBZ:"0"`, `FHSP:"每10份派现金0.1000元"`
- 拆分（`510300`，`FSRQ=2012-05-11`）：`FHFCZ:"0.37094933"`, `FHFCZ10:"0.37094933"`, `FHFCBZ:"106"`, `FHSP:"每份基金份额折算0.37094933份"`

> `FHFCBZ` 区分事件类型：实测 `"0"` = 分红，`"106"` = 拆分/折算（**仅两个样本，未穷举，需在实现前扩大样本验证**）。无事件的日期这些字段为空串 / `null`。

---

### 1.8 `api.fund.eastmoney.com/f10/HYPZ/` 【新 · 解决行业配置缺口】

| 字段 | 值 |
|---|---|
| 用途 | **基金行业配置（按报告期）** |
| 完整 URL | `https://api.fund.eastmoney.com/f10/HYPZ/?fundCode=000001&year=2026` |
| 必需请求头 | **`Referer` 必需**（缺失 → HTTP 200 但 `ErrCode:-999`） |
| 编码 | UTF-8 |
| 响应格式 | **JSON**（含可选 `callback=?`） |
| 实测结果 | HTTP **200**，`ErrCode:0`，`Data.QuarterInfos[]` |
| 时效性 | 季度 |

结构：`Data.QuarterInfos[]`，每项含 `Quarter`（`"3"`）、`JZRQ`（`2026-09-30`）、`HYPZInfo[]`；
`HYPZInfo[]` 每项：`HYDM` 行业代码 / `HYMC` 行业名 / `SZ` 市值 / `ZJZBL` 占净值比例 / `ZJZBLDesc` / `SAMMVPCTNV` / `PCTCP`。

实测 `000001` 2026Q3：`制造业 70.00%`、`信息传输、软件和信息技术服务业 8.19%`、`电力、热力、燃气及水生产和供应业 …`。
> 与 §5 已确认的移动端持仓接口（带 `INDEXNAME`）互补：本端点给**基金维度**的行业占比合计，移动端给**个股维度**的所属行业。

---

### 1.9 `api.fund.eastmoney.com/f10/FHGG` 【新】

| 字段 | 值 |
|---|---|
| 用途 | **分红送配公告列表** |
| 完整 URL | `https://api.fund.eastmoney.com/f10/FHGG?fundcode=000001&pageSize=10&pageIndex=1` |
| 必需请求头 | **`Referer` 必需**（缺失 → HTTP 200 但 `ErrCode:-999`） |
| 编码 | UTF-8；响应格式 **JSON**（`callback=?` 变 JSONP） |
| 实测结果 | HTTP **200**，`Data[]` 数组 |
| 时效性 | 事件驱动 |

每项：`FUNDCODE` / `TITLE` / `ShortTitle` / `PUBLISHDATE`（ISO）/ `PUBLISHDATEDesc` / `ATTACHTYPE` / `ID` / `NEWCATEGORY`。
实测 `000001` 最新：「华夏成长证券投资基金第二十五次分红公告」`2025-09-18`。

> **注意**：本端点只给**公告元数据**，**不含**每份分红金额/登记日——结构化金额请用 1.6 的 HTML 页或 1.7 的 `lsjz`。本端点的公告正文 PDF：`http://pdf.dfcfw.com/pdf/H2_{ID}_1.pdf`；详情页：`http://fund.eastmoney.com/gonggao/{FUNDCODE},{ID}.html`。

---

### 1.10 `api.fund.eastmoney.com/f10/JJGG` 【新】

| 字段 | 值 |
|---|---|
| 用途 | **全部公告列表**（净值公告、定期报告、分红、人事等） |
| 完整 URL | `https://api.fund.eastmoney.com/f10/JJGG?fundcode=000001&pageIndex=1&pageSize=10&type=0` |
| 必需请求头 | **`Referer` 必需** |
| 编码 / 格式 | UTF-8 / **JSON**（含 `callback=?`） |
| 实测结果 | HTTP **200**，`Data[]`，字段与 FHGG 相同 |
| 时效性 | 事件驱动 |

实测包含「关于暂停部分电子交易的服务提示」`2026-11-06` 等。`type` 参数控制公告分类（`f10_fhsp` 页用 `type` 过滤），**取值枚举未穷举**。

---

### 1.11 `api.fund.eastmoney.com/f10/GetArrayCwzb` 【新】

| 字段 | 值 |
|---|---|
| 用途 | 财务指标（利润/净值收益等，按报告期） |
| 完整 URL | `https://api.fund.eastmoney.com/f10/GetArrayCwzb?fundcode=000001&showtype=0&year=2026` |
| 必需请求头 | **`Referer` 必需**（同族） |
| 实测结果 | HTTP **200**，`Data.data` 为**列式**字典：`FSRQ:[...]`、`COMPROFIT:[...]`、`NETPROFIT:[...]`、`UNITPROFIT:[...]` |
| 时效性 | 季度 |

> 列式结构（数组对齐）是解析坑点，见 §6。

---

### 1.12 `api.fund.eastmoney.com/f10/JJHSL/` 【新】

| 字段 | 值 |
|---|---|
| 用途 | 基金换手率（股票周转率） |
| 完整 URL | `https://api.fund.eastmoney.com/f10/JJHSL/?fundcode=000001&pageindex=1&pagesize=5` |
| 必需请求头 | **`Referer` 必需** |
| 实测结果 | HTTP **200**，`Data:[{REPORTDATE, STOCKTURNOVER}]` |
| 时效性 | 半年度（实测报告期 2026-06-30 / 2025-12-31 …） |

---

### 1.13 `fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition`

| 字段 | 值 |
|---|---|
| 用途 | 持仓（JSON），**带行业分类与增减持方向** |
| 完整 URL | `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=000001&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=` |
| 必需请求头 | **`User-Agent` 不能是「桌面版 Windows Chrome」**（见下）；**无需 Referer** |
| 编码 / 格式 | UTF-8 / **JSON** |
| 实测结果 | HTTP **200**；成功时 `Success:true`；报告期在顶层 `Expansion`（`"2026-09-30"`） |
| 时效性 | 季度（**仅前十大**） |

`Datas` 键：`fundStocks[]` / `fundboods[]`（债券）/ `fundfofs[]`（FOF）/ `ETFCODE` / `ETFSHORTNAME`。
`fundStocks[]` 每项：`GPDM` 代码 / `GPJC` 名称 / `JZBL` 占净值比例 / `TEXCH` / `PCTNVCHGTYPE`（新增/减持/…）/ `PCTNVCHG` / `INDEXCODE` / `INDEXNAME`（行业）。
实测首项：`中际旭创 5.26% 通信 减持 -1.19`。

**⚠️ UA 门禁（本次新发现，可稳定复现）**：带**典型桌面 Windows Chrome** 的 UA 会被拒，返回 `Success:false, ErrCode:61136403, ErrMsg:"网络繁忙，请稍后重试！"`（HTTP 仍 200）。逐字符复现结果（每个 UA 各测 3 次）：

| User-Agent | 结果 |
|---|---|
| `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36` | **0/3 成功** |
| `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36` | **0/3** |
| `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36`（去掉 WebKit 段） | 3/3 ✅ |
| `Mozilla/5.0 (Windows NT 10.0; Win64; x64)` | 3/3 ✅ |
| `curl/8.0` | 3/3 ✅ |
| `... (iPhone ...) ... Safari/605.1.15 Mobile/15E148` | 3/3 ✅ |
| `... (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/120.0 Safari/537.36` | ✅ |

> 判据：触发拦截需同时含 `Windows NT 10.0` + `Win64` + `AppleWebKit/537.36 (KHTML, like Gecko)` + `Chrome/…`。**建议实现固定使用带 `Mobile` 的 UA**（最稳）。`ErrMsg` 的「网络繁忙」是**误导信息**，必须按 UA 问题排查，不要当网络抖动重试。

---

### 1.14 `fundmobapi.eastmoney.com/FundMNewApi/FundMNAssetAllocationNew` 【新】

| 字段 | 值 |
|---|---|
| 用途 | 资产配置（按报告期的股票/债券/现金占净比 + 净资产） |
| 完整 URL | `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNAssetAllocationNew?FCODE=000001&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=` |
| 必需请求头 | 同 1.13（移动 UA） |
| 实测结果 | HTTP **200**；`Datas:[{FSRQ:"2026-09-30", GP:"78.21", ZQ:"20.82", HB:"0.45", JZC:"29.1867", QT:"0.52", JJ:"--"}]` |
| 时效性 | 季度 |

> 与 `pingzhongdata.Data_assetAllocation` 数值一致（78.21%），但本端点是**结构化 JSON**、带明确报告期，更适合。
> **§5 口径警告仍适用**：联接基金（如 `011609`）的「股票占净比」是障眼法（实测 0.41%），有效暴露取自业绩比较基准。

---

### 1.15 `fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList` 【新】

| 字段 | 值 |
|---|---|
| 用途 | 历史净值（移动端 JSON 版） |
| 完整 URL | `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?FCODE=000001&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&Uid=` |
| 必需请求头 | 同 1.13（移动 UA） |
| 实测结果 | HTTP **200**；`Datas:[{FSRQ:"2026-11-17", DWJZ:"0.9510", JZZZL:"0.74", LJJZ:"3.5240", NAVTYPE:"1", ...}]` |
| 时效性 | T-1 |

> 与 `api.fund/f10/lsjz` 字段几乎一致，但**不看 Referer**、直接分页。**注意**：本端点**不含** `FHFCZ`/`FHSP` 分红拆分字段（实测无）——要分红/折算事件仍须用 1.7。

---

### 1.16 `fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation` / `FundMNDetailInformation` 【新】

| 端点 | 用途 | 实测 |
|---|---|---|
| `FundMNBasicInformation?FCODE=` | 基本信息（名称、类型、`FSRQ`、`RZDF` 日增长率…） | 200，`Datas{...}` |
| `FundMNDetailInformation?FCODE=` | 详情（全称、成立日、`WEBBACKCODE` 后端代码…） | 200，`Datas{...}` |

均需移动 UA、无需 Referer。
> 实测不可用（返回 `ErrCode:404`）：`FundMNFundManagers`、`FundMNScaleChange`、`FundMNFHSP`、`FundMNDividend`、`FundMNGGList`。

---

### 1.17 `qt.gtimg.cn/q=...`

| 字段 | 值 |
|---|---|
| 用途 | 实时行情（指数 / 场内 ETF / 个股） |
| 完整 URL | `https://qt.gtimg.cn/q=sh000300,sz399006,sh510300,sh600519` |
| 必需请求头 | **无** |
| 编码 | **GBK**（响应头 `Content-Type: text/html; charset=GBK`）——实测：直接看字节是乱码，`iconv -f GBK` 后正常 |
| 响应格式 | JS 变量赋值：`v_sh000300="1~沪深300~000300~3958.51~...";`（`~` 分隔） |
| 实测结果 | HTTP **200**，1484 字节（3 个代码）；字段第 4 个为**时间戳** `20261118110303`（实时） |
| 时效性 | **实时**（交易时段） |

首字段：名称 `沪深300` / 代码 `000300` / 现价 / 昨收 / 今开 / 成交量 …（`~` 分隔，字段位置需按官方顺序表解析）。

---

### 1.18 `web.ifzq.gtimg.cn/appstock/app/fqkline/get`

| 字段 | 值 |
|---|---|
| 用途 | 日 K 线（前复权 qfq 等） |
| 完整 URL | `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000300,day,2026-10-01,2026-11-18,20,qfq` |
| 必需请求头 | **无** |
| 编码 | 响应头 `text/html; charset=UTF-8`；**body 是 JSON** |
| 响应格式 | JSON：`{"code":0,"data":{"sh000300":{"day":[[date,open,close,high,low,volume],...]}}}`
| 实测结果 | HTTP **200**，3163 字节 |
| 时效性 | 日 K（收盘后 / 盘中含当日） |

`param` 格式：`{市场}{代码},{周期},{起},{止},{数量},{复权}`。

---

### 1.19 `push2.eastmoney.com/api/qt/stock/get`（个股行业分类）

| 字段 | 值 |
|---|---|
| 用途 | 个股所属行业（`f127`）+ 地域板块（`f128`） |
| 完整 URL | `https://push2.eastmoney.com/api/qt/stock/get?secid=0.300308&fields=f57,f58,f127,f128` |
| 必需请求头 | **无** |
| 编码 / 格式 | UTF-8 / **JSON** |
| 实测结果 | HTTP **200**，`{"data":{"f57":"300308","f58":"中际旭创","f127":"通信设备","f128":"山东板块"}}` |
| 时效性 | 基本静态 |

实测样本：`300308`→`通信设备`；`600519`→`白酒Ⅱ`；`300750`→`电池`。
`secid` 市场号：`0.` = 深市/创业板，`1.` = 沪市。**`f127` 是细分行业名（如「白酒Ⅱ」「电池」），非申万一级**——与 `HYPZ` 的 `HYMC`（如「制造业」）**口径不同，不可混用**。

---

### 1.20 `push2.eastmoney.com/api/qt/clist/get`（板块成分）

| 字段 | 值 |
|---|---|
| 用途 | 板块 / 指数成分股列表 |
| 完整 URL | `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&fs=b:BK0475&fields=f12,f14` |
| 必需请求头 | **无** |
| 实测结果 | HTTP **200**；`fs=b:BK0475`（银行）→ `total:42`，`diff` 为 `{序:{f12:代码,f14:名称}}` 字典 |
| 时效性 | 天级 |

> **实测**：`fs=i:1.000300` **不返回成分股**（只回指数本身，`total:1`）——指数成分要用对应的**板块代码**（`b:BKxxxx`），不是 `i:` 形式。具体 `BK` 代码映射未穷举。

---

## 2. 补测：新发现的端点

本次在 §5 已确认的 8 个端点之外，**新发现 10 个可用端点**：

| 缺口 | 结论 | 端点 |
|---|---|---|
| **分红 / 份额折算** | ✅ **已解决（两条独立路子）** | ① `fundf10.eastmoney.com/fhsp_{code}.html`（服务端渲染 HTML，含分红表 + 拆分表）② `api.fund.eastmoney.com/f10/lsjz`（JSON，`FHFCZ`/`FHFCZ10`/`FHFCBZ`/`FHSP` 字段） |
| **行业配置（基金维度）** | ✅ **已解决** | `api.fund.eastmoney.com/f10/HYPZ/?fundCode=&year=`（按季度返回行业占比合计） |
| **净值公告 / 分红公告** | ✅ **已解决** | `api.fund.eastmoney.com/f10/JJGG`（全部公告）+ `api.fund.eastmoney.com/f10/FHGG`（分红公告） |
| **规模 / 份额时序** | ✅ **已解决** | `FundArchivesDatas.aspx?type=gmbd`（份额 + 申购赎回 + 净资产，季度全历史）+ 移动端 |

**新发现的 10 个**：`type=gmbd`、`fhsp` HTML、`/f10/lsjz`、`/f10/HYPZ/`、`/f10/FHGG`、`/f10/JJGG`、`/f10/GetArrayCwzb`、`/f10/JJHSL/`、`FundMNAssetAllocationNew`、`FundMNHisNetList`（另 `FundMNBasicInformation`/`FundMNDetailInformation` 归入同族）。

### 本次试过但**不可用**的路径（明确记录，不编造）

| 端点 / 类型 | 结果 |
|---|---|
| `FundArchivesDatas.aspx?type=fhsp` | HTTP 200，**12 字节**（`var apidata=`），空 |
| `FundArchivesDatas.aspx?type=hytz` | HTTP 200，**12 字节**，空 |
| `FundArchivesDatas.aspx?type=jjgg` | HTTP 200，**12 字节**，空 |
| `fundgz.1234567.com.cn/js/{code}.js` | HTTP **200**，但 body 是「页面未找到」HTML（**软 404**） |
| `api.fund.eastmoney.com/fund/fundgz?fundcode=` | HTTP 200，239 字节，错误 JSON |
| `api.fund.eastmoney.com/f10/JJFH` | HTTP 200，99 字节，`{"ErrCode":4,"ErrMsg":"404"}` |
| `api.fund.eastmoney.com/f10/lssy` | HTTP 200，`ErrCode:0` 但 `LSJZList:null`（空，参数未摸清） |
| `api.fund.eastmoney.com/F10/JJPJ/` | `{"ErrCode":4,"ErrMsg":"404"}` |
| `api.fund.eastmoney.com/f10/FundGPTop10/` | `{"ErrCode":4,"ErrMsg":"404"}` |
| `fundmobapi.../FundMNFHSP` / `FundMNDividend` / `FundMNGGList` / `FundMNFundGG` / `FundMNFundManagers` / `FundMNScaleChange` | 全部 `ErrCode:404` |

### 未能解决 / 未验证的

- **分红 / 拆分的完整枚举验证**：`FHFCBZ` 的取值语义（`0` vs `106`）**只有 2 个样本**，未穷举。不同基金/不同事件类型的取值未知。
- **`/f10/JJGG` 的 `type` 参数取值枚举**：未摸清（实现时需逆向或用 `fhsp`/`jjgg` 页确认）。

---

## 3. 稳定性评估

按「是否面向公开 App / 官网、是否在官方前端 JS 里被引用、域名归属」判断。

### 相对稳定（官方端点在用，短期不易变）

| 端点 | 依据 |
|---|---|
| `pingzhongdata/{code}.js` | 天天基金官网页面直接 `<script>` 引用的静态资源；有 `Last-Modified`，被 CDN（`X-Cache-Lookup: Cache Hit`）缓存 |
| `fundcode_search.js` | 同站全站引用的基础资源 |
| `jbgk_{code}.html`、`fhsp_{code}.html` | **服务端渲染的正式页面**，无 Referer 校验；页面结构即产品形态，改动成本高 |
| `qt.gtimg.cn/q=` | 腾讯财经行情主接口，公开、无鉴权 |
| `web.ifzq.gtimg.cn/.../fqkline/get` | 同族公开行情接口 |
| `push2.eastmoney.com/api/qt/...` | 东财行情中心主接口，`clist`/`stock/get` 是通用能力 |

### 中等（官方 Web 前端在用，但走内部 API host，有反爬）

| 端点 | 依据 |
|---|---|
| `api.fund.eastmoney.com/f10/*`（lsjz/HYPZ/FHGG/JJGG/GetArrayCwzb/JJHSL） | **在官方 F10 前端 JS（`j5.dfcfw.com/sc/js/web/f10_min_*.js`）里被显式引用**——不是野路子，是官方前端自己在调；但**强制校验 `Referer`**，属反爬层，参数/路径可能随前端重构变动 |
| `fundmobapi.eastmoney.com/FundMNewApi/*` | **官方移动端 App 的接口**，参数（`deviceid/plat/product/version`）是 App 协议；版本号、字段可能随 App 升级变化；有 UA 门禁 |
| `FundArchivesDatas.aspx?type=jjcc/gmbd` | 网页 F10 动态加载接口，需 Referer，返回结构是「JS + 内嵌 HTML」这种脆弱形态 |

### 判断依据小结

- **看它有没有被官方前端直接调用**：`api.fund` 的 `/f10/*` 路径是**直接从 `f10_min_20250219.js` 里抠出来的**（`LoadFHGG`/`LoadJJGG`/`LoadHYPZ`…），说明是**官方 F10 在用的接口**，不是遗弃接口——比「猜测路径」可靠得多。
- **有 `ErrCode` 协议的都是内部接口**（`api.fund`、`fundmobapi`、`push2`），会变；**纯静态资源**（`pingzhongdata`、`fundcode_search`、HTML 页）最稳但结构可能随改版调整。
- **最脆弱的端点**（见 §汇报）：`fundmobapi/FundMNewApi/*`——三重脆弱：① 内部 App 接口 ② 有 UA 门禁（`61136403` 语义还在变）③ 参数带 `version=2.0.0`（App 升级会改）。其次是 `FundArchivesDatas.aspx`（JS+HTML 混合 + Referer 校验 + `gmbd_apidata` 与 `apidata` 变量名不一致）。

---

## 4. 限流观察

**测试方法**：每个端点连续请求，固定间隔，记录 HTTP 码与是否返回有效数据。**单端点 ≤ 20 次**，间隔 ≥ 200ms，符合任务要求。

| 端点 | 次数 | 间隔 | 结果 |
|---|---|---|---|
| `api.fund/f10/lsjz` | 15 | 250ms | **15/15 成功**，HTTP 200，响应 0.14–0.18s，无重置/空响应 |
| `push2/api/qt/clist/get` | 20 | 200ms | **20/20 成功**，0 失败 |
| `qt.gtimg.cn/q=` | 20 | 200ms | **20/20 成功**，0 失败 |
| `fundmobapi/.../FundMNInverstPosition` | 20 | 200ms | **20/20 成功**（用移动 UA），0 失败 |

**结论**：
- 在上述间隔（≥200ms）与次数（≤20）下，**未观测到任何限流**（无连接重置、无空响应、无 429/403）。
- **安全间隔建议：≥200ms**（实测足够）；实现中建议**默认 ≥300ms 并带指数退避**，避免长时间高频。
- **是否需 Referer**：**分端点，必须逐端点区分**（这是最容易踩的坑）：
  - **必需 Referer**：`api.fund.eastmoney.com/f10/*`（缺失 → HTTP 200 但 `ErrCode:-999`）、`FundArchivesDatas.aspx`（缺失 → 反爬 HTML 页）
  - **不需要 Referer**：`pingzhongdata`、`fundcode_search`、`jbgk`、`fhsp`、`qt.gtimg`、`fqkline`、`push2`、`fundmobapi`
- **是否需要 UA**：仅 `fundmobapi` 需要（且是**排除**桌面 Windows Chrome，不是「必须像浏览器」）。

> ⚠️ 注意：`fundmobapi` 在不合规 UA 下返回的 `ErrMsg` 是「网络繁忙，请稍后重试！」——**看起来像限流，其实不是**。若把它当限流做退避重试，会永远失败。**必须先排除 UA 因素**。

---

## 5. fixture 策略建议

与 `docs/CONSTRAINTS/09-process.md` §9.2 的两层测试对齐（单元测试打 fixture / 契约测试打真网络）。

### 5.1 哪些端点值得固化 fixture

判断依据：**稳定性高 + 解析复杂度高** → 最值得固化（因为解析代码最可能出错，而接口又不会天天变，fixture 保值）。

| 端点 | 固 fixture？ | 理由 |
|---|---|---|
| `pingzhongdata/{code}.js` | ✅ **强烈建议** | 解析复杂（JS 赋值、20+ 变量、epoch 毫秒、BOM）且是核心净值来源 |
| `FundArchivesDatas.aspx?type=jjcc` | ✅ **强烈建议** | 解析最复杂（JS+HTML、多报告期混一个响应、表头列数与数据列不一致） |
| `fhsp_{code}.html` | ✅ **建议** | 分红/折算解析关键；须覆盖**有分红**与**有拆分**两种样本（`000001`+`510300`） |
| `api.fund/f10/lsjz` | ✅ **建议** | 核心净值源 + 分红字段；须含**分红日**与**拆分日**样本 |
| `api.fund/f10/HYPZ/` | ✅ **建议** | 行业配置缺口的关键；结构嵌套深 |
| `FundArchivesDatas.aspx?type=gmbd` | ✅ 建议 | 变量名 `gmbd_apidata` 特殊，易错 |
| `fundmobapi/FundMNInverstPosition` | ✅ 建议 | 增减持/行业字段；且须固化 UA 相关行为（不足以固化 UA 门禁本身） |
| `jbgk_{code}.html` | ⚠️ 可选 | 结构化程度尚可，但 HTML 表格解析仍需回归；至少存 1 个主动 + 1 个指数基金样本（业绩比较基准） |
| `fundcode_search.js` | ❌ **不建议** | 3.2 MB、近乎全量数据、结构极简（纯数组）。存 fixture 只会让仓库臃肿，解析逻辑本身几乎不会错 |
| `qt.gtimg.cn` / `fqkline` | ❌ 不建议（或仅存小样本） | 纯实时行情、字段序位解析简单；fixture 意义主要是「字段位置回归」，存 1 个小样本即可 |
| `push2` 系列 | ❌ 不建议 | JSON 极简（`f127` 等），解析风险低 |
| `api.fund/f10/JJGG`、`FHGG` | ❌ 不建议 | 仅公告元数据，解析简单；且内容天天变 |
| `FundMNAssetAllocationNew` 等移动端同族 | ❌ 不建议 | 结构简单 |

### 5.2 fixture 存什么：原始响应

**存「原始响应字节」，不清洗**。理由：
1. 清洗后无法验证解析器（解析器要吃的就是原始字节）
2. 编码陷阱（GBK / BOM）只有原始字节才暴露
3. 契约测试与单元测试可共享同一份 fixture

**例外**：`fundcode_search.js` 这类超大文件若确需，可截取**头 N 条 + 尾 N 条**，但必须标注为「截断样本」。

### 5.3 目录组织建议

```
packages/datasource/
  test/
    fixtures/
      pingzhongdata/
        000001.js                 ← 原始字节（含 BOM）
      fundcode_search/
        000001.js
      jjcc/
        000001-2026.html          ← 含 3 个报告期混排的原始响应
      gmbd/
        000001.html
      fhsp/
        000001.html               ← 有分红
        510300.html               ← 有拆分
      api_fund_lsjz/
        000001-dividend.json      ← 分红日窗口
        510300-split.json         ← 拆分日窗口
      api_fund_hypz/
        000001-2026.json
      fundmobapi_position/
        000001.json
      jbgk/
        000001.html
        011609.html               ← 联接基金（业绩比较基准）
      manifest.json               ← 见 5.4
    contract/                     ← 契约测试（打真网络）与 fixtures 同目录树
```

### 5.4 fixture 元信息（关键）

**每个 fixture 必须带元信息**——fixture 会过期，必须知道它是什么时候、从哪抓的。建议**每个 fixture 目录放一个 `*.meta.json`**，或集中一份 `manifest.json`：

```jsonc
{
  "file": "000001.js",
  "sourceUrl": "https://fund.eastmoney.com/pingzhongdata/000001.js",
  "endpoint": "pingzhongdata",
  "fundCode": "000001",
  "capturedAt": "2026-11-18T11:05:00+08:00",   // 抓取时刻（带时区）
  "httpStatus": 200,
  "contentType": "application/javascript",
  "encoding": "utf-8-bom",                       // 原始编码
  "bytes": 766796,
  "sha256": "…",                                 // 用于契约测试比对漂移
  "requestHeaders": { "User-Agent": "…" },       // 复现所需头（Referer/UA）
  "dataAsOf": "2026-11-18",                      // 数据本身的时点（净值日期/报告期）
  "notes": "含 Data_netWorthTrend 至 2026-11-17"
}
```

必须有的字段：**`capturedAt`（抓取时刻，带时区）、`sourceUrl`、`fundCode`、`requestHeaders`、`dataAsOf`、`sha256`**。
`dataAsOf`（数据时点）与 `capturedAt`（抓取时点）**必须分开**——对净值类 fixture，两者常差 T-1。

**同时建议提供重新抓取脚本**（`scripts/refresh-fixtures.ts`，走 `packages/datasource`，按 manifest 的 `sourceUrl`+`requestHeaders` 重抓），呼应 §9.2「提供重新抓取脚本」。

---

## 6. 解析风险点

| # | 端点 | 坑 | 处置 |
|---|---|---|---|
| 1 | `pingzhongdata/*.js` | **是 JS 赋值语句不是 JSON**；`var x = ...;` 多个 | **不要 `eval`**；用 `node:vm` 沙箱（给定白名单变量）或正则。`Data_netWorthTrend` 的 `x` 是 **epoch 毫秒**，非日期串 |
| 2 | `pingzhongdata/*.js` | 文件**带 UTF-8 BOM**（`﻿`），首行 `/** * 测试数据 * ...*/` 注释混排 | 解析前 strip BOM；不要假设第一段就是数据 |
| 3 | `fundcode_search.js` / `gmbd` / `jjcc` | 顶层是 `var r =` / `var apidata=` / `var gmbd_apidata=`——**变量名不统一**（`gmbd` 不是 `apidata`） | 按端点识别变量名，别写死 `apidata` |
| 4 | `FundArchivesDatas type=jjcc` | **一个响应含多个报告期**，按 `<h4 class="t">` 分块；块内 `<label class="left">` 是基金名、`截止至：<font>` 是报告期 | 先按 `<h4>` split，再块内取 `<table>`；报告期从 `截止至` 或标题 `2026年3季度` 取 |
| 5 | `FundArchivesDatas type=jjcc` | **表格列数与表头不一致**：表头有「最新价/涨跌幅/相关资讯」，但**历史报告这些列是空的**（`<td></td>`），导致按位置取「占净值比例」会错位 | 按第 7 列（或按 `<td class="...">` 语义）取，不要按「第 4 个 td 是比例」硬编码；对空 `td` 做容错 |
| 6 | `FundArchivesDatas type=jjcc` | **半年报/年报块无视 `topline`**，始终全量；季报块受 `topline` 限制；`month` 参数**被忽略** | 按块判断是季报还是半年报/年报（看行数或标题），据此决定「这是完整持仓还是前十大」 |
| 7 | `qt.gtimg.cn` | **GBK 编码**，`~` 分隔，`v_xx="..."` 变量赋值 | `TextDecoder('gbk')` 解码后再按 `~` split；字段位置按官方顺序表 |
| 8 | `fqkline` | 响应头写 `charset=UTF-8`，但腾讯行情族历史上有 GBK 风险 | 统一按 UTF-8 解；若出现乱码，回退 GBK（防御性）|
| 9 | `api.fund/f10/*` | **缺 Referer 时 HTTP 200 + `ErrCode:-999`**（不是 4xx） | **必须校验 `ErrCode`**，不能只看 status code；错误分类见 §8.3 |
| 10 | `fundmobapi/*` | 不合规 UA 时 HTTP 200 + `Success:false, ErrCode:61136403, ErrMsg:"网络繁忙"` | 同上，**校验 `Success`/`ErrCode`**；且**不要**把「网络繁忙」当限流退避 |
| 11 | `fundmobapi/.../FundMNInverstPosition` | 报告期在**顶层 `Expansion`**（`"2026-09-30"`），不在 `Datas` 内；`Datas` 只有 `fundStocks/fundboods/fundfofs` | 从 `Expansion` 取报告期；**只返回前十大**（实测 `fundStocks` 长度 10） |
| 12 | `api.fund/f10/lsjz` | 分红/拆分信息藏在**普通净值行的附加字段**里（`FHFCZ`/`FHSP`），非独立事件列表；多数行为空 | 遍历所有行，凡 `FHFCZ`/`FHSP` 非空即提取事件；注意空串 vs `null` 混用 |
| 13 | `api.fund/f10/lsjz` | `FundType`/`Feature` 等为避免字符串，`FHFCZ10` 在无事件时为 `null`（有事件时是字符串） | 类型做联合处理，勿假定 string |
| 14 | `fhsp_{code}.html` | 分红表与拆分表是**两个不同 class 的 table**（`table.cfxq` vs `table.fhxq`）；数量文字内嵌中文（「每10份派现金0.1 000元」/「1:0.3709」） | 分开解析两张表；金额/比例需从中文里正则抽出 |
| 15 | `GetArrayCwzb` | 返回是**列式字典**（`FSRQ:[...]`, `NETPROFIT:[...]` 按索引对齐），不是行式数组 | 按索引 zip 成行；**数组长度不一致时要以最短为准并告警** |
| 16 | `jbgk_{code}.html` | 字段是 `<th>标签</th><td>值</td>` 平铺，**同一行可能夹多个 `<th>/<td>`**（如「业绩比较基准」与「跟踪标的」同行） | 按 `<th>` 文本定位，取其后第一个 `<td>`；不要按行取 |
| 17 | `HYPZ` | 行业名 `HYMC` 是**国民经济行业分类**（「制造业」「信息传输、软件和信息技术服务业」），与 `push2` 的 `f127`（「白酒Ⅱ」「电池」）**口径不同** | 两套行业体系不可混用；归因前明确用哪套 |
| 18 | `FundMNAssetAllocationNew` / `pingzhongdata` | 联接基金「股票占净比」字段是障眼法（`011609` 实测 0.41%），须用业绩比较基准 | 见 §5/§4 规则 5；UI 需标注口径 |
| 19 | 通用 | 多个东财接口**失败时仍返回 HTTP 200**（软失败），错误藏在 body 的 `ErrCode`/`Success` | datasource 层统一做「HTTP 码 + 业务码」双重校验；否则 `A3 静默使用陈旧/错误数据` |

---

## 7. 实现期新增实测（2026-11-18，计划 3 执行中）

写 `packages/datasource` 时抓真实响应得到的、**上文没有记过**的事实。与上文冲突处，以本节为准。

### 7.1 `pingzhongdata.Data_netWorthTrend[].x` 是**北京时间零点**的 epoch 毫秒，不是 UTC

**这条错了会污染整条净值序列**，且错得看不出来——只是整体差一天。

- 首条记录 `1008604800000`：按 UTC 解是 `2001-12-17`，按 `+08:00` 解是 `2001-12-18`
- `2001-12-18` 正是 `000001` 的成立日 → **`+08:00` 才对**
- 用已落盘的 `lsjz` fixture 逐日交叉验证：**`+08:00` 三条全对；UTC 三条全早一天**

**处置：** 转业务日期时按 `Asia/Shanghai`（`+08:00`）取日历日，**不要按 UTC**。`CONSTRAINTS/08-code-style.md` §8.2 警告的「日期静默错位一天」在这里是反向触发的——想当然按 UTC 才是那个坑。

### 7.2 `pingzhongdata.Data_netWorthTrend[].unitMoney` 文案残缺，**不能当金额用**

实测一律是 `"分红：每10份派现金元"`——**金额那一段是空的**。

**处置：** 只能用它判断「这一天有分红事件」，**金额必须另取**（`f10/lsjz` 的 `FHFCZ`，或 `fhsp_{code}.html`）。

### 7.3 `api.fund/f10/*` 的其它行为

| 观察 | 处置 |
|---|---|
| `lsjz` 传**不存在的基金代码**返回 `LSJZList:[]` 且 `ErrCode:0` | **打错代码不报错，只给空净值**。业务层需能区分「该基金近期无净值」与「代码不存在」——否则用户输错代码会看到一片空白而不是错误 |
| 缺 Referer 时 `PageSize`/`PageIndex` 也是 `0` | **`ErrCode` 校验必须先于分页字段校验**；先读分页字段会得到误导性的 `0` |
| `GetArrayCwzb` 查无数据的年份返回**一行全空串占位行**（`FSRQ:[""]`），不是空数组 | 跳过该行并记入告警，否则会产出一行全 `null` 的财务指标 |
| `FHGG` 对参数名**大小写不敏感** | 与 §1.9 的暗示（须逐端点区分大小写）部分不符。仍按实测大小写写死并有测试钉住，但不必为大小写变体写兼容代码 |

### 7.4 `pingzhongdata` 的其它字段形态

- `mom`（环比）与 `sc` 是**字符串**，不是数字
- `Data_grandTotal` 的线名**固定**为 `[基金名, 同类平均, 沪深300]`，可按下标取
- 以下变量**有意不纳入**：`ishb`（格式残缺）、`stockCodes`/`zqCodes`（测算用，**不是确认持仓**）、`swithSameType`

### 7.5 `FundArchivesDatas?type=jjcc` 的参数语义——**§1.4 有三处不成立，以本小节为准**

实现 Task 5 时用真实响应复核，§1.4 的「参数语义」四条里**错了两条、另一条不完整**：

| §1.4 原文 | 实测 |
|---|---|
| `month` **被忽略** | ❌ **不成立**。`month` 决定**哪个报告期块返回全量**：`month=6` → 06-30 块全量（77 行）、`month=12` → 12-31 块全量。不是「返回内容完全相同」 |
| 半年报/年报块**不受 `topline` 限制**，始终全量 | ❌ **不成立**。**只有命中 `month` 的那个块**是全量；其余半年报/年报块**仍被 `topline` 截断** |
| 表头列数与数据列不一致（历史报告有**空 `<td>`**） | ⚠️ **不完整**。差异不是「空 `<td>`」而是**整列不存在**：当前季度块每行 **9 个 `<td>`**，历史块只有 **7 个**（那三列根本没渲染）。所以「按位置取占净值比例」**必错**——按**最后三列**取 |

**⚠️ 最要紧的一条：判断「这是完整持仓还是前十大」，不能按报告期类型。**

按报告期类型判（「半年报就是全量」）会**高估**——被 `topline` 截断的半年报块也是半年报。正确做法是**读块尾 `tfoot` 的链接文案**：

| 块尾链接 | 含义 |
|---|---|
| `收起持仓明细` | **完整持仓** |
| `显示全部持仓明细` | **被截断** |
| （无此链接） | 季报块，**前十大** |

**但这个规则只有前两个变体中的一个被实测观测到**：已落盘的 `000001-2026.html` 里 `收起持仓明细` 出现 1 次、`显示全部持仓明细` **0 次**。「被截断」那个分支尚未在真实响应中出现过，**用前需补一个 `month` 命中、且被截断的样本**。

**这一条直接决定能力层的 `loss` 字段是否正确**——判错会让用户以为看到了全部持仓，而实际只有前十大。

### 7.6 `FundArchivesDatas` 的其它实测

- **缺 `Referer` 返回 HTTP 404 + 反爬 HTML**，不是 §1.4 隐含的 200。解析器喂到 HTML 时 vm 抛 `SyntaxError` → 归 `ParseError`；但**真实链路会先被 `HttpClient` 当非 2xx 抛 `HttpError`（可重试）**——能力层要知道这两种路径的存在
- **不传 `topline` 会返回「有表头无数据」**，故默认必须给 10
- `type=gmbd` 的 `data` 数组**字段语义自相矛盾**（`NETNAV` 与 `QMJZC` 混用），**有意不解析**——宁可少给字段，不给错语义

### 7.7 fixture 的落盘约束

**fixture 必须逐字节存盘，且必须从 Prettier 的格式化范围内排除。** 实测 Prettier 会把 fixture 里的压缩 JSON 重排成多行，既破坏「原始响应」的可验证性，也让 manifest 里的 `sha256` 立刻失效。已在 `.prettierignore` 中排除 `packages/datasource/test/fixtures/**`。

---

## 附录 A：已失效端点（实测确认）

| 端点 | 状态 | 失效形态 |
|---|---|---|
| `fundgz.1234567.com.cn/js/{code}.js` | ❌ 失效 | **软 404**：HTTP 200 + 「页面未找到」HTML（**不是** 404！须按内容判） |
| `api.fund.eastmoney.com/f10/JJFH` / `JJCF` | ❌ 失效 | HTTP 200 + `{"ErrCode":4,"ErrMsg":"404"}` |
| `api.fund.eastmoney.com/fund/fundgz` | ❌ 失效 | HTTP 200 + 239 字节错误 JSON |
| `FundArchivesDatas.aspx?type=fhsp` / `type=hytz` / `type=jjgg` | ❌ 返回空 | HTTP 200 + `var apidata=`（12 字节） |
| `api.fund.eastmoney.com/F10/JJPJ/` / `f10/FundGPTop10/` | ❌ 404 | 结构化 404 |

## 附录 B：需要回写 `docs/CONSTRAINTS/05-data-sources.md` §5 的条目

1. `fundgz` 改为「**软 404（200 + 错误页）**」，并提醒不能只查状态码。
2. 删除「`api.fund.eastmoney.com/f10/*` 整族失效」——改为「`JJFH`/`JJCF` 失效，但 **`lsjz`/`HYPZ`/`FHGG`/`JJGG`/`GetArrayCwzb`/`JJHSL` 可用（均需 Referer）**」。
3. 「分红/份额折算无自动来源」——**可更新为「有来源」**：`fhsp_{code}.html`（分红 + 拆分两张表）+ `lsjz`（`FHFCZ` 等字段）。仍建议保留「手工确认」流程（分红口径需用户确认现金分红 vs 红利再投）。
4. 「行业配置 `type=hytz` 失效」——补上替代：`api.fund/f10/HYPZ/`（基金维度）+ 移动端持仓 `INDEXNAME`（个股维度）。
5. 新增「规模/份额时序」：`type=gmbd`。

## 附录 C：部分原始响应大小速查

| 端点 | HTTP | 字节 | Content-Type |
|---|---|---|---|
| pingzhongdata/000001.js | 200 | 766,796 | application/javascript |
| fundcode_search.js | 200 | 3,231,854 | application/javascript |
| jbgk_000001.html | 200 | 50,446 | text/html; charset=utf-8 |
| FundArchivesDatas?type=jjcc&year=2026 | 200 | ~45,400 | text/html; charset=utf-8 |
| FundArchivesDatas?type=gmbd | 200 | 60,750 | text/html; charset=utf-8 |
| FundArchivesDatas?type=fhsp | 200 | 12 | text/html; charset=utf-8 |
| fhsp_000001.html | 200 | 47,295 | text/html; charset=utf-8 |
| qt.gtimg.cn/q=sh000300,sz399006,sh510300 | 200 | 1,484 | text/html; charset=GBK |
| fqkline/get (sh000300,day,20) | 200 | 3,163 | text/html; charset=UTF-8 |
| push2 stock/get (f57,f58,f127,f128) | 200 | 158 | application/json |
| push2 clist/get (pz=3) | 200 | 224 | application/json |
| fundmobapi FundMNInverstPosition | 200 | ~234(错)/数千(对) | application/json; charset=utf-8 |
