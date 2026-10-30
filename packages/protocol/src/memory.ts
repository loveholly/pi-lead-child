// Lead 的记忆和决策模型（设置页「Lead → 记忆 / 模型」）的线上契约。
// - 路由都是 GET 或 POST（网关的 CORS 只放行这两种）。读用 tickets:view，改用 tickets:create，
//   确认待切换用 approvals:respond。Lead 的工具走不到这些路由，所以确认只能来自用户。
// - 密钥只进不出：请求里可以带 apiKey，响应里只有 apiKeySet 和它绑定的主机。
// - key 绑定主机（2026-10-16 发布评审）：存 key 时记下当时的主机，只发给这个主机。baseUrl 换到别的主机而请求里
//   没带新 key 时，旧 key 删掉（响应里 apiKeySet 变成 false）。Keychain 或环境变量里的 TYPESAFE_API_KEY 只发给
//   api.typesafe.ai。
// - 地址的规则见 service-url.ts（serviceUrlProblem）。不合法时回 400，details.reason 是 invalid_url。
// - 变化时网关发 snapshot.required，payload 是 {resource: "memory"} 或 {resource: "decision-model"}，客户端重新 GET。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>>(schema: T) =>
  Type.Union([schema, Type.Null()]);

// Hugging Face 的模型 id：owner/name。
export const HuggingFaceModelIdSchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$",
});
// 只挡明显不对的；完整的规则在 service-url.ts，路由和 MemoryController 都用它。
const HttpUrlSchema = Type.String({ pattern: "^https?://[^\\s]{1,500}$" });
// key 绑定的主机（小写，带端口时带端口）。
const KeyHostSchema = Nullable(Type.String({ minLength: 1, maxLength: 260 }));
const RemoteModelSchema = Type.String({ pattern: "^[^\\s]{1,128}$" });
const ApiKeySchema = Type.String({ minLength: 1, maxLength: 400 });
export const MemorySwitchIdSchema = Type.String({ pattern: "^msw_[A-Za-z0-9_-]{8,40}$" });

// 本地模型的下载。只有用户选了本地模型才会下载。
export const MemoryDownloadSchema = StrictObject({
  model: HuggingFaceModelIdSchema,
  state: Type.Union([Type.Literal("idle"), Type.Literal("downloading"), Type.Literal("ready"), Type.Literal("failed")]),
  bytes: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  error: Nullable(Type.String()),
});
export type MemoryDownload = Static<typeof MemoryDownloadSchema>;

export const MemoryEmbeddingSettingsSchema = StrictObject({
  // unset：还没选。这时有远程配置就用远程，否则只用 SQLite 全文检索。
  mode: Type.Union([Type.Literal("unset"), Type.Literal("local"), Type.Literal("remote")]),
  local: StrictObject({ model: HuggingFaceModelIdSchema, download: MemoryDownloadSchema }),
  remote: StrictObject({
    baseUrl: Nullable(HttpUrlSchema),
    model: Nullable(RemoteModelSchema),
    dimensions: Nullable(Type.Integer({ minimum: 1, maximum: 8192 })),
    apiKeySet: Type.Boolean(),
    // 存的 key 绑定在哪个主机。和 baseUrl 的主机不同时（例如手改了 config.json），key 不会发出去，apiKeySet 是 false。
    apiKeyHost: KeyHostSchema,
  }),
});

export const MemoryRerankerModeSchema = Type.Union([Type.Literal("decision"), Type.Literal("local"), Type.Literal("none")]);
export const MemoryRerankerSettingsSchema = StrictObject({
  mode: MemoryRerankerModeSchema,
  // 实际在用的：选了决策模型却没有 key 时是 none；本地模型还没下好时是选它之前的那一个。
  effective: MemoryRerankerModeSchema,
  local: StrictObject({ model: HuggingFaceModelIdSchema, download: MemoryDownloadSchema }),
  // 决策模型做 reranker、会把数据发出去时不是 null：每次召回把查询和最多 maxCandidates 条记忆片段发给 host。
  // 按设置算（不管是不是在等确认）。maxCandidates 在 config.json 的 memory.reranker.maxCandidates 里改。
  external: Type.Union([
    StrictObject({ host: Type.String({ minLength: 1 }), maxCandidates: Type.Integer({ minimum: 1, maximum: 300 }) }),
    Type.Null(),
  ]),
});

// 一个切换新增的数据外发：从这次切换开始，笔记的内容会发给 host。
// embedding：全部笔记（建索引）；rerank：每次召回的查询和最多 maxCandidates 条记忆片段。
export const MemoryDataFlowSchema = StrictObject({
  kind: Type.Union([Type.Literal("embedding"), Type.Literal("rerank")]),
  host: Type.String({ minLength: 1 }),
  maxCandidates: Nullable(Type.Integer({ minimum: 1, maximum: 300 })),
});
export type MemoryDataFlow = Static<typeof MemoryDataFlowSchema>;

export const MemorySwitchSchema = StrictObject({
  id: MemorySwitchIdSchema,
  // 一句话说要切到什么，例如「embedding 换成本地 BAAI/bge-m3」。
  summary: Type.String(),
  // 为什么要确认，例如「重建 120 条笔记的索引：每条一次 LLM 调用，重建完之前按意思召回不完整」。
  reason: Type.String(),
  needsConfirmation: Type.Boolean(),
  // 这个切换新增的数据外发。reason 里有同样的事实，这里给设置页自己排版。
  dataFlows: Type.Array(MemoryDataFlowSchema),
  // 在等这次确认、还没生效的部分。只差外部 reranker 时是 ["reranker"]：embedding 已经先生效，
  // 设置页照常显示它「正在用」（2026-10-16 发布评审）。
  parts: Type.Array(Type.Union([Type.Literal("embedding"), Type.Literal("reranker")])),
  // superseded：等确认时设置又变了，这个切换作废。
  state: Type.Union([Type.Literal("pending"), Type.Literal("applied"), Type.Literal("rejected"), Type.Literal("superseded")]),
  createdAt: Type.String(),
});
export type MemorySwitch = Static<typeof MemorySwitchSchema>;

export const MemoryServiceSchema = StrictObject({
  // off：没有可用的 embedding，或者 PLC_MEMORY_BACKEND=sqlite，只用 SQLite 全文检索。
  state: Type.Union([Type.Literal("off"), Type.Literal("starting"), Type.Literal("healthy"), Type.Literal("down")]),
  embedding: Nullable(Type.String()),
  reranker: Nullable(Type.String()),
  // 当前索引里同步了多少条笔记。
  index: StrictObject({ notes: Type.Integer({ minimum: 0 }), indexed: Type.Integer({ minimum: 0 }) }),
  message: Nullable(Type.String()),
  // sqlite：daemon 的环境里设了 PLC_MEMORY_BACKEND=sqlite（或者一个不认识的值），这台 Mac 上关掉了 Hindsight。
  // 这时 state 是 off，没下完的模型也不继续下。hindsight：按设置运行（state 是 off 时是还没有可用的 embedding）。
  backend: Type.Union([Type.Literal("hindsight"), Type.Literal("sqlite")]),
});

export const MemorySettingsDtoSchema = StrictObject({
  embedding: MemoryEmbeddingSettingsSchema,
  reranker: MemoryRerankerSettingsSchema,
  service: MemoryServiceSchema,
  pendingSwitch: Type.Union([MemorySwitchSchema, Type.Null()]),
});
export type MemorySettingsDto = Static<typeof MemorySettingsDtoSchema>;

export const MemoryResponseSchema = StrictObject({ memory: MemorySettingsDtoSchema });
export type MemoryResponse = Static<typeof MemoryResponseSchema>;

// POST /v1/memory/settings：只带要改的部分。
export const MemorySettingsRequestSchema = StrictObject({
  embedding: Type.Optional(Type.Union([
    StrictObject({ mode: Type.Literal("unset") }),
    StrictObject({ mode: Type.Literal("local"), model: Type.Optional(HuggingFaceModelIdSchema) }),
    StrictObject({
      mode: Type.Literal("remote"),
      baseUrl: HttpUrlSchema,
      model: RemoteModelSchema,
      dimensions: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 8192 }))),
      // 不带时保留已存的 key。
      apiKey: Type.Optional(ApiKeySchema),
    }),
  ])),
  reranker: Type.Optional(Type.Union([
    StrictObject({ mode: Type.Literal("decision") }),
    StrictObject({ mode: Type.Literal("local"), model: Type.Optional(HuggingFaceModelIdSchema) }),
    StrictObject({ mode: Type.Literal("none") }),
  ])),
});
export type MemorySettingsRequest = Static<typeof MemorySettingsRequestSchema>;

// POST /v1/memory/test：用已存的远程 embedding 配置发一次请求。
export const MemoryTestResponseSchema = StrictObject({
  ok: Type.Boolean(),
  message: Type.String(),
  latencyMs: Nullable(Type.Integer({ minimum: 0 })),
});
export type MemoryTestResponse = Static<typeof MemoryTestResponseSchema>;

// POST /v1/memory/switches/:id/confirm
export const MemorySwitchConfirmRequestSchema = StrictObject({ approve: Type.Boolean() });
export type MemorySwitchConfirmRequest = Static<typeof MemorySwitchConfirmRequestSchema>;

// GET /v1/memory/switches/:id：会话里的 MemorySwitchConfirm 卡按 id 读这个切换，包括已经处理过的。
// daemon 只记最近的一个切换；更早的 id 回 404。
export const MemorySwitchResponseSchema = StrictObject({ switch: MemorySwitchSchema });
export type MemorySwitchResponse = Static<typeof MemorySwitchResponseSchema>;

// POST /v1/memory/switches/:id/confirm 的响应：卡片用 switch，设置页用 memory。
export const MemorySwitchConfirmResponseSchema = StrictObject({ memory: MemorySettingsDtoSchema, switch: MemorySwitchSchema });
export type MemorySwitchConfirmResponse = Static<typeof MemorySwitchConfirmResponseSchema>;

// 决策模型：TypeSafe 的 Jev，或者用户自建的兼容端点（POST <baseUrl>/v1/systemone）。
// SmartModel 和记忆的 reranker 共用它。
export const DecisionModelDtoSchema = StrictObject({
  // config.json 里的地址不合法时是 null，problem 说明原因。这时 SmartModel 只用 LLM，reranker 不用决策模型。
  baseUrl: Nullable(HttpUrlSchema),
  model: Type.String({ pattern: "^[A-Za-z0-9._-]{1,64}$" }),
  apiKeySet: Type.Boolean(),
  // key 从哪来：settings 是设置页存的（保险库）；external 是 Keychain 或者 daemon 的环境变量里的 TYPESAFE_API_KEY。
  // 设置页删掉自己存的 key 以后，有 external 的 key 时还是用它。设置页删不掉 external 的 key，要提示用户去 Keychain 里删。
  apiKeySource: Type.Union([Type.Literal("settings"), Type.Literal("external"), Type.Null()]),
  // 在用的 key 发给哪个主机；没有 key 时是设置页存的 key 绑定的主机（和 baseUrl 不同时不会发出去），都没有时是 null。
  apiKeyHost: KeyHostSchema,
  problem: Nullable(Type.String()),
});
export type DecisionModelDto = Static<typeof DecisionModelDtoSchema>;

export const DecisionModelResponseSchema = StrictObject({ decisionModel: DecisionModelDtoSchema });
export type DecisionModelResponse = Static<typeof DecisionModelResponseSchema>;

// POST /v1/decision-model/settings。apiKey 为 null 时删掉已存的 key。
export const DecisionModelSettingsRequestSchema = StrictObject({
  baseUrl: Type.Optional(HttpUrlSchema),
  model: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._-]{1,64}$" })),
  apiKey: Type.Optional(Type.Union([ApiKeySchema, Type.Null()])),
});
export type DecisionModelSettingsRequest = Static<typeof DecisionModelSettingsRequestSchema>;
