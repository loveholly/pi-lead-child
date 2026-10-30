// SmartModel 的调用记录（工单 13，spec D17）：每次 decide 结束时（成功或失败），交给调用方一条记录。
// Lead 的会话把它写成 decision_model.called 事件（store 的 recordDecisionModelCall）；get_system_usage 从那里汇总。
// 记录里只有用途、后端、模型、耗时、成败和失败原因：不带 state、问题和回答。
// 失败原因是后端的错误信息（和决策日志里的一样），写库前由 store 先截断再脱敏。
// 回调出错不影响判断本身：记录只用来统计。
import { decisionPurpose } from "./decision-log.js";
import { errorText } from "./deadline.js";
import {
  SmartModelBackendError,
  SmartModelInputError,
  type SmartDecideOptions,
  type SmartDecision,
  type SmartFallback,
  type SmartModel,
  type SmartQuestionSet,
} from "./types.js";

export interface SmartModelCallRecord {
  purpose: string;
  /** 回答的后端。全部失败时是整个模型的后端名，例如 jev→llm。 */
  backend: string;
  model: string | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  /** 后端失败的类型（SmartModelBackendError 的 kind）；输入不合法时是 input。成功时是 null。 */
  errorKind: SmartModelBackendError["kind"] | "input" | "error" | null;
  fallbackFrom: SmartFallback | null;
}

export type SmartModelCallObserver = (record: SmartModelCallRecord) => void;

function errorKind(error: unknown, opts: SmartDecideOptions): SmartModelCallRecord["errorKind"] {
  if (error instanceof SmartModelBackendError) return error.kind;
  if (error instanceof SmartModelInputError) return "input";
  return opts.signal?.aborted ? "aborted" : "error";
}

/** 给模型套上调用记录。每次 decide 调一次 onCall，成功和失败都调。 */
export function withCallObserver(model: SmartModel, onCall: SmartModelCallObserver): SmartModel {
  const report = (record: SmartModelCallRecord): void => {
    try {
      onCall(record);
    } catch {
      // 记录只用来统计，不能挡住判断本身。
    }
  };
  return {
    // getter：决策模型的 key 可能在会话中途加上或者删掉。
    get backend() {
      return model.backend;
    },
    async decide<Q extends SmartQuestionSet>(state: string, questions: Q, opts: SmartDecideOptions = {}): Promise<SmartDecision<Q>> {
      const started = Date.now();
      const purpose = decisionPurpose(opts.purpose);
      let decision: SmartDecision<Q>;
      try {
        decision = await model.decide(state, questions, opts);
      } catch (error) {
        report({
          purpose, backend: model.backend, model: null, latencyMs: Date.now() - started,
          ok: false, error: errorText(error), errorKind: errorKind(error, opts), fallbackFrom: null,
        });
        throw error;
      }
      report({
        purpose, backend: decision.backend, model: decision.model, latencyMs: decision.latencyMs,
        ok: true, error: null, errorKind: null, fallbackFrom: decision.fallbackFrom,
      });
      return decision;
    },
  };
}
