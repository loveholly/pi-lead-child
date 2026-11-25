// 开一轮以前要不要先压缩上下文（工单「夜间挂起风暴」，2026-11-24）。
//
// 以前 daemon 只在「上一次自动压缩失败了」时才在开一轮以前补压缩（compactionDue）。那天夜里空闲车道的压缩 4 次都因为
// 机器睡眠超时失败，退避越来越长；上下文从 70% 一路涨，没有人在开一轮以前看一眼，最后到了窗口的 111%。
// 现在开一轮以前按现在的用量判断：
//   · 已经超过窗口（ratio ≥ 1）：这一轮不压缩就答不了，按 overflow 补，不看压缩失败的退避；
//   · 过了压缩线（ratio ≥ thresholdRatio）：按 threshold 补（压缩刚失败过时照旧退避）；
//   · 上一次自动压缩失败留下的 due 照旧（取更紧的那一种）。
// 不知道用量（ratio 为 null，例如刚压缩完还没有新的回答）时只看留下的 due。

export type CompactionDue = "threshold" | "overflow";

export function compactionBeforeTurn(input: {
  due: CompactionDue | null;
  ratio: number | null;
  thresholdRatio: number | null;
}): CompactionDue | null {
  const { due, ratio, thresholdRatio } = input;
  if (due === "overflow") return "overflow";
  if (ratio !== null && Number.isFinite(ratio)) {
    if (ratio >= 1) return "overflow";
    if (thresholdRatio !== null && thresholdRatio > 0 && ratio >= thresholdRatio) return "threshold";
  }
  return due;
}
