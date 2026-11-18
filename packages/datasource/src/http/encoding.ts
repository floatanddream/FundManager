/**
 * 按 charset 解码响应体原始字节，并去掉 UTF-8 BOM。
 *
 * @param bytes 响应体原始字节
 * @param charset 响应声明的字符集；缺省 `utf-8`，大小写不敏感（如 `'GBK'` 亦可）
 * @returns 解码后的文本，已剥离开头的 UTF-8 BOM
 * @throws {RangeError} charset 不被本机 Node 支持（编码名拼错时早暴露，好过静默误解码）
 */
export function decodeBody(bytes: Uint8Array, charset?: string): string {
  // BOM 要在交给解码器之前按字节剥掉：TextDecoder('utf-8') 默认保留 BOM，
  // 会把 U+FEFF 留在字符串开头，让 JSON.parse 与正则匹配静默失败。
  // pingzhongdata 的 .js 实测就带 UTF-8 BOM，这条不是理论边界。
  const body =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes
  return new TextDecoder(charset ?? 'utf-8').decode(body)
}
