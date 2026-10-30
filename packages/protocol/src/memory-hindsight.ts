// 设置 → 记忆的 Hindsight 部分：摘要模型、笔记的写入情况、记忆库的统计（2026-10-29，.scratch/hindsight-primary-memory/spec.md D3、D13、D16）。
//
// 页面读 GET /v1/memory/hindsight（tickets:view）。改动是操作层的操作（ui-actions.ts 的 memory_settings，编号 memory），
// 页面和 Lead 调同一个函数。变化时网关发 snapshot.required，payload 是 {resource: "memory"}，客户端重新 GET /v1/memory 和这里。
// /v1/memory 的 DTO（memory.ts）是严格的契约，旧客户端会拒收多出来的字段，所以这些不往那里加。
//
// 摘要模型：Hindsight 用 LLM 提取事实（retain）和整理观察（consolidation）。两个槽：
//   - default：缺省。提取事实用它；整理观察没单独选时也用它。
//   - consolidation：整理观察。要判断哪条取代哪条，可能需要比缺省强的模型。没选时跟缺省一样。
// 模型来自 Lead 的模型目录（设置 → 模型的服务商），写成 provider/id。key 不经过这里：daemon 按服务商解析，加密交给 Hindsight。
// 改了以后记忆服务重启，几秒里召回只用全文检索。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const SUMMARY_MODEL_SLOTS = ["default", "consolidation"] as const;
export type SummaryModelSlot = typeof SUMMARY_MODEL_SLOTS[number];
export const SummaryModelSlotSchema = Type.Union([Type.Literal("default"), Type.Literal("consolidation")]);

// 这个槽现在的模型是怎样选出来的：
//   env       daemon 的环境变量 PLC_HINDSIGHT_LLM（只管缺省槽）。设了它时，页面上的选择不生效。
//   settings  用户选的（config.json 的 memory.llm）。
//   auto      自动：Lead 模型目录里版本最新的 haiku（缺省槽）。
//   inherit   跟缺省一样（整理观察槽没单独选）。
//   none      没有可用的模型：Hindsight 只召回，不提取新事实。
export const SUMMARY_MODEL_SOURCES = ["env", "settings", "auto", "inherit", "none"] as const;
export type SummaryModelSource = typeof SUMMARY_MODEL_SOURCES[number];

// provider/id，不带推理强度。
export const SummaryModelSpecSchema = Type.String({ minLength: 3, maxLength: 300, pattern: "^[a-z0-9][a-z0-9_-]{0,31}/\\S+$" });

export const SummaryModelSlotDtoSchema = StrictObject({
  slot: SummaryModelSlotSchema,
  // 现在用的模型（provider/id）。没有时为 null。
  model: Nullable(Type.String({ maxLength: 300 })),
  source: Type.Union([Type.Literal("env"), Type.Literal("settings"), Type.Literal("auto"), Type.Literal("inherit"), Type.Literal("none")]),
  // 存在设置里的选择。null：没选（缺省槽是自动，整理观察槽跟缺省一样）。
  setting: Nullable(Type.String({ maxLength: 300 })),
  // 选的模型用不了的原因（例如服务商不在了、环境变量盖住了设置）。没问题时为 null。
  problem: Nullable(Type.String({ maxLength: 500 })),
});
export type SummaryModelSlotDto = Static<typeof SummaryModelSlotDtoSchema>;

export const MemoryWritesDtoSchema = StrictObject({
  // SQLite 里的笔记条数。
  notes: Type.Integer({ minimum: 0 }),
  // 当前记忆库里写完的、还在处理的、失败的笔记条数。
  completed: Type.Integer({ minimum: 0 }),
  pending: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  // 最近一次失败的原因（脱敏过）。
  lastError: Nullable(Type.String({ maxLength: 500 })),
});
export type MemoryWritesDto = Static<typeof MemoryWritesDtoSchema>;

export const MemoryBankStatsDtoSchema = StrictObject({
  documents: Type.Integer({ minimum: 0 }),
  facts: Type.Integer({ minimum: 0 }),
  observations: Type.Integer({ minimum: 0 }),
  // 还没整理进观察的事实条数。
  pendingConsolidation: Type.Integer({ minimum: 0 }),
});
export type MemoryBankStatsDto = Static<typeof MemoryBankStatsDtoSchema>;

// 设置页列出的失效事实最多几条。
export const MEMORY_INVALIDATED_LIMIT = 20;

// 一条现在失效着的事实（Hindsight 从笔记里提取的一句话，2026-10-29「hindsight 的 invalidate 机制要有啊」）。
// 恢复走操作层的 memory_fact / <memoryId> / restore。
export const MemoryInvalidatedFactDtoSchema = StrictObject({
  // Hindsight 的记忆编号：恢复用它。
  memoryId: Type.String({ minLength: 1 }),
  // 事实的原文。不知道时为 null。
  text: Nullable(Type.String()),
  // 它来自哪条笔记（还在时）。
  note: Nullable(StrictObject({ id: Type.Integer({ minimum: 1 }), title: Type.String() })),
  // 外部对话整理来的：记的是别人说的话。
  external: Type.Boolean(),
  // 为什么失效（依据）。
  reason: Type.String(),
  // 谁让它失效的：user 你本人，lead 是 Lead。
  actor: Type.Union([Type.Literal("user"), Type.Literal("lead")]),
  // 失效的时间（ISO）。
  at: Type.String(),
});
export type MemoryInvalidatedFactDto = Static<typeof MemoryInvalidatedFactDtoSchema>;

export const MemoryHindsightDtoSchema = StrictObject({
  // 记忆后端选的是不是 Hindsight（PLC_MEMORY_BACKEND）。
  enabled: Type.Boolean(),
  summaryModels: Type.Array(SummaryModelSlotDtoSchema, { maxItems: SUMMARY_MODEL_SLOTS.length }),
  writes: MemoryWritesDtoSchema,
  // Hindsight 没在运行、或者查不到时为 null。
  stats: Nullable(MemoryBankStatsDtoSchema),
  // 现在失效着的事实，最近失效的在前，最多 MEMORY_INVALIDATED_LIMIT 条。daemon 总是给；没有这一项的按空的处理。
  invalidated: Type.Optional(Type.Array(MemoryInvalidatedFactDtoSchema, { maxItems: MEMORY_INVALIDATED_LIMIT })),
});
export type MemoryHindsightDto = Static<typeof MemoryHindsightDtoSchema>;

export const MemoryHindsightResponseSchema = StrictObject({ hindsight: MemoryHindsightDtoSchema });
export type MemoryHindsightResponse = Static<typeof MemoryHindsightResponseSchema>;

// 操作的输入（ui-actions.ts 的 memory_settings）。

// 选一个槽的模型。model 为 null：缺省槽改回自动，整理观察槽改回跟缺省一样。
export const SetSummaryModelRequestSchema = StrictObject({
  slot: SummaryModelSlotSchema,
  model: Nullable(SummaryModelSpecSchema),
});
export type SetSummaryModelRequest = Static<typeof SetSummaryModelRequestSchema>;

export const SummaryModelSlotRequestSchema = StrictObject({ slot: SummaryModelSlotSchema });
export type SummaryModelSlotRequest = Static<typeof SummaryModelSlotRequestSchema>;

// ── 事实失效：Lead 动态（2026-10-29）────────────────────────────────────────────────
// Lead 让一条事实失效（或者恢复）时写一条 memory_fact.changed（digest 级），「Lead 动态」里出现一张卡，卡上带「撤销」
// （lead-activity.ts 的 LeadActivityCard.action：{target: {type: "memory_fact", id: <memoryId>}, action: "restore"}）。
// 用户撤销（恢复）Lead 的失效时同一个对象再写一条，卡原地更新，按钮消失。用户自己在设置页做的不写这条事件。

export const MEMORY_FACT_CHANGED_KIND = "memory_fact.changed";

/** 一条事实的对象键：memory_fact:<Hindsight 的记忆编号>。 */
export function memoryFactEntityKey(memoryId: string): string {
  return `memory_fact:${memoryId}`;
}

export const MemoryFactChangedPayloadSchema = Type.Object({
  memoryId: Type.String({ minLength: 1 }),
  // 这条事件报告的失效或恢复记录（store 的 memory_invalidations）。
  invalidationId: Type.Integer({ minimum: 1 }),
  action: Type.Union([Type.Literal("invalidated"), Type.Literal("restored")]),
  actor: Type.Union([Type.Literal("user"), Type.Literal("lead")]),
  // 这次恢复撤销的是哪一次失效（那一次的记录编号）；不是撤销时是 null。
  undoOf: Nullable(Type.Integer({ minimum: 1 })),
  text: Nullable(Type.String()),
  noteId: Nullable(Type.Integer({ minimum: 1 })),
  noteTitle: Nullable(Type.String()),
  external: Type.Boolean(),
  reason: Type.String(),
  // 对用户说的那句话，例如「Fairy 让一条记忆失效：「用户住在杭州」（来自「住址」）。依据：…」。
  summary: Type.String(),
});
export type MemoryFactChangedPayload = Static<typeof MemoryFactChangedPayloadSchema>;

export const MEMORY_FACT_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    // Lead 让一条事实失效或者恢复，或者有人撤销了 Lead 的失效。级别由写入方定：digest，在「Lead 动态」里告诉用户；
    // 依据是硬性规则 memory_fact_change_reported。Lead 写的来源是 lead；用户撤销时来源是 system。
    kind: MEMORY_FACT_CHANGED_KIND,
    sources: ["lead", "system"],
    payload: MemoryFactChangedPayloadSchema,
    description: "Hindsight 里的一条事实失效了或者恢复了：Lead 做的（带依据），或者有人撤销了 Lead 的失效。",
  },
];

for (const definition of MEMORY_FACT_EVENT_KINDS) registerEventKind(definition);
