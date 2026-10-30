// 决策日志：每次 SmartModel 调用追加一行 JSONL。以后用它做影子评估：比较建议和实际的选择。
// 日志里只有用途、后端、耗时、问题名、回答和错误。不写 state 原文，也不写密钥。
// 文件超过上限时轮转成 decisions.jsonl.1（覆盖旧的那一份），所以磁盘上最多两份。
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorText } from "./deadline.js";
import type {
  SmartAnswer,
  SmartDecideOptions,
  SmartDecision,
  SmartFallback,
  SmartModel,
  SmartQuestionSet,
} from "./types.js";

export const DECISION_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function smartModelDecisionLogPath(dataDir: string): string {
  return join(dataDir, "smart-model", "decisions.jsonl");
}

export interface DecisionLogEntry {
  at: string;
  purpose: string;
  /** 回答的后端。全部失败时是整个模型的后端名。 */
  backend: string;
  model: string | null;
  latencyMs: number;
  questions: string[];
  answers: Record<string, SmartAnswer> | null;
  fallbackFrom: SmartFallback | null;
  error: string | null;
}

export interface DecisionLogOptions {
  path: string;
  maxBytes?: number;
  now?: () => Date;
}

const PURPOSE = /^[a-z][a-z0-9_.-]{0,39}$/;

/** 写进日志和事件的用途：不合法或者没给时是 unspecified。 */
export function decisionPurpose(purpose: string | undefined): string {
  return purpose && PURPOSE.test(purpose) ? purpose : "unspecified";
}

/** 追加一行。写不进去时不抛错：日志只用来评估，不能挡住判断本身。 */
export function appendDecisionLog(path: string, entry: DecisionLogEntry, maxBytes = DECISION_LOG_MAX_BYTES): void {
  try {
    const line = `${JSON.stringify(entry)}\n`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // 文件还不存在。
    }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // 日志写失败只影响以后的评估。
  }
}

/** 给模型套上决策日志。每次 decide 记一行，成功和失败都记。 */
export function withDecisionLog(model: SmartModel, options: DecisionLogOptions): SmartModel {
  const now = options.now ?? (() => new Date());
  return {
    // getter：决策模型的 key 可能在会话中途加上或者删掉。
    get backend() {
      return model.backend;
    },
    async decide<Q extends SmartQuestionSet>(state: string, questions: Q, opts: SmartDecideOptions = {}): Promise<SmartDecision<Q>> {
      const started = Date.now();
      const purpose = decisionPurpose(opts.purpose);
      const names = questions && typeof questions === "object" ? Object.keys(questions) : [];
      try {
        const decision = await model.decide(state, questions, opts);
        appendDecisionLog(options.path, {
          at: now().toISOString(),
          purpose,
          backend: decision.backend,
          model: decision.model,
          latencyMs: decision.latencyMs,
          questions: names,
          answers: decision.answers as Record<string, SmartAnswer>,
          fallbackFrom: decision.fallbackFrom,
          error: null,
        }, options.maxBytes);
        return decision;
      } catch (error) {
        appendDecisionLog(options.path, {
          at: now().toISOString(),
          purpose,
          backend: model.backend,
          model: null,
          latencyMs: Date.now() - started,
          questions: names,
          answers: null,
          fallbackFrom: null,
          error: errorText(error),
        }, options.maxBytes);
        throw error;
      }
    },
  };
}
