// SmartModel 的工厂（2026-10-16 用户决定）：
//   - 决策模型（设置页「模型」的「直觉」：TypeSafe 的 Jev 或者兼容的端点）有 key 时，它先回答；失败（网络、429、5xx、超时、
//     回答不合法）时改由 LLM 回答。2026-10-29 起可以配多条：按分工的顺序问（主用、备用 1、备用 2……），都失败时问 LLM。
//   - 没有 key 时只用 LLM（Lead 的模型配置里的 Haiku，见 packages/lead 的 smart-model.ts）。
// 决策模型的配置每次调用时读一次：用户在设置页改了 key 或者端点，下一次调用就用新的，不用重建 Lead 会话。
// key 只经 decisionModel() 传进来（daemon 的保险库），不读 process.env：child 继承 daemon 的全部环境。
// 每次调用的结果里写明是哪个后端回答的。给了日志路径时，每次调用记一行决策日志。
// 给了 onCall 时，每次调用（成功或失败）交给它一条调用记录（observe.ts，工单 13：写成 decision_model.called 事件）。
import { serviceUrlHost } from "@pi-lead-child/protocol";
import { withDecisionLog } from "./decision-log.js";
import { withCallObserver, type SmartModelCallObserver } from "./observe.js";
import { errorText } from "./deadline.js";
import { createJevSmartModel, DEFAULT_JEV_MODEL, isValidJevModelName } from "./jev.js";
import { createLlmSmartModel, type SmartCompleteFn } from "./llm.js";
import { validateSmartInput } from "./questions.js";
import {
  SmartModelBackendError,
  SmartModelInputError,
  type SmartDecideOptions,
  type SmartDecision,
  type SmartFallback,
  type SmartModel,
  type SmartQuestionSet,
} from "./types.js";

/**
 * 按顺序问后端：前一个失败就问下一个。输入不合法、或者调用方取消时不换后端，直接抛错。
 * 全部失败时抛最后一个错误，消息里带上前面那个后端的错误。
 */
export function chainSmartModels(backends: readonly SmartModel[]): SmartModel {
  if (backends.length === 0) throw new Error("chainSmartModels needs at least one backend");
  if (backends.length === 1) return backends[0]!;
  return {
    backend: backends.map((backend) => backend.backend).join("→"),
    async decide<Q extends SmartQuestionSet>(state: string, questions: Q, opts: SmartDecideOptions = {}): Promise<SmartDecision<Q>> {
      validateSmartInput(state, questions);
      const started = Date.now();
      let fallback: SmartFallback | null = null;
      for (const [index, backend] of backends.entries()) {
        try {
          const decision = await backend.decide(state, questions, opts);
          return { ...decision, latencyMs: Date.now() - started, fallbackFrom: fallback ?? decision.fallbackFrom };
        } catch (error) {
          if (error instanceof SmartModelInputError || opts.signal?.aborted) throw error;
          const message = errorText(error);
          if (index === backends.length - 1) {
            const before = fallback ? `${fallback.backend} failed (${fallback.error}); ` : "";
            throw new SmartModelBackendError(
              backend.backend,
              `${before}${message}`,
              error instanceof SmartModelBackendError ? error.kind : "network",
              error instanceof SmartModelBackendError ? error.status : null,
            );
          }
          fallback = { backend: backend.backend, error: message };
        }
      }
      throw new Error("unreachable");
    },
  };
}

/** 决策模型的端点和 key。baseUrl 后面接 /v1/systemone。keyHost 是 key 绑定的主机（daemon 存 key 时记下的）。 */
export interface DecisionModelCredentials {
  baseUrl: string;
  model: string;
  apiKey: string;
  keyHost: string;
}

export interface CreateSmartModelOptions {
  /**
   * 每次调用时读决策模型的配置。返回 null 或空数组（没有 key）时只用 LLM。返回数组时按顺序问（分工：主用在前），
   * 前一个失败就问下一个，都失败时问 LLM。
   */
  decisionModel?: () => DecisionModelCredentials | readonly DecisionModelCredentials[] | null;
  /** LLM 后端用的补全函数。不给时没有 LLM 后端。 */
  complete?: SmartCompleteFn;
  /** LLM 后端的模型名，只用来报告。 */
  completeModel?: string | null;
  /** 决策日志的路径。不给时不记日志。 */
  logPath?: string | null;
  /** 每次调用结束时（成功或失败）调用一次。回调出错不影响判断。 */
  onCall?: SmartModelCallObserver;
  /** 配置有问题时的一句说明，例如 PLC_JEV_MODEL 不合法。 */
  onNote?: (note: string) => void;
  // 下面几项只给测试用。
  fetch?: typeof fetch;
  jevTimeoutMs?: number;
  llmTimeoutMs?: number;
  random?: () => number;
}

// 读配置失败时只报错误的类型名和错误码。错误信息可能抄了保险库或配置文件的内容
// （例如 JSON.parse 的报错带一段原文），里面可能有 key，脱敏规则不一定认得出。
function readErrorKind(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : "Error";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? `${name} ${code}` : name;
}

/** 按配置组装 SmartModel。一个后端都没有时返回 null。 */
export function createSmartModel(options: CreateSmartModelOptions = {}): SmartModel | null {
  const llm = options.complete
    ? createLlmSmartModel({
        complete: options.complete,
        model: options.completeModel ?? null,
        ...(options.llmTimeoutMs ? { timeoutMs: options.llmTimeoutMs } : {}),
      })
    : null;
  if (!options.decisionModel && !llm) return null;

  // 配置没变时复用同一个 Jev 后端（按配置认）。配置不能用（例如非回环的 http 端点）时只说一次，当作没有这一个。
  let cache = new Map<string, SmartModel | null>();
  // 读配置失败（保险库、配置文件）时也当作没有 Jev，改用 LLM，不退到硬规则（2026-10-16 发布评审）。
  // 连续失败只说一次。
  let readFailed = false;
  const read = (): readonly DecisionModelCredentials[] => {
    try {
      const credentials = options.decisionModel?.() ?? null;
      readFailed = false;
      if (!credentials) return [];
      return Array.isArray(credentials) ? credentials : [credentials as DecisionModelCredentials];
    } catch (error) {
      if (!readFailed) options.onNote?.(`the decision model settings cannot be read (${readErrorKind(error)}); not using it`);
      readFailed = true;
      return [];
    }
  };
  const jevs = (): SmartModel[] => {
    const next = new Map<string, SmartModel | null>();
    const built: SmartModel[] = [];
    for (const credentials of read()) {
      const id = JSON.stringify(credentials);
      const jev = next.has(id) ? next.get(id)! : cache.has(id) ? cache.get(id)! : buildJev(credentials);
      next.set(id, jev);
      if (jev) built.push(jev);
    }
    // 只留这一次还在用的：分工改了以后，旧的后端（和它的 key）不再留在内存里。
    cache = next;
    return built;
  };
  const buildJev = (credentials: DecisionModelCredentials): SmartModel | null => {
    if (!credentials.apiKey.trim()) return null;
    // 再核对一次 key 绑定的主机（2026-10-16 发布评审）：对不上时这个 key 不发出去。
    // 地址本身不合法时不在这里说，下面 createJevSmartModel 会说清楚是什么问题。
    const host = serviceUrlHost(credentials.baseUrl);
    if (host !== null && host !== credentials.keyHost) {
      options.onNote?.(`the decision-model key is bound to another host than ${host}; not using it`);
      return null;
    }
    let model = credentials.model.trim() || DEFAULT_JEV_MODEL;
    if (!isValidJevModelName(model)) {
      options.onNote?.(`the decision model name is not valid; using ${DEFAULT_JEV_MODEL}`);
      model = DEFAULT_JEV_MODEL;
    }
    let built: SmartModel | null = null;
    try {
      built = createJevSmartModel({
        apiKey: credentials.apiKey,
        model,
        endpoint: `${credentials.baseUrl.replace(/\/+$/, "")}/v1/systemone`,
        ...(options.jevTimeoutMs ? { timeoutMs: options.jevTimeoutMs } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.random ? { random: options.random } : {}),
      });
    } catch (error) {
      options.onNote?.(`the decision model cannot be used: ${errorText(error)}`);
    }
    return built;
  };
  const backends = () => [...jevs(), llm].filter((backend): backend is SmartModel => backend !== null);

  const model: SmartModel = {
    get backend() {
      return backends().map((backend) => backend.backend).join("→") || "none";
    },
    decide(state, questions, opts) {
      const current = opts?.decisionOnly ? jevs() : backends();
      if (current.length === 0) {
        validateSmartInput(state, questions);
        return Promise.reject(opts?.decisionOnly
          ? new SmartModelBackendError("jev", "no decision model is configured", "unconfigured")
          : new SmartModelBackendError("jev", "no decision-model key and no LLM backend", "network"));
      }
      return chainSmartModels(current).decide(state, questions, opts);
    },
  };
  const observed = options.onCall ? withCallObserver(model, options.onCall) : model;
  return options.logPath ? withDecisionLog(observed, { path: options.logPath }) : observed;
}
