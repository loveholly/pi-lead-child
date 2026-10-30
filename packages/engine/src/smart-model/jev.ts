// Jev 后端：TypeSafe 托管的类型化判断模型（https://docs.typesafe.ai/api.md）。
// 一次请求 POST /v1/systemone，带 state、model 和一组问题。三种问题对应 choice、score、noul。
// 用 fetch 直接调，不加 SDK 依赖。密钥只放在 Authorization 头里，不进错误信息和日志。
import { redactSecretText, serviceUrlProblem, type ServiceUrlProblem } from "@pi-lead-child/protocol";
import { deadline, backendFailure, errorText, raceAbort } from "./deadline.js";
import { argmax, validateSmartAnswers, validateSmartInput } from "./questions.js";
import {
  SmartModelBackendError,
  type ChoiceQuestion,
  type ScoreQuestion,
  type SmartAnswer,
  type SmartDecideOptions,
  type SmartDecision,
  type SmartModel,
  type SmartQuestion,
  type SmartQuestionSet,
} from "./types.js";

export const JEV_BACKEND = "jev";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** 文档的例子和官方 SDK 的缺省模型。 */
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 5_000;

const JEV_MODEL_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface JevSmartModelOptions {
  apiKey: string;
  model?: string;
  /** 只给测试用：本机的桩服务器。只接受 http 或 https。 */
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** 打乱选项顺序用的随机数。测试注入它来固定顺序。 */
  random?: () => number;
}

export function isValidJevModelName(model: string): boolean {
  return JEV_MODEL_NAME.test(model);
}

// 地址和决策模型、远程 embedding 的设置走同一个校验（protocol 的 service-url.ts，2026-10-16 发布评审）。
const ENDPOINT_PROBLEMS: Record<ServiceUrlProblem, string> = {
  invalid_url: "the Jev endpoint is not a valid URL",
  userinfo: "the Jev endpoint must not carry credentials",
  secret_query: "the Jev endpoint must not carry key-like query parameters",
};

function checkedEndpoint(raw: string): URL {
  const problem = serviceUrlProblem(raw);
  if (problem) throw new Error(ENDPOINT_PROBLEMS[problem]);
  return new URL(raw.trim());
}

// Fisher–Yates。模型偏向排在前面的选项，所以每次调用都打乱一次，回答再按选项名对回去。
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    [out[index], out[pick]] = [out[pick]!, out[index]!];
  }
  return out;
}

// Jev 是本机以外的服务。发出去的文字（state、问题的说明、选项的描述）先经 redactSecretText 脱敏
// （2026-10-16 发布评审）：brief 和工单正文是自由文本，里面可能有 token。
// 选项名和分档不脱敏：回答按它们对回去；它们来自调用方自己的目录数据，不是用户写的文字。
const redact = (text: string) => redactSecretText(text);

function jevQuestion(question: SmartQuestion, random: () => number): Record<string, unknown> {
  if (question.type === "choice") {
    const criteria: Record<string, string | null> = {};
    for (const option of shuffled(question.options, random)) {
      const description = question.descriptions?.[option];
      criteria[option] = description === undefined ? null : redact(description);
    }
    return { type: "choice", instructions: redact(question.prompt), criteria };
  }
  if (question.type === "score") {
    return { type: "score", instructions: redact(question.prompt), criteria: [...question.levels] };
  }
  return {
    type: "noul",
    instructions: redact(question.prompt),
    ...(question.yes !== undefined && question.no !== undefined
      ? { criteria: { true: redact(question.yes), false: redact(question.no) } }
      : {}),
  };
}

/** 发给 Jev 的请求体。导出给测试核对映射。 */
export function jevRequestBody(
  state: string,
  questions: SmartQuestionSet,
  model: string,
  random: () => number = Math.random,
): { state: string; model: string; questions: Record<string, Record<string, unknown>> } {
  const mapped: Record<string, Record<string, unknown>> = {};
  for (const [name, question] of Object.entries(questions)) mapped[name] = jevQuestion(question, random);
  return { state: redact(state), model, questions: mapped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new SmartModelBackendError(JEV_BACKEND, `${JEV_BACKEND}: invalid answer: ${message}`, "invalid_answer");
}

function numberField(raw: Record<string, unknown>, field: string, name: string): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${name}: ${field} is not a number`);
  return value;
}

function parseChoice(name: string, question: ChoiceQuestion, raw: Record<string, unknown>): SmartAnswer {
  if (typeof raw.choice !== "string") invalid(`${name}: choice is not a string`);
  if (!isRecord(raw.probabilities)) invalid(`${name}: probabilities are missing`);
  const given = raw.probabilities;
  // 按问题里的选项顺序对回去。多出来或者少了的选项都不收。
  if (Object.keys(given).some((option) => !question.options.includes(option))) {
    invalid(`${name}: probabilities name an unknown option`);
  }
  const probabilities: Record<string, number> = {};
  for (const option of question.options) {
    if (!Object.hasOwn(given, option)) invalid(`${name}: probabilities miss an option`);
    probabilities[option] = numberField(given, option, name);
  }
  return { type: "choice", choice: raw.choice, confidence: numberField(raw, "confidence", name), probabilities };
}

function parseScore(name: string, question: ScoreQuestion, raw: Record<string, unknown>): SmartAnswer {
  if (!isRecord(raw.probabilities)) invalid(`${name}: probabilities are missing`);
  const given = raw.probabilities;
  const count = question.levels.length;
  if (Object.keys(given).length !== count) invalid(`${name}: probabilities do not cover exactly the levels`);
  const probabilities: number[] = [];
  for (let level = 0; level < count; level += 1) {
    const key = String(level);
    if (!Object.hasOwn(given, key)) invalid(`${name}: probabilities miss level ${level}`);
    probabilities.push(numberField(given, key, name));
  }
  // 档位取最可能的一档，和 TypeSafe 文档里置信度的定义一致。
  const level = argmax(probabilities);
  return {
    type: "score",
    level,
    label: question.levels[level]!,
    score: numberField(raw, "score", name),
    confidence: numberField(raw, "confidence", name),
    probabilities,
  };
}

const JEV_TYPE: Record<SmartQuestion["type"], string> = { choice: "choice", score: "score", yes_no: "noul" };

/** 把 Jev 的响应体换成我们的回答，并逐个校验。不合法时抛 SmartModelBackendError。 */
export function parseJevResponse<Q extends SmartQuestionSet>(
  questions: Q,
  body: unknown,
): { answers: SmartDecision<Q>["answers"]; model: string | null } {
  if (!isRecord(body) || !isRecord(body.answers)) invalid("response has no answers object");
  const rawAnswers = body.answers;
  const answers: Record<string, SmartAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const raw = Object.hasOwn(rawAnswers, name) ? rawAnswers[name] : undefined;
    if (!isRecord(raw)) invalid(`${name}: no answer`);
    if (raw.type !== JEV_TYPE[question.type]) invalid(`${name}: answer type does not match ${question.type}`);
    if (question.type === "choice") answers[name] = parseChoice(name, question, raw);
    else if (question.type === "score") answers[name] = parseScore(name, question, raw);
    else answers[name] = { type: "yes_no", probability: numberField(raw, "noul", name) };
  }
  const model = typeof body.model === "string" && isValidJevModelName(body.model) ? body.model : null;
  return { answers: validateSmartAnswers(JEV_BACKEND, questions, answers), model };
}

// 出错时只取状态码和一个短的错误码。不回显响应体：422 的说明可能抄了请求的内容。
// 错误码的格式挡不住 key（服务端可能把 key 原样抄进错误码），所以整句再脱敏一次，并盖掉 key 本身（2026-10-16 发布评审）。
async function httpFailure(response: Response, apiKey: string): Promise<SmartModelBackendError> {
  let code = "";
  try {
    const body = await response.json() as unknown;
    const error = isRecord(body) ? body.error : undefined;
    const candidate = isRecord(error) ? (error.type ?? error.code) : typeof error === "string" ? error : undefined;
    if (typeof candidate === "string" && ERROR_CODE.test(candidate)) code = ` ${candidate}`;
  } catch {
    // 响应体不是 JSON。只报状态码。
  }
  const message = errorText(`${JEV_BACKEND}: HTTP ${response.status}${code}`, [apiKey]);
  return new SmartModelBackendError(JEV_BACKEND, message, "http", response.status);
}

export function createJevSmartModel(options: JevSmartModelOptions): SmartModel {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("the Jev backend needs an API key");
  const model = options.model?.trim() || DEFAULT_JEV_MODEL;
  if (!isValidJevModelName(model)) throw new Error("the Jev model name is not valid");
  const endpoint = checkedEndpoint(options.endpoint ?? JEV_ENDPOINT);
  const fetchImpl = options.fetch ?? fetch;
  const random = options.random ?? Math.random;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;

  return {
    backend: JEV_BACKEND,
    async decide<Q extends SmartQuestionSet>(state: string, questions: Q, opts: SmartDecideOptions = {}): Promise<SmartDecision<Q>> {
      validateSmartInput(state, questions);
      const started = Date.now();
      const timing = deadline(opts.signal, opts.timeoutMs ?? defaultTimeout);
      try {
        const response = await raceAbort(fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(jevRequestBody(state, questions, model, random)),
          signal: timing.signal,
          redirect: "error",
        }), timing.signal);
        if (!response.ok) throw await raceAbort(httpFailure(response, apiKey), timing.signal);
        let body: unknown;
        try {
          body = await raceAbort(response.json() as Promise<unknown>, timing.signal);
        } catch (error) {
          if (timing.cause()) throw error;
          invalid("response is not JSON");
        }
        const parsed = parseJevResponse(questions, body);
        return {
          answers: parsed.answers,
          backend: JEV_BACKEND,
          model: parsed.model ?? model,
          latencyMs: Date.now() - started,
          fallbackFrom: null,
        };
      } catch (error) {
        throw backendFailure(JEV_BACKEND, error, timing, [apiKey]);
      }
    },
  };
}
