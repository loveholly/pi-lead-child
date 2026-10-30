// 通道框架（Lead 事件主干 spec D14，工单 11）的公开出口。内核（hub、闸门、投递、出站）不出现任何具体来源的名字；
// 来源插件在 sources/ 下，装配在 builtin.ts。
export * from "./types.js";
export * from "./registry.js";
export * from "./authority.js";
export * from "./handbook-decision.js";
export * from "./handbook-suggestions.js";
export * from "./delegation-gate.js";
export * from "./delivery.js";
export * from "./outbound.js";
export * from "./hub.js";
export * from "./inbound.js";
export * from "./context-pack.js";
export * from "./payload.js";
export * from "./urgency.js";
export * from "./memory.js";
export * from "./intake.js";
export * from "./intake-llm.js";
export * from "./reply-check.js";
export * from "./reply-gate.js";
export * from "./reply-decision.js";
export * from "./confidence-model.js";
export * from "./timer-decision.js";
export * from "./calibration.js";
export * from "./disclosure.js";
export * from "./self-reply.js";
export * from "./lookup-dto.js";
export * from "./policy.js";
