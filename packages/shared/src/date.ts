const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000

/**
 * 断言是合法的 YYYY-MM-DD，合法则原样返回。
 * 业务代码只许用这一天格式——带时间的字符串会让日期静默错位（见 §8.2）。
 *
 * @param value 待校验的日期字符串
 * @param label 出错时用于定位的字段名，默认 `date`
 * @returns 原样返回 value
 * @throws {TypeError} 格式不是 YYYY-MM-DD，或是不存在的日期（如 2024-02-31）
 */
export function assertDate(value: string, label = 'date'): string {
  if (!DATE_PATTERN.test(value)) {
    throw new TypeError(`${label} 必须是 YYYY-MM-DD 格式，收到：${value}`)
  }
  // 显式补 UTC。Date.parse 对纯日期按 UTC 解释、对带时间字符串按本地解释，
  // 两者相差 8 小时，会让日期静默错位一天
  const parsed = new Date(`${value}T00:00:00Z`)
  // 回读比对：正则挡不住 2024-02-31 这类不存在的日期，
  // JavaScript 会把它悄悄滚到 3 月 2 日而不报错
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} 不是真实存在的日期：${value}`)
  }
  return value
}

/** 两个 YYYY-MM-DD 之间相差的天数（后者减前者），逆序为负。 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${assertDate(from, 'from')}T00:00:00Z`)
  const b = Date.parse(`${assertDate(to, 'to')}T00:00:00Z`)
  return (b - a) / MS_PER_DAY
}
