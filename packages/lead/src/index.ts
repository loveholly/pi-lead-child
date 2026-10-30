// @pi-lead-child/lead 的公开 API。其他包只能从这里引用本包。
export * from "./channel-tools.js";
export * from "./connection-tools.js";
export * from "./engine.js";
export * from "./envelope.js";
export * from "./hands.js";
export * from "./lookup/index.js";
export * from "./agent-task/index.js";
// 认 PR 引用的语法（daemon 把 findPullRequestRef 交给通道 hub，slack-takeover 工单 06）。
export { findPullRequestRef, parsePullRequestRef, type PullRequestRef } from "./templates/pr-review.js";
export * from "./environment.js";
export * from "./model-config.js";
export * from "./model-failover.js";
export * from "./model-switch.js";
export * from "./precipitate.js";
export * from "./compaction-settings.js";
export * from "./cost-signals.js";
export { renderLeadSystemPrompt } from "./prompt.js";
export * from "./session.js";
export * from "./situation.js";
export * from "./smart-model.js";
export * from "./tools.js";
export { LEAD_CODEMODE_TOOLS, LEAD_CODEMODE_TOOL_GROUPS } from "./tool-exposure.js";
export * from "./turn-origin.js";
export * from "./wait-tools.js";
export * from "./ui-action-tools.js";
export { ticketRunAnnotation } from "./read-tools.js";
export * from "./overflow.js";
