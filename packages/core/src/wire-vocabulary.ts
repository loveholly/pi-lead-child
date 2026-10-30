// ── 内部词汇 ↔ 线上词汇的唯一翻译层 ─────────────────────────────────────────────
//
// v16 之后，DB 与 src/** 一律讲 item / run / stage / finished / failed。
// 线上契约（packages/protocol）仍讲 ticket / attempt / status / settled / crashed：
// 那是已发布的字节形状，apps/companion 有 95 处消费它，
// test/kernel-protocol-contract.test.ts 逐字节冻结着它。
//
// 字段名的翻译发生在各投影函数里（它们本来就在逐字段构造 DTO，多一层包装只会更难读）；
// **值**的翻译集中在这里——值散落在 if/switch/数组字面量里，散着写必然漏，
// 漏掉的那一处会安静地把一个非法状态送上线。
//
// 要收敛两套词汇，只能等 protocol v3 一起改；在那之前，这里的每一次转换都是有意的。

import type { AttemptState, KernelAttemptPurpose } from "@pi-lead-child/protocol";
import type { Run, RunPurpose } from "./types.js";

type RunState = Run["state"];

// 只有终态两个值不同名；其余四个（starting/running/paused/stopped）两侧一致。
const TO_WIRE: Record<RunState, AttemptState> = {
  starting: "starting",
  running: "running",
  paused: "paused",
  finished: "settled",
  failed: "crashed",
  stopped: "stopped",
};

const FROM_WIRE: Record<AttemptState, RunState> = {
  starting: "starting",
  running: "running",
  paused: "paused",
  settled: "finished",
  crashed: "failed",
  stopped: "stopped",
};

/** 内部 Run.state → 线上 AttemptState。出站投影用。 */
export function toWireAttemptState(state: RunState): AttemptState {
  return TO_WIRE[state];
}

/** 线上 AttemptState → 内部 Run.state。入站（HTTP 查询、命令参数）用。 */
export function fromWireAttemptState(state: AttemptState): RunState {
  return FROM_WIRE[state];
}

// 库里的 outcome_repair（成果修复回合，spec D4）不是线上契约的值。
// 修复回合延续的是一次执行，所以出站时报成 execution。Run 的 metadata.outcomeRepair 记着它修的是哪个 Run。
// lookup（代查，slack-takeover spec D5）也不是线上契约的值：线上的 purpose 是冻结的封闭联合，旧客户端拒收新值。
// 代查工单上的 Run 做的就是这张工单的事，所以出站时也报成 execution。
const PURPOSE_TO_WIRE: Record<RunPurpose, KernelAttemptPurpose> = {
  execution: "execution",
  review: "review",
  integration: "integration",
  learning: "learning",
  conversation: "conversation",
  outcome_repair: "execution",
  lookup: "execution",
};

/** 内部 RunPurpose → 线上 KernelAttemptPurpose。出站投影用。 */
export function toWireAttemptPurpose(purpose: RunPurpose): KernelAttemptPurpose {
  return PURPOSE_TO_WIRE[purpose];
}
