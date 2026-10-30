// 决策模型（设置 → 模型的「直觉」，2026-10-29，.scratch/model-settings/spec.md D5、D6）在 config.json 和保险库里怎样存。
//
// config.json 的 decision：
//   - models：一条一项，{ id, name, baseUrl, model }。没有 models 时，把旧的 decision.baseUrl、decision.model 读成一条，id 是 jev。
//   - chain：分工，第一个主用，后面最多 3 个备用。没有 chain 时只用第一条（和以前一样）。写成空数组：不用直觉，判断都问 LLM。
//   - llmFallback：都用不了时问 Lead 的哪个模型（provider/model，可以带推理强度）。没有时由 SmartModel 自己选。
//   写的时候同时写 baseUrl、model（主用的）：退回旧版本的 daemon 时，它读到的还是主用。
// key 存保险库（sealed-secrets.ts）：jev 用原来的 decision.apiKey（已经存的 key 不用搬），别的用 decision.apiKey.<id>。
// key 绑定存它时的主机，只发给这个主机。Keychain 或环境变量里的 TYPESAFE_API_KEY 只给主机是 api.typesafe.ai 的条目。
import { MODEL_MAX_CHAIN, normalizeServiceUrl, SERVICE_URL_MESSAGES, serviceUrlHost, serviceUrlProblem } from "@pi-lead-child/protocol";
import { loadPlcConfig, writePlcConfig } from "@pi-lead-child/core";
import type { SealedSecrets } from "./sealed-secrets.js";

export const DEFAULT_DECISION_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_DECISION_MODEL = "jev-latest";
// Keychain 或环境变量里的 TYPESAFE_API_KEY 只发给这个主机。
export const TYPESAFE_HOST = "api.typesafe.ai";
// 旧配置读成的那一条的编号。它的 key 在保险库的 decision.apiKey 下面。
export const LEGACY_DECISION_ID = "jev";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// 一条决策模型。地址不合法时 baseUrl 和 host 是 null，problem 说明原因。
export interface DecisionEntry {
  id: string;
  name: string;
  baseUrl: string | null;
  host: string | null;
  model: string;
  problem: string | null;
}

export interface DecisionModels {
  entries: DecisionEntry[];
  // 分工里的编号（都在 entries 里，没有重复，最多 MODEL_MAX_CHAIN 个）。
  chain: string[];
  llmFallback: string | null;
}

// 写进 config.json 的一条（地址已经校验、规范化过）。
export interface DecisionEntryInput {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}

export type DecisionSecretName = "decision.apiKey" | `decision.apiKey.${string}`;

export function decisionSecretName(id: string): DecisionSecretName {
  return id === LEGACY_DECISION_ID ? "decision.apiKey" : `decision.apiKey.${id}`;
}

function entryOf(id: string, name: string, rawBaseUrl: string, model: string): DecisionEntry {
  const problem = serviceUrlProblem(rawBaseUrl);
  if (problem) return { id, name, baseUrl: null, host: null, model, problem: `${name} 的地址：${SERVICE_URL_MESSAGES[problem]}` };
  return { id, name, baseUrl: normalizeServiceUrl(rawBaseUrl), host: serviceUrlHost(rawBaseUrl), model, problem: null };
}

/** 读 config.json 的 decision。config.json 是用户能直接改的文件：不合法的条目跳过，分工里不认识的编号去掉。 */
export function loadDecisionModels(dataDir: string): DecisionModels {
  const decision = loadPlcConfig(dataDir).decision ?? {};
  const entries: DecisionEntry[] = [];
  if (Array.isArray(decision.models)) {
    for (const raw of decision.models) {
      if (!raw || typeof raw !== "object") continue;
      const { id, name, baseUrl, model } = raw as Partial<DecisionEntryInput>;
      if (typeof id !== "string" || !ID_PATTERN.test(id) || entries.some((entry) => entry.id === id)) continue;
      if (typeof baseUrl !== "string") continue;
      const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : id;
      entries.push(entryOf(id, label, baseUrl, typeof model === "string" && MODEL_PATTERN.test(model) ? model : DEFAULT_DECISION_MODEL));
    }
  } else {
    entries.push(entryOf(
      LEGACY_DECISION_ID, LEGACY_DECISION_ID,
      decision.baseUrl ?? DEFAULT_DECISION_BASE_URL,
      decision.model ?? DEFAULT_DECISION_MODEL,
    ));
  }
  const known = new Set(entries.map((entry) => entry.id));
  const chain = Array.isArray(decision.chain)
    ? [...new Set(decision.chain.filter((id): id is string => typeof id === "string" && known.has(id)))].slice(0, MODEL_MAX_CHAIN)
    : entries.slice(0, 1).map((entry) => entry.id);
  const llmFallback = typeof decision.llmFallback === "string" && decision.llmFallback.trim() ? decision.llmFallback.trim() : null;
  return { entries, chain, llmFallback };
}

/** 分工里的第一条（主用）。分工是空的时为 null。 */
export function primaryDecision(models: DecisionModels): DecisionEntry | null {
  const id = models.chain[0];
  return id ? models.entries.find((entry) => entry.id === id) ?? null : null;
}

/** 写回 config.json 的 decision。调用方先校验（编号、地址、分工）。旧字段 baseUrl、model 跟着主用写。 */
export function writeDecisionModels(
  dataDir: string,
  next: { models: readonly DecisionEntryInput[]; chain: readonly string[]; llmFallback: string | null },
): void {
  const file = loadPlcConfig(dataDir);
  const primary = next.models.find((entry) => entry.id === next.chain[0]) ?? next.models[0];
  writePlcConfig({
    ...file,
    decision: {
      ...(primary ? { baseUrl: primary.baseUrl, model: primary.model } : {}),
      models: next.models.map((entry) => ({ id: entry.id, name: entry.name, baseUrl: entry.baseUrl, model: entry.model })),
      chain: [...next.chain],
      llmFallback: next.llmFallback,
    },
  }, dataDir);
}

/** 现在 config.json 里的条目，写回时用（地址不合法的那一条保留原样的字符串）。 */
export function decisionEntryInputs(dataDir: string): DecisionEntryInput[] {
  const decision = loadPlcConfig(dataDir).decision ?? {};
  if (!Array.isArray(decision.models)) {
    return [{
      id: LEGACY_DECISION_ID, name: LEGACY_DECISION_ID,
      baseUrl: decision.baseUrl ?? DEFAULT_DECISION_BASE_URL, model: decision.model ?? DEFAULT_DECISION_MODEL,
    }];
  }
  const loaded = new Set(loadDecisionModels(dataDir).entries.map((entry) => entry.id));
  return decision.models
    .filter((entry) => loaded.has(entry.id))
    .map((entry) => ({ id: entry.id, name: entry.name || entry.id, baseUrl: entry.baseUrl, model: entry.model || DEFAULT_DECISION_MODEL }));
}

export interface DecisionKey {
  value: string;
  source: "settings" | "external";
  host: string;
}

/** 一条决策模型的 key：设置页存的（绑定它现在的主机），否则 Keychain / 环境变量里的（只给 api.typesafe.ai）。 */
export function decisionKeyFor(
  entry: Pick<DecisionEntry, "id" | "host">,
  secrets: SealedSecrets<string>,
  externalSecret: (name: string) => string | null,
): DecisionKey | null {
  if (!entry.host) return null;
  const stored = secrets.get(decisionSecretName(entry.id));
  if (stored && stored.host === entry.host) return { value: stored.value, source: "settings", host: entry.host };
  if (entry.host === TYPESAFE_HOST) {
    const external = externalSecret("TYPESAFE_API_KEY");
    if (external) return { value: external, source: "external", host: entry.host };
  }
  return null;
}
