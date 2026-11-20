import { DataSourceError } from '@fundmanager/datasource'
/**
 * `core` 的 `TypeError` → HTTP 状态 + 用户看得懂的中文（设计 §八）。
 *
 * core 的报错是写给开发者的（「赎回 120 份但账面只有 100 份」），原样吐给用户
 * 看起来像系统故障而不是录入错误。映射表**只在这里**，路由里不要各写一遍。
 */

/** 已知错误：匹配 core 报错原文 → 可操作提示。顺序敏感，具体的在前 */
const KNOWN_ERRORS: readonly { readonly pattern: RegExp; readonly message: string }[] = [
  { pattern: /赎回 .+ 份但账面只有/, message: '这笔赎回超过了账面份额，请先补录买入' },
  { pattern: /必须给 sequence/, message: '同一天有多笔流水，需要指定先后顺序' },
  { pattern: /有重复的 sequence/, message: '同一天的顺序号重复了' },
  { pattern: /流水缺 (sharesDelta|splitRatio)/, message: '这笔记账缺少份额' },
]

const INTERNAL_ERROR = '服务器内部错误，请稍后重试'

/**
 * 把抛出的异常翻译成 HTTP 响应。
 *
 * 未知的 `TypeError` 仍按「入参/调用方写错」给 400 + 原文：不能吞掉，否则排障时
 * 只剩一句「内部错误」。非 `TypeError`（数据源故障等）一律 500，不把内部细节漏给前端。
 *
 * @returns `status` 与给用户看的 `message`
 */
export function toHttpError(e: unknown): { status: number; message: string } {
  // 数据源层的失败不是「服务端内部错误」：FundDataSource 抛的都是它自己那层的事
  // （代码不存在、上游挂了、解析失败）。一律 500 会和真正的 bug 混在一起，
  // 排障时看不出该查服务端还是查基金代码
  if (e instanceof DataSourceError) {
    return { status: 502, message: `取数失败：${e.message}` }
  }
  if (!(e instanceof TypeError)) return { status: 500, message: INTERNAL_ERROR }
  const known = KNOWN_ERRORS.find((k) => k.pattern.test(e.message))
  return { status: 400, message: known?.message ?? e.message }
}
