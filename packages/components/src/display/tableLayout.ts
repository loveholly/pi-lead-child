// 表格的列宽和对齐，DataTable 的调用方用它们算 columnWidths 和 align（Markdown 表格和 genui 的表格共用）。

const NUMBER = /^[-+]?(\d[\d,]*)(\.\d+)?\s?(%|ms|s|KB|MB|GB|kB|万|亿|k|K|M)?$/;
const PLACEHOLDER = /^([-–—]+|n\/a|N\/A)$/;

/** 一列的格子（去掉空格和占位符以后）都是数字时，这一列右对齐、用等宽字。 */
export function isNumericColumn(values: readonly string[]): boolean {
  const filled = values.map((value) => value.trim()).filter((value) => value && !PLACEHOLDER.test(value));
  return filled.length > 0 && filled.every((value) => NUMBER.test(value));
}

// 原生没有表格布局：按每一列最长的内容估一个列宽，所有行用同一组列宽。汉字按 13px 字宽算，其余按 7.5px。
export function estimatedTextWidth(text: string): number {
  let pixels = 0;
  for (const char of text) pixels += /[　-鿿＀-￯]/u.test(char) ? 13 : 7.5;
  return pixels;
}

/** 按一列最宽的文字算列宽：加上左右留白，限制在 64 到 360 之间。 */
export function tableColumnWidth(widestText: number): number {
  return Math.round(Math.min(360, Math.max(64, widestText + 30)));
}
