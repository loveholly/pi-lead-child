// token 的粗略估算，不用分词器：各家模型的分词器不同，也不为估算加依赖。只用来定预算和截断位置，不用来计费。
// 规则：中日韩文字每个字算 1 个 token，其他字符每 4 个算 1 个 token，合计向上取整。
// 按码位计数：代理对（emoji、扩展 B 以后的汉字）算一个字符，截断不会切在代理对中间。

// 按 1 个 token 算的码位：中日韩统一表意文字和各扩展区、兼容表意文字、日文假名、韩文音节、全角标点。
export function isCjkCodePoint(cp: number): boolean {
  return (cp >= 0x3000 && cp <= 0x30ff)    // 中日韩符号和标点（、。「」等）、平假名、片假名
    || (cp >= 0x31f0 && cp <= 0x31ff)      // 片假名音标扩展
    || (cp >= 0x3400 && cp <= 0x4dbf)      // 扩展 A
    || (cp >= 0x4e00 && cp <= 0x9fff)      // 统一表意文字
    || (cp >= 0xac00 && cp <= 0xd7af)      // 韩文音节
    || (cp >= 0xf900 && cp <= 0xfaff)      // 兼容表意文字
    || (cp >= 0xfe30 && cp <= 0xfe4f)      // 中日韩兼容形式（竖排标点）
    || (cp >= 0xff00 && cp <= 0xffef)      // 半角和全角形式（全角标点、半角片假名）
    || (cp >= 0x20000 && cp <= 0x323af);   // 扩展 B 到 I、兼容表意文字补充
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCjkCodePoint(char.codePointAt(0)!)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

// 把 UTF-16 下标移到码位的开头：落在代理对的后半个上时，退回前半个。
export function alignToCodePoint(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.min(Math.max(0, index), text.length);
  const low = text.charCodeAt(index);
  const high = text.charCodeAt(index - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? index - 1 : index;
}

// 从 start 起，估算不超过 maxTokens 的最长一段，返回它的结束位置（UTF-16 下标，不含）。
// 结束位置总在码位的边界上。一个字符最多算 1 个 token，所以 maxTokens >= 1 时至少前进一个字符。
export function tokenSliceEnd(text: string, start: number, maxTokens: number): number {
  let index = alignToCodePoint(text, start);
  let cjk = 0;
  let other = 0;
  while (index < text.length) {
    const cp = text.codePointAt(index)!;
    const isCjk = isCjkCodePoint(cp);
    const tokens = cjk + (isCjk ? 1 : 0) + Math.ceil((other + (isCjk ? 0 : 1)) / 4);
    if (tokens > maxTokens) break;
    if (isCjk) cjk += 1;
    else other += 1;
    index += cp > 0xffff ? 2 : 1;
  }
  return index;
}
