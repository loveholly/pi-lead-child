// 选型建议（suggest_route）：给一段 brief，建议 runtime、模型、effort、要不要独立核查、任务类型。
// 只是建议，不改任何状态。先按硬规则筛候选，再让 SmartModel 在剩下的候选里判断。
// 硬规则：
//   - 可执行文件找不到的 runtime 不要；
//   - 用户在设置里停用的 runtime 不要（2026-10-19）；
//   - 健康账本里整个 profile 不可用、或者正在冷却（degraded，还没到恢复时间）的 runtime 不要，模型级不可用的模型不要；
//   - reviewer 不排除任何 runtime（2026-10-20）：能做可执行只读核查的（capabilities.executableReadOnlyReview）排在前面。
// 每一项排除都写明原因（excluded）：2026-10-19 10:57 的建议没有排除已经停用的 codex，结果里也看不出为什么。
// runtime 的名字、模型和能力全部来自目录数据（runtime-catalog、model-catalog），这里不写任何 runtime 的名字。
import type { RuntimeId } from "@pi-lead-child/core";
import { redactAndCap } from "@pi-lead-child/protocol";
import { findRuntimeAdapter, runtimeDisabledReason } from "@pi-lead-child/runtime";
import { ModelChoiceError, validateModelChoice, type ModelCatalog } from "../model-catalog.js";
import { catalogEntryDisabled, type RuntimeCatalog } from "../runtime-catalog.js";
import { errorText } from "./deadline.js";
import { LLM_BACKEND } from "./llm.js";
import { SMART_MODEL_LIMITS } from "./questions.js";
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  ScoreAnswer,
  ScoreQuestion,
  SmartDecision,
  SmartFallback,
  SmartModel,
  SmartQuestion,
  YesNoAnswer,
  YesNoQuestion,
} from "./types.js";

export type RouteRole = "executor" | "reviewer";

export const ROUTE_TASK_KINDS = ["coding", "review", "research", "writing", "chore"] as const;
export type RouteTaskKind = (typeof ROUTE_TASK_KINDS)[number];

const TASK_KIND_NOTES: Record<RouteTaskKind, string> = {
  coding: "write or change code, fix a bug, refactor",
  review: "check someone else's work, run tests, verify a claim",
  research: "investigate, read sources, compare options, answer a question",
  writing: "write or edit documents, specs, messages",
  chore: "small mechanical work: format conversion, small scripts, tidying files",
};

// effort 问成 4 档，再对到所选模型自己的档位名上。
const EFFORT_LEVELS = [
  "low: trivial chore, format conversion, a small script",
  "medium: an ordinary, well-scoped task",
  "high: complex coding, debugging, or a risky change",
  "very high: the hardest multi-step design or deep investigation",
];
const EFFORT_NAMES: readonly (readonly string[])[] = [["low", "minimal"], ["medium"], ["high"], ["xhigh", "max"]];

const MODELS_PER_RUNTIME = 12;
const MAX_BRIEF_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 4_000;
const DEFAULT_MODEL_MARK = "(cli default)";

export interface RouteCandidate {
  runtime: RuntimeId;
  /** 候选模型。空数组表示不知道这个 runtime 的模型，只能用 CLI 的默认模型。 */
  models: string[];
}

export interface RouteExclusion {
  runtime: RuntimeId;
  /** 只排除了这个 runtime 的一个模型时是模型名；整个 runtime 被排除时没有。 */
  model?: string;
  reason: string;
}

/** 健康账本的判断：不可用时返回原因（true 表示不可用、没有具体原因）；可用时返回 false 或 null。 */
export type RouteHealthVerdict = string | boolean | null;

export interface RouteCandidatesInput {
  role: RouteRole;
  catalog: RuntimeCatalog;
  modelCatalog: ModelCatalog;
  /** 健康账本：这个 runtime 的 profile 整个不可用，或者正在冷却。 */
  runtimeUnavailable?: (runtime: RuntimeId) => RouteHealthVerdict;
  /** 健康账本：这个 runtime 上的这个模型不可用（例如额度用完、在等重置）。 */
  modelUnavailable?: (runtime: RuntimeId, model: string) => RouteHealthVerdict;
}

function verdictReason(verdict: RouteHealthVerdict, generic: string): string | null {
  if (!verdict) return null;
  return typeof verdict === "string" && verdict.trim() ? verdict.trim() : generic;
}

/** 硬规则：哪些 runtime 和模型可以进候选，哪些被排除、为什么。顺序沿用目录的顺序。 */
export function routeCandidates(input: RouteCandidatesInput): { candidates: RouteCandidate[]; excluded: RouteExclusion[] } {
  const candidates: RouteCandidate[] = [];
  const excluded: RouteExclusion[] = [];
  for (const entry of input.catalog.entries) {
    if (!entry.available) {
      excluded.push({ runtime: entry.id, reason: entry.reason ?? "executable not found" });
      continue;
    }
    if (catalogEntryDisabled(entry)) {
      excluded.push({ runtime: entry.id, reason: runtimeDisabledReason(entry.id) });
      continue;
    }
    const runtimeReason = verdictReason(input.runtimeUnavailable?.(entry.id) ?? null, "unavailable in the runtime health ledger");
    if (runtimeReason) {
      excluded.push({ runtime: entry.id, reason: runtimeReason });
      continue;
    }
    const known = input.modelCatalog.runtimes.find((item) => item.runtime === entry.id);
    const listed = known && known.state === "known" ? known.models.map((model) => model.id) : entry.models;
    const models: string[] = [];
    for (const model of listed.filter((value, index, all) => all.indexOf(value) === index)) {
      if (model.length > SMART_MODEL_LIMITS.maxOptionChars - entry.id.length - 1) continue;
      const modelReason = verdictReason(input.modelUnavailable?.(entry.id, model) ?? null, "unavailable in the runtime health ledger");
      if (modelReason) {
        excluded.push({ runtime: entry.id, model, reason: modelReason });
        continue;
      }
      if (models.length < MODELS_PER_RUNTIME) models.push(model);
    }
    if (listed.length > 0 && models.length === 0) {
      excluded.push({ runtime: entry.id, reason: "every listed model is unavailable in the runtime health ledger" });
      continue;
    }
    candidates.push({ runtime: entry.id, models });
  }
  if (input.role !== "reviewer") return { candidates, excluded };
  // 核查员：能跑命令的排在前面，其余照目录的顺序。只影响顺序，不排除。
  const runsCommands = (runtime: RuntimeId): boolean =>
    input.catalog.entries.find((entry) => entry.id === runtime)?.capabilities.executableReadOnlyReview ?? false;
  return {
    candidates: [
      ...candidates.filter((candidate) => runsCommands(candidate.runtime)),
      ...candidates.filter((candidate) => !runsCommands(candidate.runtime)),
    ],
    excluded,
  };
}

interface RouteOption {
  label: string;
  runtime: RuntimeId;
  model: string | null;
}

function routeOptions(candidates: readonly RouteCandidate[]): RouteOption[] {
  return candidates.flatMap((candidate): RouteOption[] => candidate.models.length
    ? candidate.models.map((model) => ({ label: `${candidate.runtime}/${model}`, runtime: candidate.runtime, model }))
    : [{ label: `${candidate.runtime}/${DEFAULT_MODEL_MARK}`, runtime: candidate.runtime, model: null }]);
}

// 先脱敏再截断（2026-10-16 发布评审）：先截断时，跨在截断处的 token 只剩一个前缀，脱敏规则认不出它。
// 截断后的结果连同 "…" 不超过 max 个字符：选项说明的上限和 SmartModel 的校验是同一个数。
function cap(text: string, max: number): string {
  const capped = redactAndCap(text, max);
  return capped.truncated ? `${capped.text.slice(0, max - 1)}…` : capped.text;
}

function optionNote(option: RouteOption, catalog: RuntimeCatalog, modelCatalog: ModelCatalog): string {
  const entry = catalog.entries.find((item) => item.id === option.runtime);
  const known = modelCatalog.runtimes.find((item) => item.runtime === option.runtime);
  const model = option.model && known?.state === "known" ? known.models.find((item) => item.id === option.model) : undefined;
  const parts = [
    `runtime ${findRuntimeAdapter(option.runtime)?.displayName ?? option.runtime}`,
    entry?.capabilities.executableReadOnlyReview ? "can run tests in a read-only review" : null,
    option.model === null ? "the CLI picks its own default model" : null,
    model && model.id === known?.cliDefaultModel ? "the CLI default model" : null,
    model && model.label !== model.id ? model.label : null,
    model?.note ?? null,
    model ? (model.efforts.length ? `efforts ${model.efforts.join("/")}` : "no effort setting") : null,
  ].filter((part): part is string => Boolean(part));
  return cap(parts.join("; "), SMART_MODEL_LIMITS.maxDescriptionChars);
}

function effortsFor(modelCatalog: ModelCatalog, runtime: RuntimeId, model: string | null): string[] {
  const entry = modelCatalog.runtimes.find((item) => item.runtime === runtime);
  if (!entry || entry.state !== "known") return [];
  const chosen = entry.models.find((item) => item.id === (model ?? entry.cliDefaultModel));
  return chosen ? chosen.efforts : model === null ? entry.efforts : [];
}

/** 把 4 档 effort 对到模型自己的档位名上。名字对不上时按位置取（档位按从低到高排列）。 */
export function mapEffortLevel(level: number, efforts: readonly string[]): string | null {
  if (efforts.length === 0) return null;
  const clamped = Math.min(Math.max(Math.round(level), 0), EFFORT_NAMES.length - 1);
  for (const name of EFFORT_NAMES[clamped]!) {
    if (efforts.includes(name)) return name;
  }
  const index = Math.round((clamped / (EFFORT_NAMES.length - 1)) * (efforts.length - 1));
  return efforts[index] ?? null;
}

export interface RouteSuggestion {
  role: RouteRole;
  runtime: { value: RuntimeId; confidence: number };
  /** null 表示不传模型，由 CLI 用自己的默认模型。 */
  model: { value: string | null; confidence: number };
  /** null 表示不传 effort。 */
  effort: { value: string | null; confidence: number };
  /** 只对 executor 有意义。 */
  independentReview: { advisable: boolean; probability: number } | null;
  taskKind: { value: RouteTaskKind; confidence: number } | null;
  /** 回答的后端。null 表示只用了硬规则（没有 SmartModel，或者它失败了）。 */
  backend: string | null;
  backendModel: string | null;
  fallbackFrom: SmartFallback | null;
  latencyMs: number | null;
  candidates: RouteCandidate[];
  excluded: RouteExclusion[];
  notes: string[];
}

export interface SuggestRouteInput extends Omit<RouteCandidatesInput, "role"> {
  brief: string;
  role?: RouteRole;
  /** 工单的上下文：标题、正文摘录、执行者用过的 runtime 和模型。 */
  context?: string | null;
  smartModel?: SmartModel | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function routeState(input: SuggestRouteInput, role: RouteRole): string {
  return [
    `Role of the agent to dispatch: ${role}`,
    "Task brief:",
    cap(input.brief.trim(), MAX_BRIEF_CHARS),
    ...(input.context?.trim() ? ["", "Ticket context:", cap(input.context.trim(), MAX_CONTEXT_CHARS)] : []),
  ].join("\n");
}

function routeQuestions(options: readonly RouteOption[], input: SuggestRouteInput, role: RouteRole): Record<string, SmartQuestion> {
  const route: ChoiceQuestion | null = options.length >= 2
    ? {
        type: "choice",
        prompt: role === "reviewer"
          ? "Which runtime and model should independently verify this work? Prefer a runtime or model family different from the executor's."
          : "Which runtime and model should do this task? Prefer the strongest coding model for complex coding, and a cheap, fast model for chores.",
        options: options.map((option) => option.label),
        descriptions: Object.fromEntries(options.map((option) => [option.label, optionNote(option, input.catalog, input.modelCatalog)])),
      }
    : null;
  const effort: ScoreQuestion = {
    type: "score",
    prompt: "How much reasoning effort does this task need?",
    levels: EFFORT_LEVELS,
  };
  const taskKind: ChoiceQuestion = {
    type: "choice",
    prompt: "What kind of task is this?",
    options: [...ROUTE_TASK_KINDS],
    descriptions: { ...TASK_KIND_NOTES },
  };
  const review: YesNoQuestion | null = role === "executor"
    ? {
        type: "yes_no",
        prompt: "Should a different agent independently review this work before it is accepted?",
        yes: "the change is risky, user-facing, hard to verify, or touches shared state",
        no: "the work is trivial, read-only, or easy to check by looking at the result",
      }
    : null;
  const questions: Record<string, SmartQuestion> = { effort, task_kind: taskKind };
  if (route) questions.route = route;
  if (review) questions.independent_review = review;
  return questions;
}

interface RouteAnswers {
  effort: ScoreAnswer;
  task_kind: ChoiceAnswer;
  route?: ChoiceAnswer;
  independent_review?: YesNoAnswer;
}

function hardRuleOnly(
  role: RouteRole,
  candidates: RouteCandidate[],
  excluded: RouteExclusion[],
  notes: string[],
): RouteSuggestion {
  const first = candidates[0]!;
  const single = candidates.length === 1;
  return {
    role,
    runtime: { value: first.runtime, confidence: single ? 1 : 0 },
    model: { value: single && first.models.length === 1 ? first.models[0]! : null, confidence: 0 },
    effort: { value: null, confidence: 0 },
    independentReview: null,
    taskKind: null,
    backend: null,
    backendModel: null,
    fallbackFrom: null,
    latencyMs: null,
    candidates,
    excluded,
    notes: [...notes, "Only the hard rules were applied: the runtime is the first healthy candidate, model and effort are left to the CLI."],
  };
}

/** 选型建议。没有候选时抛错；SmartModel 缺席或失败时退回只用硬规则的建议，并在 notes 里说明。 */
export async function suggestRoute(input: SuggestRouteInput): Promise<RouteSuggestion> {
  const role = input.role ?? "executor";
  if (!input.brief?.trim()) throw new Error("brief must be a non-empty string");
  const { candidates, excluded } = routeCandidates({ ...input, role });
  if (candidates.length === 0) {
    const why = excluded.map((item) => `${item.runtime}${item.model ? `/${item.model}` : ""}: ${item.reason}`).join("; ");
    throw new Error(`no ${role} runtime is available${why ? ` (${why})` : ""}`);
  }
  if (!input.smartModel) return hardRuleOnly(role, candidates, excluded, ["SmartModel is not configured."]);

  const options = routeOptions(candidates);
  const questions = routeQuestions(options, input, role);
  let decision: SmartDecision<Record<string, SmartQuestion>>;
  try {
    decision = await input.smartModel.decide(routeState(input, role), questions, {
      purpose: "route",
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  } catch (error) {
    return hardRuleOnly(role, candidates, excluded, [`SmartModel failed: ${errorText(error)}`]);
  }

  const notes: string[] = [];
  // LLM 后端的置信度是固定值（llm.ts 的 LLM_FIXED_CONFIDENCE），不是真实的概率。
  if (decision.backend === LLM_BACKEND) notes.push("Confidence is not calibrated: the LLM backend answered.");
  // 问题是按上面的名字和类型问的，SmartModel 已经按类型校验过每个回答。
  const answers = decision.answers as unknown as RouteAnswers;
  let picked = options[0]!;
  let runtimeConfidence = 1;
  let modelConfidence = 1;
  if (answers.route) {
    const route = answers.route;
    picked = options.find((option) => option.label === route.choice)!;
    // runtime 的置信度：这个 runtime 的所有选项的概率之和。模型的置信度：在这个 runtime 之内的条件概率。
    runtimeConfidence = options
      .filter((option) => option.runtime === picked.runtime)
      .reduce((sum, option) => sum + (route.probabilities[option.label] ?? 0), 0);
    const own = route.probabilities[picked.label] ?? 0;
    modelConfidence = runtimeConfidence > 0 ? own / runtimeConfidence : 0;
  }

  let effort = mapEffortLevel(answers.effort.level, effortsFor(input.modelCatalog, picked.runtime, picked.model));
  if (effort === null) notes.push("The chosen model's effort levels are unknown or not adjustable; effort is left to the CLI.");
  if (effort !== null) {
    try {
      validateModelChoice(input.modelCatalog, { runtime: picked.runtime, model: picked.model, effort });
    } catch (error) {
      if (!(error instanceof ModelChoiceError)) throw error;
      notes.push(`Effort ${effort} does not fit the catalog: ${error.message}`);
      effort = null;
    }
  }

  return {
    role,
    runtime: { value: picked.runtime, confidence: round(runtimeConfidence) },
    model: { value: picked.model, confidence: round(modelConfidence) },
    effort: { value: effort, confidence: effort === null ? 0 : round(answers.effort.confidence) },
    independentReview: answers.independent_review
      ? { advisable: answers.independent_review.probability >= 0.5, probability: round(answers.independent_review.probability) }
      : null,
    taskKind: { value: answers.task_kind.choice as RouteTaskKind, confidence: round(answers.task_kind.confidence) },
    backend: decision.backend,
    backendModel: decision.model,
    fallbackFrom: decision.fallbackFrom,
    latencyMs: decision.latencyMs,
    candidates,
    excluded,
    notes,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
