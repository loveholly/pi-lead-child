// 假的 SmartModel（Slack 代查与按信心代回 工单 04）：给通道 hub 和 daemon 的场景测试用。
//   - scriptedSmartModel：按问题名回答。没写的问题按用途给保守的缺省（不紧急、不是请求、没有敏感、核对通过、没有回答对方）。
//     llm: true 时像 LLM 兜底一样：选择题的置信度固定 0.6，是否题只有 0.8 和 0.2（packages/engine/src/smart-model/llm.ts）。
//     选择题也可以给每个选项的概率（像真的后端那样的分布）：选最大的那个，置信度按分布算。
//     每次调用记下用途、状态文本和问题名。问题集先按真的后端的规则校验（validateSmartInput），不合法时和 Jev 一样抛错。
//   - 收件判断第 7 版（2026-10-30）问交接说明里的一句（situation），不再问意图（ask_kind）。按意图写回答的测试照常能用：
//     没写 situation、写了 ask_kind 时，意图换成缺省交接说明里对应的第一句（protocol 的 AUTHORITY_INTENT_SITUATIONS）；
//     涉密没有对应的句子，换成兜底的一句（涉密由敏感查询认出）。
import { AUTHORITY_INTENT_SITUATIONS, HANDBOOK_FALLBACK_ID, isChannelIntent, type LookupResult } from "@pi-lead-child/protocol";
import { choiceConfidence, validateSmartInput, type SmartAnswer, type SmartDecideOptions, type SmartModel, type SmartQuestion } from "../../src/index.js";

type ScriptedValue = string | number | Readonly<Record<string, number>>;
type Scripted = ScriptedValue | ((state: string) => ScriptedValue);

export interface ScriptedSmartModelOptions {
  backend?: string;
  // 按问题名回答：选择题给选项名（或者每个选项的概率），是否题给「是」的概率，打分题给档位。
  answers?: Record<string, Scripted>;
  // 选择题的置信度。缺省 0.95。
  confidence?: number;
  // 像 LLM 兜底一样回答（置信度固定）。
  llm?: boolean;
  // 让这些用途的调用失败（例如模拟 Jev 和 LLM 都不可用）。
  failPurposes?: readonly string[];
}

const DEFAULTS: Record<string, Scripted> = {
  needs_user_now: 0.05,
  situation: HANDBOOK_FALLBACK_ID,
  target_repo: "none",
  // 请求 A 第 4 版：收尾的种类（意图是收尾时才用）、要回表情时回哪个。
  closing_kind: "remark",
  reaction_emoji: "smile",
  // 请求 B（reply-check.ts）：做到了所求、有依据。
  fulfills_request: 0.95,
  grounded: 0.95,
  draft_commits: 0.02,
  draft_overshares: 0.02,
  answers_request: 0.1,
  // 代查开始时问的「正在处理」的动作词（disclosure.ts 的 HANDLING_VERBS）。
  handling_verb: "checking",
  // 请求 A：这条消息要不要用户回。缺省要回（测试里的消息大多要开卡）。
  needs_reply: 0.9,
  // 请求 A 第 6 版：对方没有要求改规则。
  rule_change: "none",
  // 第 8 版（issue 05）：对方没有要借你的权限。
  borrowed_access: 0.02,
};

export interface ScriptedSmartModel extends SmartModel {
  calls: Array<{ purpose: string | undefined; state: string; names: string[] }>;
  // 这个用途被调用了几次。
  count(purpose: string): number;
}

export function scriptedSmartModel(options: ScriptedSmartModelOptions = {}): ScriptedSmartModel {
  const backend = options.backend ?? (options.llm ? "llm" : "fake-jev");
  const calls: ScriptedSmartModel["calls"] = [];
  const scripted = (given: Scripted | undefined, state: string): ScriptedValue | undefined => (typeof given === "function" ? given(state) : given);
  const situationOfIntent = (intent: string): string => (isChannelIntent(intent) ? AUTHORITY_INTENT_SITUATIONS[intent][0] : undefined) ?? HANDBOOK_FALLBACK_ID;
  const valueOf = (name: string, state: string): ScriptedValue | undefined => {
    if (name === "situation" && options.answers?.situation === undefined && options.answers?.ask_kind !== undefined) {
      const intent = scripted(options.answers.ask_kind, state);
      if (typeof intent === "string") return situationOfIntent(intent);
      if (intent && typeof intent === "object") {
        const shares: Record<string, number> = {};
        for (const [kind, share] of Object.entries(intent)) shares[situationOfIntent(kind)] = (shares[situationOfIntent(kind)] ?? 0) + share;
        return shares;
      }
    }
    return scripted(options.answers?.[name] ?? DEFAULTS[name], state);
  };
  return {
    backend,
    calls,
    count: (purpose) => calls.filter((call) => call.purpose === purpose).length,
    async decide(state: string, questions: Readonly<Record<string, SmartQuestion>>, opts?: SmartDecideOptions) {
      calls.push({ purpose: opts?.purpose, state, names: Object.keys(questions) });
      if (opts?.purpose && options.failPurposes?.includes(opts.purpose)) throw new Error(`${backend}: unavailable for ${opts.purpose}`);
      validateSmartInput(state, questions);
      const answers: Record<string, SmartAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        const value = valueOf(name, state);
        if (question.type === "choice" && value && typeof value === "object") {
          const probabilities = Object.fromEntries(question.options.map((option) => [option, value[option] ?? 0]));
          const choice = question.options.reduce((best, option) => (probabilities[option]! > probabilities[best]! ? option : best));
          answers[name] = { type: "choice", choice, confidence: choiceConfidence(question.options.map((option) => probabilities[option]!)), probabilities };
        } else if (question.type === "choice") {
          const choice = typeof value === "string" && question.options.includes(value) ? value : question.options.includes("other") ? "other" : question.options.at(-1)!;
          answers[name] = { type: "choice", choice, confidence: options.llm ? 0.6 : options.confidence ?? 0.95, probabilities: {} };
        } else if (question.type === "yes_no") {
          const probability = typeof value === "number" ? value : name.startsWith("query_") || name.startsWith("topic_") ? 0.02 : 0.1;
          answers[name] = { type: "yes_no", probability: options.llm ? (probability >= 0.5 ? 0.8 : 0.2) : probability };
        } else {
          const level = Math.min(Math.max(typeof value === "number" ? Math.trunc(value) : 0, 0), question.levels.length - 1);
          answers[name] = {
            type: "score", level, label: question.levels[level]!, score: level, confidence: options.llm ? 0.6 : 0.9,
            probabilities: question.levels.map((_label, index) => (index === level ? 1 : 0)),
          };
        }
      }
      return { answers: answers as never, backend, model: options.llm ? "llm-test" : "jev-test", latencyMs: 1, fallbackFrom: null };
    },
  };
}

/** 一个查到了的结果（出处已核实）。 */
export function foundLookupResult(overrides: Partial<LookupResult> = {}): LookupResult {
  return {
    found: "yes",
    answer: "重试最多等 10 分钟（MAX_DELAY_MS = 600_000）。",
    sources: [{ via: "local", repo: "acme/orders", path: "src/retry.ts", startLine: 1, endLine: 1, quote: "MAX_DELAY_MS = 600_000", verified: true }],
    checked: ["acme/orders 的 src/retry.ts"],
    caveats: [],
    replyDraft: "重试最多等 10 分钟，见 src/retry.ts 的 MAX_DELAY_MS。",
    ...overrides,
  };
}

