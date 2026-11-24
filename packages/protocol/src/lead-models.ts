// Lead 的模型选择（2026-10-26）：会话输入框右下角写着 Lead 正在用的模型和推理强度，点开是可选的模型，按来源分组。
//
// 模型写成 provider/id，例如 vibeproxy/as4/claude-sonnet-5。id 里第一个斜杠前的部分是 vibeproxy 给账号设的前缀（as1、as4），
// 用户据此分清两个 Anthropic 账号。推理强度写在 id 后面的括号里（vibeproxy/as4/claude-sonnet-5(high)）：vibeproxy（CLIProxyAPI）
// 去掉括号，换成上游的参数。
//
// GET /v1/lead/models 给目录；POST /v1/lead/model 换模型。换模型是操作层的一个操作（ui-actions.ts 的 lead_model / switch），
// Lead 的 switch_lead_model 和 perform_action 走同一个函数。
import { Type, type Static, type TProperties, type TSchema } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const LeadModelEffortSchema = Type.String({ minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9_-]+$" });

// 一个模型和它的推理强度。effort 为 null：不加后缀，用模型自己的缺省。
export const LeadModelChoiceSchema = StrictObject({
  // provider/id，不带推理强度。
  model: Type.String({ minLength: 3, maxLength: 300 }),
  effort: Nullable(LeadModelEffortSchema),
});
export type LeadModelChoice = Static<typeof LeadModelChoiceSchema>;

export const LeadModelOptionSchema = StrictObject({
  // 选它时交回来的 provider/id（不带推理强度），例如 vibeproxy/as4/claude-sonnet-5。
  model: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  // 目录里的 id，去掉 provider，例如 as4/claude-sonnet-5。
  id: Type.String({ minLength: 1 }),
  // 账号（group）：id 里第一个斜杠前的部分，只在这家服务商的 accountPrefix 生效时才有（vibeproxy 的 as1、as4）。
  // magpie 的 auto/deepseek-flash 这类前缀不是账号，为 null。字段名沿用 prefix：这个 DTO 是严格的契约，不改名。
  prefix: Nullable(Type.String()),
  // 上游，例如 anthropic、antigravity。不知道时为 null。
  source: Nullable(Type.String()),
  // 目录给的显示名。没有时为 null。
  name: Nullable(Type.String()),
  // 能不能看图片。
  image: Type.Boolean(),
  // 可以选的推理强度。空数组：这个模型不能选。
  efforts: Type.Array(LeadModelEffortSchema),
  defaultEffort: Nullable(LeadModelEffortSchema),
  // 额度用完、模型自动切换在跳过它，到这个时间（ISO）。没有时为 null。
  blockedUntil: Nullable(Type.String()),
  // 通道（magpie 的 routing group、Claude Code、Codex；字段名用 route，model-groups.ts 的 channel 是 owned_by）：同一个显示名走不同通道时靠它分开。只有 magpie 有。
  // 可选，只在客户端带 LEAD_MODELS_LIVE_QUERY 时给：这个 DTO 是严格的契约，旧版 Companion 多一个字段就整份拒收。
  route: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 80 }))),
});
export type LeadModelOption = Static<typeof LeadModelOptionSchema>;

// magpie 的路由前缀（id 里第一个斜杠前的部分）和它们的显示名：目录条目没有 magpie_label 时，通道（route）按它兜底
// （lead 的 magpieRoute）。这是 magpie 目录的约定，不是 PLC 的 runtime。放在 protocol 里：内核模块的代码不写 runtime 的
// 名字（apps/daemon/test/runtime-architecture.test.ts），而这几个前缀恰好和 runtime 同名。
export const MAGPIE_ROUTE_NAMES: Readonly<Record<string, string>> = { auto: "Auto", claude: "Claude Code", codex: "Codex" };

export const LeadModelCatalogSchema = StrictObject({
  // 正在用的。模型自动切换（限流、额度）可能暂时换成了别的。
  current: LeadModelChoiceSchema,
  // 你选的（config.json 的 lead.models 的第一个）。
  selected: LeadModelChoiceSchema,
  models: Type.Array(LeadModelOptionSchema),
  // Lead 的会话此刻真正挂着的模型（provider/id），带订阅的账号：current 写分工的格子（openai-codex/gpt-5.5），
  // 这里写 pi-multi-pass 换上的账号（openai-codex-2/gpt-5.5）；「只这一条」的那一轮里是那一轮的模型。不知道时为 null。
  // 可选，只在客户端带 LEAD_MODELS_LIVE_QUERY 时给：这个 DTO 是严格的契约，旧版 Companion 多一个字段就整份拒收。
  inSession: Type.Optional(Nullable(Type.String({ minLength: 3, maxLength: 300 }))),
});
export type LeadModelCatalog = Static<typeof LeadModelCatalogSchema>;

// 客户端要 inSession 时，GET /v1/lead/models 带的查询参数（模型配置方案 C 的 S4，会话里换模型的浮层）。
export const LEAD_MODELS_LIVE_QUERY = "live=1";

// 「只这一条」（模型配置方案 C 的 D8）：chat.send 带一个单轮模型（turnModel），daemon 用它答这一条消息，答完回到分工的主用，
// 不改 config.json。daemon 宣布了这个能力时客户端才带 turnModel：旧 daemon 严格校验命令，多一个字段整条拒收。
// hello.v2 是严格的契约，能力写在已有的 capabilities 数组里，不加字段。
export const CHAT_TURN_MODEL_CAPABILITY = "chat.turn-model.v1";

export const LeadModelSwitchResultSchema = StrictObject({
  previous: LeadModelChoiceSchema,
  selected: LeadModelChoiceSchema,
  // now：已经换好；after_turn：Lead 正在回答，这一轮结束以后换；unchanged：本来就是它。
  applied: Type.Union([Type.Literal("now"), Type.Literal("after_turn"), Type.Literal("unchanged")]),
});
export type LeadModelSwitchResult = Static<typeof LeadModelSwitchResultSchema>;

const EFFORT_SUFFIX = /^(.+)\(([A-Za-z0-9_-]{1,32})\)$/;

/**
 * 拆开一个模型 spec：vibeproxy/as4/claude-sonnet-5(high) →
 * { model: "vibeproxy/as4/claude-sonnet-5", provider: "vibeproxy", id: "as4/claude-sonnet-5", prefix: "as4",
 *   bareId: "as4/claude-sonnet-5", effort: "high" }。
 *
 * prefix 只是 id 里第一个斜杠前的部分，不一定是账号。bareId 是显示用的 id：给了 group（账号）时去掉它，
 * 没给或者为 null 时是完整的 id。只取最后一个斜杠后面的部分会把 auto/deepseek-flash 和 deepseek/deepseek-flash
 * 显示成同一个名字（Lead 模型分组，2026-11-05）。
 */
export function parseLeadModelSpec(spec: string, group: string | null = null): {
  model: string; provider: string; id: string; prefix: string | null; bareId: string; effort: string | null;
} {
  const trimmed = spec.trim();
  const match = EFFORT_SUFFIX.exec(trimmed);
  const model = match ? match[1]! : trimmed;
  const effort = match ? match[2]! : null;
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const id = slash > 0 ? model.slice(slash + 1) : model;
  const prefixEnd = id.indexOf("/");
  return {
    model, provider, id,
    prefix: prefixEnd > 0 ? id.slice(0, prefixEnd) : null,
    bareId: leadModelDisplayId(id, group),
    effort,
  };
}

/** 显示用的模型 id：有账号（group）时去掉 「<group>/」，没有时是完整的 id。 */
export function leadModelDisplayId(id: string, group: string | null): string {
  return group && id.startsWith(`${group}/`) ? id.slice(group.length + 1) : id;
}

export function leadModelSpec(choice: LeadModelChoice): string {
  return choice.effort ? `${choice.model}(${choice.effort})` : choice.model;
}
