// Jev 分诊的影子模式在 daemon 里的装配（Lead 事件主干 spec D12，工单 09）。批处理本身在 engine 的 triage-shadow.ts。
//
// 用哪个 SmartModel：只用决策模型（设置页「模型」，缺省 TypeSafe 的 Jev），不用 LLM 兜底。
//   - 影子分诊在后台对每个规则定不了的事件都问一次。LLM 兜底走 Lead 自己的模型和配额，会和 Lead 抢限流（429），
//     也会在后台一直花 token。
//   - 评估的是 Jev 的判断。LLM 的置信度是固定值（llm.ts 的 LLM_FIXED_CONFIDENCE），混进来会让一致率失真。
// 没有决策模型的 key 时 backend 是 "none"，影子分诊什么也不做。每次调用照常记决策日志（purpose 是 triage_shadow），
// 也照常写一条 decision_model.called 事件（工单 13，和 Lead 会话的 SmartModel 一样）：get_system_usage 的数字里有它。
import {
  createSmartModel, createTriageShadowRunner, smartModelDecisionLogPath, withCallObserver,
  type DecisionModelCredentials, type SmartModel, type SmartModelCallObserver, type TriageShadowRunner,
  type TriageShadowRunnerOptions,
} from "@pi-lead-child/engine";
import { recordDecisionModelCall, type Db } from "@pi-lead-child/store";

/** startDaemon 的 triageShadow 选项。false 关掉影子分诊。 */
export type TriageShadowDaemonOptions = false | (
  Pick<TriageShadowRunnerOptions, "batchSize" | "budgetMs" | "timeoutMs" | "idleIntervalMs" | "retryBaseMs" | "retryMaxMs"> & {
    // 测试注入的 SmartModel（后端的替身）。不给时按上面的规则建。注入的也套上调用记录，和真的一样进统计。
    smartModel?: SmartModel | null;
  }
);

export function startTriageShadow(input: {
  db: Db;
  dataDir: string;
  // 给某些事件加问的问题（工单 11：通道里别人发来的消息加问代你行动的问题，engine 的 ChannelHub.shadowQuestionsFor）。
  extraQuestions?: TriageShadowRunnerOptions["extraQuestions"];
  // 决策模型的配置和 key（memory-controller.ts）。没有托管记忆时是 null：没有决策模型。
  decisionModel: (() => DecisionModelCredentials | null) | null;
  log: (line: string) => void;
  options?: TriageShadowDaemonOptions;
}): TriageShadowRunner | null {
  if (input.options === false) return null;
  const { smartModel: injected, ...tuning } = input.options ?? {};
  // 每次调用写一条 decision_model.called 事件。写不进去只记一行日志，判断照常返回（照 Lead 的 session.ts）。
  // 这种事件写入时就有处置，不会成为影子分诊的候选（store 的 listTriageShadowCandidates）。
  const onCall: SmartModelCallObserver = (call) => {
    try {
      recordDecisionModelCall(input.db, call);
    } catch (error) {
      input.log(`[triage-shadow] decision_model.called not recorded: ${(error as Error).message}`);
    }
  };
  const smartModel = injected !== undefined ? (injected ? withCallObserver(injected, onCall) : null)
    : input.decisionModel
      ? createSmartModel({
          decisionModel: input.decisionModel,
          logPath: smartModelDecisionLogPath(input.dataDir),
          onCall,
          onNote: (note) => input.log(`[triage-shadow] ${note}`),
        })
      : null;
  return createTriageShadowRunner({
    db: input.db, smartModel: () => smartModel, log: input.log, ...tuning,
    ...(input.extraQuestions ? { extraQuestions: input.extraQuestions } : {}),
  });
}
