// 数字的写法：千分位，最多两位小数。表格、指标和条形图都用它。
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** 数字加单位，例如「31 次」。没有单位时只写数字。 */
export function withUnit(value: number, unit: string | undefined): string {
  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}
