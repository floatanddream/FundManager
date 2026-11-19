import { approxEqual, assertDate } from '@fundmanager/shared'
import type { LedgerPosition, LedgerTransaction } from './types.ts'

/**
 * 从流水推导某只基金在某日的持仓：份额、成本、已实现收益。
 *
 * 纯函数：不读时钟、不做 IO，`asOf` 由调用方给。只吃 `status === 'confirmed'`
 * 的流水——待确认流水被算进持仓就是静默算错账，这条是契约而非优化。
 *
 * **必须按账本筛选**（§7.2）：流水挂在账本下，两个账本买同一只基金的份额不能相加。
 * `ledgerId` 是必填参数而不是「由调用方先筛好」的约定——漏筛会静默把两个账本的
 * 份额加在一起，编译器拦不住注释里的约定，但拦得住少传参数。
 *
 * 成本按移动加权平均：赎回按比例结转（单位成本不变），现金分红只进已实现收益，
 * 红利再投拆成「分红 + 按再投金额买入」两步。
 *
 * @param transactions 流水，顺序任意；可含其他基金与其他账本，这里负责筛选
 * @param ledgerId 要推导的账本
 * @param fundCode 要推导的基金代码
 * @param asOf 截止日（含当日），`YYYY-MM-DD`
 * @returns 持仓；没有买入记录时 `cost` / `costPerShare` 为 null（成本未知），
 *   份额为 0 时 `costPerShare` 为 null
 * @throws {TypeError} 任一日期不是合法的 `YYYY-MM-DD`；参与推导的流水缺该 `kind`
 *   的必填字段；出现已取消的 `fee` kind；或赎回份额超过账面份额（流水不完整）
 */
export function derivePosition(
  transactions: readonly LedgerTransaction[],
  ledgerId: string,
  fundCode: string,
  asOf: string,
): LedgerPosition {
  assertDate(asOf, 'asOf')

  const relevant: LedgerTransaction[] = []
  for (const t of transactions) {
    if (t.status !== 'confirmed' || t.ledgerId !== ledgerId || t.fundCode !== fundCode) continue
    // 先校验再比较：非法日期按字典序会被静默归入「截止日之前」或之后，
    // 份额随之算错。只校验真正参与推导的流水，其他基金的坏数据不牵连本基金
    assertDate(t.date, 'LedgerTransaction.date')
    if (t.date <= asOf) relevant.push(t)
  }
  // 先按日期（YYYY-MM-DD 定长，字典序即时间序），同日再按 sequence。
  // **同日顺序不能依赖入参顺序**：同样的申购 + 折算，换序会算出不同份额
  // （100 与 200），而调用方往往从数据库按 id 取出来，顺序本就不保证。
  assertSameDaySequence(relevant)
  relevant.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date)
    return a.sequence! - b.sequence!
  })

  let shares = 0
  // null 表示成本未知（从未有过买入记录）。不用 0 冒充——上层会把 0 当成真实成本
  // 去算盈亏（§6：此时只做风险跟踪、不显示个人盈亏）
  let cost: number | null = null
  let realizedGain = 0

  for (const t of relevant) {
    switch (t.kind) {
      case 'subscribe':
        shares += requiredSharesDelta(t)
        // amount 流出为负，成本取其相反数（买入金额含申购费）
        cost = (cost ?? 0) - t.amount
        break
      case 'dividend_reinvest':
        // 按两步展开：先记一笔现金分红（金额 = 再投金额）进已实现收益，
        // 再按同额买入。合成一步会让成本与已实现收益同时走样
        realizedGain += t.amount
        shares += requiredSharesDelta(t)
        // 再投金额按符号约定为正；买入是支出，成本加同额
        cost = (cost ?? 0) + t.amount
        break
      case 'redeem': {
        const sold = -requiredSharesDelta(t)
        const sharesBefore = shares
        // 超赎只可能是流水漏记（先录了赎回、买入还没录）。放过去会让份额变负、
        // 同时按封顶成本给出一笔看着合理的已实现收益——错值当场就给出去了，
        // 等对账再发现已经晚了一步。容差内视为卖光：逐笔累计的浮点残差不算超赎
        if (sold > sharesBefore && !approxEqual(sold, sharesBefore)) {
          throw new TypeError(`赎回 ${sold} 份但账面只有 ${sharesBefore} 份，流水不完整：${t.id}`)
        }
        shares -= sold
        // 容差内卖光时浮点残差可能让份额略小于 0，归零
        if (shares < 0) shares = 0
        // 按比例结转，单位成本不变。若写成「成本扣掉回款」，单位成本就退化成
        // 摊薄成本：赎回后跟平台对不上时，分不清是记账错还是口径不同
        if (cost !== null && sharesBefore > 0) {
          // sold 已在容差内不超过 sharesBefore；取 min 只为吃掉浮点残差，
          // 不让结转额超过总成本
          const carriedCost = cost * (Math.min(sold, sharesBefore) / sharesBefore)
          cost -= carriedCost
          realizedGain += t.amount - carriedCost
        }
        // cost 为 null 时结转成本无从得知，这笔的已实现收益不计入而不是编数
        break
      }
      case 'dividend_cash':
        // 份额与成本都不动：现金离开基金，是已实现收益
        realizedGain += t.amount
        break
      case 'split':
        // 折算存的是比例，份额按比例乘。缺比例时无法推断，宁可报错也不当成 0 或 1
        if (t.splitRatio === null) {
          throw new TypeError(`split 流水缺 splitRatio，无法推导份额：${t.id}`)
        }
        // 总成本不变，单位成本随之按反比例变化
        shares *= t.splitRatio
        break
      default:
        // 运行时兜底：`fee` 已从类型里删掉，但旧数据或外部输入仍可能带它。
        // 静默把它当成本正是它被取消的原因，故显式报错
        throw new TypeError(
          `未知的流水 kind：${(t as { kind: string }).kind}（fee 已取消，费用请并入对应的 subscribe/redeem）：${t.id}`,
        )
    }
  }

  return {
    fundCode,
    asOf,
    shares,
    cost,
    // 份额为 0 时除零无意义。用容差而非 ===，残余浮点份额不算「有持仓」
    costPerShare: cost !== null && !approxEqual(shares, 0) ? cost / shares : null,
    realizedGain,
  }
}

/**
 * 申购 / 赎回 / 红利再投必须有份额增减量。缺了不能当 0——赎回缺份额会变成
 * 「赎回 0 份、整笔回款全进已实现收益」，凭空虚增收益（设计 §七「必填校验」）。
 */
function requiredSharesDelta(t: LedgerTransaction): number {
  if (t.sharesDelta === null) {
    throw new TypeError(`${t.kind} 流水缺 sharesDelta，无法推导份额与成本：${t.id}`)
  }
  return t.sharesDelta
}

/**
 * 同一天有多笔流水时，每笔都必须给 `sequence`，且同一天内不能重复。
 *
 * 不这样要求，推导就只能依赖入参顺序——而调用方多半是从数据库按 id 取出来的，
 * 顺序本就不保证。同一天的申购与份额折算换个顺序，份额会从 100 变成 200。
 *
 * @throws {TypeError} 同一天有多笔但缺 `sequence`，或同一天内 `sequence` 重复
 */
function assertSameDaySequence(transactions: readonly LedgerTransaction[]): void {
  const byDate = new Map<string, LedgerTransaction[]>()
  for (const t of transactions) {
    const list = byDate.get(t.date)
    if (list === undefined) byDate.set(t.date, [t])
    else list.push(t)
  }
  for (const [date, list] of byDate) {
    if (list.length < 2) continue
    const seen = new Set<number>()
    for (const t of list) {
      if (t.sequence === null) {
        throw new TypeError(
          `${date} 有 ${list.length} 笔流水，必须给 sequence（同日顺序不能靠入参顺序）：${t.id}`,
        )
      }
      if (seen.has(t.sequence)) {
        throw new TypeError(`${date} 有重复的 sequence ${t.sequence}：${t.id}`)
      }
      seen.add(t.sequence)
    }
  }
}
