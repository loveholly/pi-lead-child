// 设置 → 模型（方案 B，2026-10-29，.scratch/model-settings/spec.md）。
//
// 两类模型：
//   - 大脑（brain）：Lead 自己的 LLM。分工是 config.json 的 lead.models（第一个主用，后面是备用），模型来自 lead.providers（服务商）。
//   - 直觉（fast）：决策模型（TypeSafe 的 Jev 或者兼容的端点，POST <地址>/v1/systemone）。可以配多条，分工是 decision.chain。
// 每类一个主用，最多 MODEL_MAX_BACKUPS 个备用。主用出问题时按顺序换到备用。直觉都用不了时问大脑（fast.llmFallback）。
//
// 页面读 GET /v1/models/settings（tickets:view）。改动都是操作层的操作（ui-actions.ts 的 model_settings），页面和 Lead 调同一个函数。
// 变化时网关发 snapshot.required，payload 是 {resource: "model-settings"}，客户端重新 GET。
// /v1/decision-model（直觉的主用）和 /v1/lead/models（输入框的模型选择）照旧：它们的 DTO 是严格的契约，这里不往里加字段。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { LeadModelChoiceSchema } from "./lead-models.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const MODEL_SETTINGS_RESOURCE = "model-settings";
// 每类最多几个备用（用户 2026-10-29）。加上主用，一条分工最多 MODEL_MAX_BACKUPS + 1 个。
export const MODEL_MAX_BACKUPS = 3;
export const MODEL_MAX_CHAIN = MODEL_MAX_BACKUPS + 1;

const HttpUrlSchema = Type.String({ pattern: "^https?://[^\\s]{1,500}$" });
const ApiKeySchema = Type.String({ minLength: 1, maxLength: 400 });
const KeyHostSchema = Nullable(Type.String({ minLength: 1, maxLength: 260 }));
const IsoTimeSchema = Type.String({ minLength: 10, maxLength: 40 });

// 服务商的名字：模型写成 <名字>/<id>，所以名字里不能有斜杠。
export const MODEL_PROVIDER_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,31}$";
export const ModelProviderNameSchema = Type.String({ pattern: MODEL_PROVIDER_NAME_PATTERN });
// 直觉一条的编号（config.json 的 decision.models[].id）。旧配置读成的那一条是 jev。
export const FastModelIdSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" });
export const FastModelNameSchema = Type.String({ minLength: 1, maxLength: 40 });
export const FastModelModelSchema = Type.String({ pattern: "^[A-Za-z0-9._-]{1,64}$" });

// 服务商的接口格式（packages/lead 的 OPENAI_COMPATIBLE_APIS）。
export const ModelProviderApiSchema = Type.Union([
  Type.Literal("openai-completions"), Type.Literal("openai-responses"),
  Type.Literal("anthropic-messages"), Type.Literal("google-generative-ai"),
]);
export type ModelProviderApi = Static<typeof ModelProviderApiSchema>;

// key 从哪来：settings 是设置页存的（保险库）；config 是 config.json 里手写的；env 是 Keychain 或者 daemon 的环境变量。
// 页面只能删 settings 的。
export const ModelKeySourceSchema = Nullable(Type.Union([Type.Literal("settings"), Type.Literal("config"), Type.Literal("env")]));
export type ModelKeySource = Static<typeof ModelKeySourceSchema>;

// 发布时间。source 是 provider：服务商的目录给的；first_seen：目录没给，这是 daemon 第一次看到它的时间。
export const ModelReleaseSchema = StrictObject({
  at: IsoTimeSchema,
  source: Type.Union([Type.Literal("provider"), Type.Literal("first_seen")]),
});
export type ModelRelease = Static<typeof ModelReleaseSchema>;

// 服务商目录里的一个模型。
export const BrainModelSchema = StrictObject({
  // provider/id，不带推理强度。分工里写的就是它。
  model: Type.String({ minLength: 3, maxLength: 300 }),
  // 目录里的 id，例如 as4/claude-sonnet-5-5。
  id: Type.String({ minLength: 1, maxLength: 300 }),
  // 目录给的显示名。没有时为 null。
  name: Nullable(Type.String({ maxLength: 200 })),
  image: Type.Boolean(),
  // 上下文窗口（目录给的）。没有时为 null。
  contextWindow: Nullable(Type.Integer({ minimum: 1 })),
  efforts: Type.Array(Type.String({ minLength: 1, maxLength: 32 })),
  defaultEffort: Nullable(Type.String({ minLength: 1, maxLength: 32 })),
  released: Nullable(ModelReleaseSchema),
  // 额度用完、模型自动切换在跳过它，到这个时间（ISO）。没有时为 null。
  blockedUntil: Nullable(IsoTimeSchema),
});
export type BrainModel = Static<typeof BrainModelSchema>;

export const ModelProviderSchema = StrictObject({
  name: ModelProviderNameSchema,
  baseUrl: Type.String({ minLength: 1, maxLength: 500 }),
  api: ModelProviderApiSchema,
  keySet: Type.Boolean(),
  keySource: ModelKeySourceSchema,
  // 页面存的 key 绑定的主机。没有时为 null。
  keyHost: KeyHostSchema,
  // 目录里的模型，最新发布的在前面。目录拉不到时是 config.json 里写的那几个（可能是空的）。
  models: Type.Array(BrainModelSchema, { maxItems: 2000 }),
  // 目录拉不到的原因。没问题时为 null。
  problem: Nullable(Type.String({ maxLength: 500 })),
});
export type ModelProvider = Static<typeof ModelProviderSchema>;

export const BrainSettingsSchema = StrictObject({
  // 分工：第一个主用，后面是备用。
  chain: Type.Array(LeadModelChoiceSchema, { maxItems: MODEL_MAX_CHAIN }),
  // 正在用的。模型自动切换（限流、额度）可能暂时换成了备用。
  current: LeadModelChoiceSchema,
  providers: Type.Array(ModelProviderSchema, { maxItems: 32 }),
});
export type BrainSettings = Static<typeof BrainSettingsSchema>;

export const FastModelSchema = StrictObject({
  id: FastModelIdSchema,
  name: FastModelNameSchema,
  // config.json 里的地址不合法时是 null，problem 说明原因。
  baseUrl: Nullable(HttpUrlSchema),
  model: FastModelModelSchema,
  apiKeySet: Type.Boolean(),
  apiKeySource: ModelKeySourceSchema,
  apiKeyHost: KeyHostSchema,
  problem: Nullable(Type.String({ maxLength: 500 })),
});
export type FastModel = Static<typeof FastModelSchema>;

export const FastSettingsSchema = StrictObject({
  models: Type.Array(FastModelSchema, { maxItems: 32 }),
  // 分工：直觉的编号，第一个主用，后面是备用。空数组：不用直觉，判断都问大脑。
  chain: Type.Array(FastModelIdSchema, { maxItems: MODEL_MAX_CHAIN }),
  // 你选的「都用不了时问大脑的哪个模型」。null：没选，系统按 effectiveLlm 选。
  llmFallback: Nullable(LeadModelChoiceSchema),
  // 现在实际会问的大脑模型（provider/id）。没有 LLM 后端时为 null。
  effectiveLlm: Nullable(Type.String({ minLength: 3, maxLength: 300 })),
});
export type FastSettings = Static<typeof FastSettingsSchema>;

export const ModelSettingsDtoSchema = StrictObject({
  brain: BrainSettingsSchema,
  fast: FastSettingsSchema,
  maxBackups: Type.Integer({ minimum: 0, maximum: 8 }),
});
export type ModelSettingsDto = Static<typeof ModelSettingsDtoSchema>;

export const ModelSettingsResponseSchema = StrictObject({ modelSettings: ModelSettingsDtoSchema });
export type ModelSettingsResponse = Static<typeof ModelSettingsResponseSchema>;

// ── 操作的输入（ui-actions.ts 的 model_settings）──────────────────────────────────

export const SetBrainChainRequestSchema = StrictObject({
  models: Type.Array(LeadModelChoiceSchema, { minItems: 1, maxItems: MODEL_MAX_CHAIN }),
});
export type SetBrainChainRequest = Static<typeof SetBrainChainRequestSchema>;

// 接入或修改一个服务商。apiKey：字符串是新的 key；null 删掉页面存的 key；不给时不变（换了主机时页面存的 key 删掉）。
export const SaveModelProviderRequestSchema = StrictObject({
  name: ModelProviderNameSchema,
  baseUrl: HttpUrlSchema,
  api: ModelProviderApiSchema,
  apiKey: Type.Optional(Nullable(ApiKeySchema)),
});
export type SaveModelProviderRequest = Static<typeof SaveModelProviderRequestSchema>;

export const RemoveModelProviderRequestSchema = StrictObject({ name: ModelProviderNameSchema });
export type RemoveModelProviderRequest = Static<typeof RemoveModelProviderRequestSchema>;

// 添加（不给 id）或修改（给 id）一条直觉。apiKey 的写法同服务商。
export const SaveFastModelRequestSchema = StrictObject({
  id: Type.Optional(FastModelIdSchema),
  name: FastModelNameSchema,
  baseUrl: HttpUrlSchema,
  model: FastModelModelSchema,
  apiKey: Type.Optional(Nullable(ApiKeySchema)),
});
export type SaveFastModelRequest = Static<typeof SaveFastModelRequestSchema>;

export const FastModelIdRequestSchema = StrictObject({ id: FastModelIdSchema });
export type FastModelIdRequest = Static<typeof FastModelIdRequestSchema>;

// 直觉的分工和问大脑时用的模型。llmFallback 不给时不变，null 时改回系统自己选。
export const SetFastChainRequestSchema = StrictObject({
  chain: Type.Array(FastModelIdSchema, { maxItems: MODEL_MAX_CHAIN }),
  llmFallback: Type.Optional(Nullable(LeadModelChoiceSchema)),
});
export type SetFastChainRequest = Static<typeof SetFastChainRequestSchema>;

// 一个分工是不是合法：不空、不超过上限、没有重复。返回问题，没问题时为 null。key 把同一个模型的几种写法认成一个。
export function modelChainProblem<T>(chain: readonly T[], key: (item: T) => string, options: { allowEmpty?: boolean } = {}): string | null {
  if (chain.length === 0 && !options.allowEmpty) return "至少要有一个主用";
  if (chain.length > MODEL_MAX_CHAIN) return `备用最多 ${MODEL_MAX_BACKUPS} 个`;
  const seen = new Set<string>();
  for (const item of chain) {
    const id = key(item);
    if (seen.has(id)) return `${id} 出现了两次`;
    seen.add(id);
  }
  return null;
}
