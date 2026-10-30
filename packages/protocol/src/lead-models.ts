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
  // id 里第一个斜杠前的部分（vibeproxy 给账号设的前缀）。没有时为 null。
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
});
export type LeadModelOption = Static<typeof LeadModelOptionSchema>;

export const LeadModelCatalogSchema = StrictObject({
  // 正在用的。模型自动切换（限流、额度）可能暂时换成了别的。
  current: LeadModelChoiceSchema,
  // 你选的（config.json 的 lead.models 的第一个）。
  selected: LeadModelChoiceSchema,
  models: Type.Array(LeadModelOptionSchema),
});
export type LeadModelCatalog = Static<typeof LeadModelCatalogSchema>;

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
 *   bareId: "claude-sonnet-5", effort: "high" }。
 */
export function parseLeadModelSpec(spec: string): {
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
    bareId: id.slice(id.lastIndexOf("/") + 1),
    effort,
  };
}

export function leadModelSpec(choice: LeadModelChoice): string {
  return choice.effort ? `${choice.model}(${choice.effort})` : choice.model;
}
