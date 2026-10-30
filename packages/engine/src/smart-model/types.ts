// SmartModel：快速的类型化判断层。一次调用 = 一段 state + 一组有名字的问题。
// 问题之间互相独立：后端对同一段 state 分别回答每个问题。
// 后端可以替换：Jev（TypeSafe 的托管模型）或者一个通用 LLM。工厂在 factory.ts。

/** 从一组选项里选一个。最多 255 个选项。 */
export interface ChoiceQuestion {
  type: "choice";
  prompt: string;
  options: readonly string[];
  /** 选项的说明，按选项名索引。可以只给一部分。 */
  descriptions?: Readonly<Record<string, string>>;
}

/** 按有序的档位打分。levels 从低到高，2 到 10 档。 */
export interface ScoreQuestion {
  type: "score";
  prompt: string;
  levels: readonly string[];
}

/** 是或否。回答是「是」的概率。 */
export interface YesNoQuestion {
  type: "yes_no";
  prompt: string;
  /** 什么情况算「是」、什么情况算「否」。可选。 */
  yes?: string;
  no?: string;
}

export type SmartQuestion = ChoiceQuestion | ScoreQuestion | YesNoQuestion;
export type SmartQuestionSet = Readonly<Record<string, SmartQuestion>>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  /** 0 到 1。由概率分布算出：(p_max − 1/n) / (1 − 1/n)。 */
  confidence: number;
  /** 每个选项的概率，键的顺序和问题里的选项顺序一致。 */
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  /** 最可能的档位（从 0 开始）。 */
  level: number;
  /** 这个档位在问题里的文字。 */
  label: string;
  /** 按概率加权的分数，可以落在两档之间。 */
  score: number;
  confidence: number;
  /** 每一档的概率，下标就是档位。 */
  probabilities: number[];
}

export interface YesNoAnswer {
  type: "yes_no";
  /** 回答是「是」的概率，0 到 1。 */
  probability: number;
}

export type SmartAnswer = ChoiceAnswer | ScoreAnswer | YesNoAnswer;

export type SmartAnswerFor<Q extends SmartQuestion> =
  Q extends ChoiceQuestion ? ChoiceAnswer
    : Q extends ScoreQuestion ? ScoreAnswer
      : YesNoAnswer;

export type SmartAnswers<Q extends SmartQuestionSet> = { [K in keyof Q]: SmartAnswerFor<Q[K]> };

export interface SmartDecideOptions {
  signal?: AbortSignal;
  /** 每个后端这一次调用的超时。不给时用后端自己的缺省值。 */
  timeoutMs?: number;
  /** 这次判断的用途，写进决策日志，例如 "route"。 */
  purpose?: string;
  /**
   * 只问决策模型（Jev 这一类），不落到 LLM 后端（issue 10：收件判断的 LLM 兜底是另写的一份，channels/intake-llm.ts）。
   * 没有配置决策模型时报 unconfigured。
   */
  decisionOnly?: boolean;
}

/** 后端放弃、改由下一个后端回答时记下的原因。 */
export interface SmartFallback {
  backend: string;
  error: string;
}

export interface SmartDecision<Q extends SmartQuestionSet> {
  answers: SmartAnswers<Q>;
  /** 回答这次调用的后端。 */
  backend: string;
  /** 后端报告的模型版本。不知道时为 null。 */
  model: string | null;
  latencyMs: number;
  /** 前面的后端失败、换了后端时，前面那个后端和它的错误。 */
  fallbackFrom: SmartFallback | null;
}

export interface SmartModel {
  /** 这个模型由哪些后端组成，例如 "jev" 或 "jev→llm"。 */
  readonly backend: string;
  decide<Q extends SmartQuestionSet>(
    state: string,
    questions: Q,
    opts?: SmartDecideOptions,
  ): Promise<SmartDecision<Q>>;
}

/**
 * 便宜模型的自由文本补全（不是类型化的判断）：给一段提示，返回模型写的文字。用在要模型写一段话、而不是回答几个问题的地方，
 * 例如把 Slack 线程整理成事实（channels/memory.ts，slack-takeover 工单 07）。
 * 每次调用带用途（purpose，规则同 decide）：提供方按它记一条 decision_model.called，get_system_usage 按用途统计。
 * 提示里的文字由调用方先脱敏、截断；返回的文字是不可信的，调用方存之前要再脱敏、限长。
 */
export type SmartTextComplete = (
  prompt: string,
  opts: { purpose: string; signal?: AbortSignal; maxTokens?: number },
) => Promise<string>;

/** 输入不合法：调用方的错，换后端也没用。 */
export class SmartModelInputError extends Error {}

/** 后端失败：网络、超时、限流、服务端错误或者回答不合法。可以换后端。 */
export class SmartModelBackendError extends Error {
  constructor(
    readonly backend: string,
    message: string,
    readonly kind: "network" | "timeout" | "http" | "invalid_answer" | "aborted" | "unconfigured",
    readonly status: number | null = null,
  ) {
    super(message);
  }
}
