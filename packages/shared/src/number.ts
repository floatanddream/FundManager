/**
 * 近似相等。float64 下金额、净值、份额一律用它比较，禁止 `===`。
 *
 * 同时判断绝对误差与相对误差：账本累加若干笔后误差随数值量级增长，
 * 只用绝对容差会把本该相等的两个金额误判为不等，导致对账天天报警。
 *
 * @param a 待比较的数值
 * @param b 待比较的数值
 * @param eps 容差，默认 1e-9
 * @returns 两数在容差内相等返回 true；任一为 NaN 或 ±Infinity 返回 false
 */
export function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  // 非有限数之间谈不上「近似相等」，直接判否，避免 NaN 参与比较后返回 false 的偶然正确
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const diff = Math.abs(a - b)
  return diff <= eps || diff <= eps * Math.max(Math.abs(a), Math.abs(b))
}
