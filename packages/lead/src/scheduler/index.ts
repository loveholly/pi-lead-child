// Lead 调度器（lead-scheduler spec）。决策层 core.ts，控制层 controller.ts，运行层 runtime.ts，pi extension extension.ts。
export * from "./lanes.js";
export * from "./controller.js";
export * from "./core.js";
export * from "./placement.js";
export * from "./runtime.js";
export { leadSchedulerExtension, stepLine, stepUsage, STAGE_A_WARN_MS, type LeadSchedulerExtensionOptions, type LeadSchedulerHooks, type LeadStepTiming, type LeadStepUsage } from "./extension.js";
export * from "./handoff-package.js";
export * from "./handoffs.js";
export * from "./budget-status.js";
export * from "./idle-lane.js";
export * from "./idle-compaction.js";
export * from "./clock-gap.js";
export {
  IdleLaneRuntime, idleLaneExtension, IDLE_APPLY_INSTRUCTIONS, IDLE_PROBE_INSTRUCTIONS,
  type IdleLaneHost, type IdleLaneRuntimeOptions, type ManualCompactRefusal, type ManualCompactReport, type ManualCompactTicket, type PrecipitationOutcome,
} from "./idle-runtime.js";
