// Lead 会话的 SmartModel（2026-10-16 用户决定）：决策模型（设置页「模型」的「直觉」，缺省 TypeSafe 的 Jev）有 key 时用它，
// 失败时用 LLM 兜底；没有 key 时只用 LLM。LLM 走 Lead 自己的 ModelRuntime 和 config.json 里的 provider。
// LLM 用哪个模型：
//   0. 设置页选的（config.json 的 decision.llmFallback，2026-10-29）。每次调用时读，注册得到时用它；
//   1. PLC_SMART_MODEL（provider/model）；
//   2. 否则是 Lead 的 provider 配置里第一个名字带 haiku 的模型；
//   3. 否则是 Lead 自己正在用的模型。
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createSmartModel, decisionPurpose, LLM_BACKEND, smartModelDecisionLogPath,
  type CreateSmartModelOptions, type SmartModel, type SmartTextComplete,
} from "@pi-lead-child/engine";
import type { LeadModelConfig } from "./model-config.js";

const SMART_MODEL_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[^\s/][^\s]{0,199}$/;
const FAST_MODEL = /haiku/i;
const MAX_REPLY_TOKENS = 2_048;

export interface SmartModelSpecChoice {
  spec: string;
  source: "env" | "config" | "lead";
  /** 选择时遇到的问题，例如 PLC_SMART_MODEL 格式不对。 */
  note: string | null;
}

/** spec 是不是 provider/model 的格式：provider 是一个名字，model 不含空白。 */
export function isValidSmartModelSpec(spec: string): boolean {
  return SMART_MODEL_SPEC.test(spec);
}

/** Lead 的 provider 配置里列出的模型，按 provider 的顺序；registered 补上 discover 拉到的模型。 */
export function configuredLeadModelSpecs(
  config: LeadModelConfig,
  registered: (provider: string) => readonly string[] = () => [],
): string[] {
  const specs: string[] = [];
  for (const [provider, settings] of Object.entries(config.providers)) {
    for (const id of [...(settings.models ?? []).map((model) => model.id), ...registered(provider)]) {
      const spec = `${provider}/${id}`;
      if (!specs.includes(spec)) specs.push(spec);
    }
  }
  return specs;
}

/** 选 LLM 后端的模型。顺序见文件开头。 */
export function selectSmartModelSpec(input: {
  env?: Record<string, string | undefined>;
  configuredSpecs: readonly string[];
  leadSpec: string;
}): SmartModelSpecChoice {
  const env = input.env ?? process.env;
  const fromEnv = env.PLC_SMART_MODEL?.trim();
  let note: string | null = null;
  if (fromEnv) {
    if (isValidSmartModelSpec(fromEnv)) return { spec: fromEnv, source: "env", note: null };
    note = "PLC_SMART_MODEL must be provider/model; ignoring it";
  }
  const fast = newestModelSpec(input.configuredSpecs.filter((spec) => FAST_MODEL.test(spec.slice(spec.indexOf("/") + 1))));
  if (fast) return { spec: fast, source: "config", note };
  return { spec: input.leadSpec, source: "lead", note };
}

// 版本最新的那个模型。provider discover 出来的目录不按版本排序（实测 vibeproxy 把 claude-haiku-4-5-20251001
// 排在 claude-haiku-5-5 前面），所以按模型 id 里的版本号比较：8 位的日期后缀不算版本；版本相同时，没有日期后缀的优先。
export function newestModelSpec(specs: readonly string[]): string | null {
  const version = (spec: string) => (spec.slice(spec.indexOf("/") + 1).match(/\d+/g) ?? [])
    .filter((part) => part.length < 8).map(Number);
  const dated = (spec: string) => /\d{8}/.test(spec);
  let best: string | null = null;
  for (const spec of specs) {
    if (best === null) { best = spec; continue; }
    const [a, b] = [version(spec), version(best)];
    let order = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && order === 0; i += 1) order = (a[i] ?? -1) - (b[i] ?? -1);
    if (order > 0 || (order === 0 && dated(best) && !dated(spec))) best = spec;
  }
  return best;
}

function replyText(reply: Awaited<ReturnType<ModelRuntime["completeSimple"]>>): string {
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(reply.errorMessage ?? `the model stopped with ${reply.stopReason}`);
  }
  return reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export interface LeadSmartModel {
  smartModel: SmartModel | null;
  /**
   * 同一个便宜模型（LLM 后端）的自由文本补全（slack-takeover 工单 07）：要模型写一段话、而不是回答几个问题时用。
   * 每次调用经 onCall 交出一条调用记录（后端 llm、用途是调用方给的 purpose），session.ts 把它写成 decision_model.called，
   * get_system_usage 按用途统计。没有 LLM 后端时为 null。
   */
  complete: SmartTextComplete | null;
  /** LLM 后端用的模型。没有 LLM 后端时为 null。 */
  llmSpec: string | null;
  notes: string[];
}

/** 给一个 Lead 会话建 SmartModel。每个会话建一次。 */
export function createLeadSmartModel(input: {
  modelRuntime: Pick<ModelRuntime, "getModel" | "getModels" | "completeSimple">;
  config: LeadModelConfig;
  leadSpec: string;
  dataDir: string;
  // 决策模型的配置和 key（daemon 的 MemoryController）。不给时只用 LLM。
  decisionModel?: CreateSmartModelOptions["decisionModel"];
  // 每次调用结束时的调用记录（工单 13）：session.ts 把它写成 decision_model.called 事件。
  onCall?: CreateSmartModelOptions["onCall"];
  // 设置页选的「都用不了时问大脑的哪个模型」（provider/model，可以带推理强度）。每次调用时读；没选或者注册不到时用下面选出的。
  llmFallback?: () => string | null;
  env?: Record<string, string | undefined>;
  /**
   * 每条说明出现时调用一次。决策模型不能用的说明在第一次读 backend 时才出现，会话中途改了配置时也会出现，
   * 所以调用方要在打 backend 那一行之前接上它，否则日志里看不到原因。
   */
  onNote?: (note: string) => void;
}): LeadSmartModel {
  const env = input.env ?? process.env;
  const notes: string[] = [];
  const note = (text: string): void => {
    notes.push(text);
    input.onNote?.(text);
  };
  const choice = selectSmartModelSpec({
    env,
    configuredSpecs: configuredLeadModelSpecs(
      input.config,
      (provider) => input.modelRuntime.getModels(provider).map((model) => model.id),
    ),
    leadSpec: input.leadSpec,
  });
  if (choice.note) note(choice.note);
  const resolve = (spec: string) => {
    const slash = spec.indexOf("/");
    return slash > 0 ? input.modelRuntime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
  };
  let llmSpec: string | null = choice.spec;
  let model = resolve(choice.spec);
  if (!model && choice.spec !== input.leadSpec) {
    note(`smart model ${choice.spec} is not registered; using the Lead model ${input.leadSpec}`);
    llmSpec = input.leadSpec;
    model = resolve(input.leadSpec);
  }
  if (!model) {
    note(`smart model ${llmSpec} is not registered; no LLM backend`);
    llmSpec = null;
  }
  const resolved = model;
  // 设置页选的模型：注册得到时用它（带推理强度的先找带后缀的，再找不带的）。注册不到时只说一次，用上面选出的。
  let missingChoice: string | null = null;
  const chosen = () => {
    let spec: string | null = null;
    try {
      spec = input.llmFallback?.()?.trim() || null;
    } catch {
      spec = null;
    }
    if (!spec) return resolved;
    const found = resolve(spec) ?? resolve(spec.replace(/\([A-Za-z0-9_-]{1,32}\)$/, ""));
    if (found) {
      missingChoice = null;
      return found;
    }
    if (missingChoice !== spec) note(`the chosen smart model ${spec} is not registered; using ${llmSpec ?? "no LLM"}`);
    missingChoice = spec;
    return resolved;
  };
  // 一个都注册不到时没有 LLM 后端（和以前一样）：不因为设置页选了模型就多出一个总是失败的后端。
  const llm = resolved
    ? async (prompt: string, signal: AbortSignal | undefined, maxTokens: number) => {
      const target = chosen() ?? resolved;
      return replyText(await input.modelRuntime.completeSimple(
        target,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { ...(signal ? { signal } : {}), maxTokens },
      ));
    }
    : null;
  const smartModel = createSmartModel({
    ...(input.decisionModel ? { decisionModel: input.decisionModel } : {}),
    ...(llm
      ? { complete: (prompt: string, signal?: AbortSignal) => llm(prompt, signal, MAX_REPLY_TOKENS), completeModel: llmSpec }
      : {}),
    logPath: smartModelDecisionLogPath(input.dataDir),
    ...(input.onCall ? { onCall: input.onCall } : {}),
    onNote: note,
  });
  const textModel = llmSpec;
  const complete: SmartTextComplete | null = llm
    ? async (prompt, opts) => {
      const started = Date.now();
      const report = (outcome: { ok: true } | { ok: false; error: unknown }) => {
        try {
          input.onCall?.({
            purpose: decisionPurpose(opts.purpose), backend: LLM_BACKEND, model: textModel, latencyMs: Date.now() - started,
            ok: outcome.ok, error: outcome.ok ? null : errorMessage(outcome.error),
            errorKind: outcome.ok ? null : opts.signal?.aborted ? "aborted" : "error", fallbackFrom: null,
          });
        } catch {
          // 记录只用来统计，不能挡住补全本身。
        }
      };
      try {
        const maxTokens = Number.isFinite(opts.maxTokens) ? Math.min(Math.max(1, Math.trunc(opts.maxTokens!)), MAX_REPLY_TOKENS) : MAX_REPLY_TOKENS;
        const text = await llm(prompt, opts.signal, maxTokens);
        report({ ok: true });
        return text;
      } catch (error) {
        report({ ok: false, error });
        throw error;
      }
    }
    : null;
  return { smartModel, complete, llmSpec, notes };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
