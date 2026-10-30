// SmartModel 的公开 API：类型化的快速判断层和它的第一个用处（选型建议）。
export * from "./types.js";
export { SMART_MODEL_LIMITS, argmax, choiceConfidence, validateSmartAnswers, validateSmartInput } from "./questions.js";
export {
  createJevSmartModel, DEFAULT_JEV_MODEL, DEFAULT_JEV_TIMEOUT_MS, isValidJevModelName, JEV_BACKEND, JEV_ENDPOINT,
  jevRequestBody, parseJevResponse, type JevSmartModelOptions,
} from "./jev.js";
export {
  createLlmSmartModel, DEFAULT_LLM_TIMEOUT_MS, LLM_BACKEND, LLM_FIXED_CONFIDENCE, llmPrompt, parseLlmReply,
  type LlmSmartModelOptions, type SmartCompleteFn,
} from "./llm.js";
export { chainSmartModels, createSmartModel, type CreateSmartModelOptions, type DecisionModelCredentials } from "./factory.js";
export {
  appendDecisionLog, DECISION_LOG_MAX_BYTES, decisionPurpose, smartModelDecisionLogPath, withDecisionLog,
  type DecisionLogEntry, type DecisionLogOptions,
} from "./decision-log.js";
export { withCallObserver, type SmartModelCallObserver, type SmartModelCallRecord } from "./observe.js";
export * from "./route.js";
