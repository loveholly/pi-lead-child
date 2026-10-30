import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SmartModel, SmartTextComplete } from "@pi-lead-child/engine";

// Lead 依赖的是一个很小的会话端口，而不是具体的 Pi/Prime 宿主。
// 领域状态、工具权限和生命周期仍由 PLC 持有；未来可替换 SDK adapter，
// 但不能让另一个宿主接管工单事实。
// clearQueue 是可选的：一轮失败以后，daemon 用它清掉 pi 队列里还没送出去的插话和跟进，
// 由 daemon 自己重新送（等重试或给「重发」），不然下一次 prompt 会把它们再送一次（发布评审 f796c1c 的 B2）。
// abort 也是可选的：daemon 停机时先用它中断正在跑的一轮，等这一轮正常收尾，再 dispose。
// pi 的 dispose 会同时丢掉全部监听，只调 dispose 时 daemon 收不到中断，这一轮被记成「没有回复」（2026-10-16）。
// abortCompaction 也是可选的：上下文压缩超过时限时，daemon 用它中止这次压缩，按失败处理（spec D9）。
// compact 也是可选的：自动压缩失败以后，daemon 在下一轮开始以前用它压缩一次，带上长度预算（2026-10-28）。
export type LeadEngine = Pick<
  AgentSession,
  "sessionId" | "prompt" | "steer" | "followUp" | "subscribe" | "dispose"
> & Partial<Pick<AgentSession, "clearQueue" | "abort" | "abortCompaction" | "compact">>;

export interface LeadEngineFactoryResult {
  session: LeadEngine;
  modelName: string;
  syncToolAccess?: () => void;
  // 在正在运行的会话里重新加载扩展（例如 SoL-Pi 刚装好），会话和上下文不变。只能在 Lead 空闲时调。
  reloadExtensions?: () => Promise<void>;
  // Lead 可以用的模型，按 lead.models 的顺序，第一个是正在用的（spec D9 的模型切换）。没有时 daemon 不自动换模型。
  models?: string[];
  // 在正在运行的会话里换模型（pi 的 setModel），不改 config.json，不重启。只能在 Lead 空闲时调。
  switchModel?: (spec: string) => Promise<void>;
  // 会话把一条用户消息送进模型的上下文时发 message_start（role=user，内容是交给 steer、followUp 的原文），
  // 和 pi 一样（工单 04）。daemon 据此知道插话和排队消息什么时候送到。没有时 daemon 按 Lead 开口的时刻推断。
  reportsInputDelivery?: boolean;
  // 这个会话的 SmartModel（smart-model.ts：Jev 优先，LLM 兜底；带决策日志和 decision_model.called 事件）。
  // daemon 也用它做别的快速判断：工单 agent 的回复在问你要不要做哪几个动作（ticket-reply-actions.ts），
  // 通道里别人发来的消息紧不紧急（engine 的 channels/urgency.ts）。建不出来时为 null 或者没有，这些判断都按保守的结果处理。
  smartModel?: SmartModel | null;
  // 同一个便宜模型的自由文本补全（smart-model.ts）：要模型写一段话时用，例如把订阅频道的 Slack 线程整理成事实笔记
  // （engine 的 channels/memory.ts，slack-takeover 工单 07）。每次调用记一条 decision_model.called（带调用方的 purpose）。
  // 没有 LLM 后端时为 null 或者没有：用它的功能跳过。
  complete?: SmartTextComplete | null;
  // SmartModel 的 LLM 后端缺省用的模型（设置 → 模型显示「都用不了时问大脑的哪个模型」）。没有时为 null 或者没有。
  smartModelLlm?: string | null;
  // 大脑现在能不能用：正在用的模型有认证（首次启动引导，.scratch/onboarding）。没有时 daemon 当作能用。
  brainReady?: () => Promise<boolean>;
  // 按 config.json 现在的 lead.providers 重新注册（设置 → 模型改了服务商）。没有时要重启 daemon 才生效。
  refreshProviders?: () => Promise<void>;
}
