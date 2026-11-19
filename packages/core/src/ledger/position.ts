import { approxEqual, assertDate } from '@fundmanager/shared'
import type { LedgerPosition, LedgerTransaction } from './types.ts'

/**
 * 从流水推导某只基金在某日的持仓：份额、成本、已实现收益。
 *
 * 纯函数：不读时钟、不做 IO，`asOf` 由调用方给。只吃 `status === 'confirmed'`
 * 的流水——待确认流水被算进持仓就是静默算错账，这条是契约而非优化。
 *
 * 成本按移动加权平均：赎回按比例结转（单位成本不变），现金分红只进已实现收益，
 * 红利再投拆成「分红 + 按再投金额买入」两步。
 *
 * @param transactions 流水，顺序任意；可含其他基金与其他账本
 * @param fundCode 要推导的基金代码
 * @param asOf 截止日（含当日），`YYYY-MM-DD`
 * @returns 持仓；没有买入记录时 `cost` / `costPerShare` 为 null（成本未知），
 *   份额为 0 时 `costPerShare` 为 null
 * @throws {TypeError} 任一日期不是合法的 `YYYY-MM-DD`，或 `split` 缺折算比例
 */
export function derivePosition(
  transactions: readonly LedgerTransaction[],
  fundCode: string,
  asOf: string,
): LedgerPosition {
  assertDate(asOf, 'asOf')

  const relevant: LedgerTransaction[] = []
  for (const t of transactions) {
    if (t.status !== 'confirmed' || t.fundCode !== fundCode) continue
    // 先校验再比较：非法日期按字典序会被静默归入「截止日之前」或之后，
    // 份额随之算错。只校验真正参与推导的流水，其他基金的坏数据不牵连本基金
    assertDate(t.date, 'LedgerTransaction.date')
    if (t.date <= asOf) relevant.push(t)
  }
  // 日期定长 YYYY-MM-DD，字典序即时间序。同日多笔保持入参顺序（sort 稳定），
  // 故同日内不要放相互依赖的事件（如先分红再按分红额再投），顺序无从保证
  relevant.sort((a, b) => a.date.localeCompare(b.date))

  let shares = 0
  // null 表示成本未知（从未有过买入记录）。不用 0 冒充——上层会把 0 当成真实成本
  // 去算盈亏（§6：此时只做风险跟踪、不显示个人盈亏）
  let cost: number | null = null
  let realizedGain = 0

  for (const t of relevant) {
    switch (t.kind) {
      case 'subscribe':
        shares += t.sharesDelta ?? 0
        // amount 流出为负，成本取其相反数（买入金额含申购费）
        cost = (cost ?? 0) - t.amount
        break
      case 'dividend_reinvest':
        // 按两步展开：先记一笔现金分红（金额 = 再投金额）进已实现收益，
        // 再按同额买入。合成一步会让成本与已实现收益同时走样
        realizedGain += t.amount
        shares += t.sharesDelta ?? 0
        // 再投金额按符号约定为正；买入是支出，成本加同额
        cost = (cost ?? 0) + t.amount
        break
      case 'redeem': {
        const sold = -(t.sharesDelta ?? 0)
        const sharesBefore = shares
        shares -= sold
        // 按比例结转，单位成本不变。若写成「成本扣掉回款」，单位成本就退化成
        // 摊薄成本：赎回后跟平台对不上时，分不清是记账错还是口径不同
        if (cost !== null && sharesBefore > 0) {
          // 赎出份额超过账面份额只可能是流水漏记；按比例结转会算出比总成本还大的
          // 结转额、把成本变成负数，故封顶在总成本
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
      case 'fee':
        // 费用计入买卖成本（amount 为负，故成本增加）。还没有任何买入记录时
        // 无处归集，忽略它——凭空造出成本比不记更错
        if (cost !== null) cost -= t.amount
        break
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
