// 设置 → 记忆 → 常驻偏好（用户 2026-10-29，.scratch/hindsight-primary-memory/spec.md D15）。
//
// 常驻偏好是写进 Lead 系统提示词的那一段「关于用户」（profile、preference 笔记）。页面上只叫「常驻偏好」，不出现「笔记」「kind」。
//   - 页面读 GET /v1/memory/preferences（tickets:view），回 MemoryPreferencesResponse。/v1/memory 的 DTO 是严格的契约，不往那里加。
//   - 改、删、撤销是操作层的操作（ui-actions.ts），页面和 Lead 调同一个函数（engine 的 memory/core-memory.ts）：
//       core_memory / <编号> / update（input: {title?, content?}，至少一项）、delete（input: {}）；
//       core_memory_change / <改动编号> / undo（input: {}）。
//     三个都算改规则，而且进提示词（promptSetting）：读过外部内容的一轮里 Lead 做不了，用户本人的一轮也一样。
//     被拒时只拒绝（refusal.code=external_turn），不带确认卡（用户 2026-10-29）。
//   - 每次改动记一行改动（store 的 core_memory_changes）。变化时网关发 snapshot.required，payload 是 {resource: "memory"}，
//     客户端重新 GET 这里。
//   - Lead 改了常驻偏好（或者撤销了一次改动）时写一条 core_memory.changed（digest 级），「Lead 动态」里出现一张卡，
//     卡上带「撤销」按钮（lead-activity.ts 的 LeadActivityCard.action）。用户撤销 Lead 的改动时同一个对象再写一条，
//     卡原地更新，按钮消失。用户自己在设置页改的不写这条事件。
//
// 这个文件只依赖 typebox 和同包的 events.ts，companion 也读它。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Id = Type.Integer({ minimum: 1 });

// 进系统提示词的两类。profile 是用户画像，preference 是工作和沟通偏好。页面上都叫常驻偏好。
export const CORE_MEMORY_KINDS = ["profile", "preference"] as const;
export type CoreMemoryKind = typeof CORE_MEMORY_KINDS[number];
export const CoreMemoryKindSchema = Type.Union([Type.Literal("profile"), Type.Literal("preference")]);

// 一条的标题和正文最长多少（输入的上限）。所有常驻偏好加起来还有一个总上限（MemoryPreferencesDto 的 cap）。
export const CORE_MEMORY_TITLE_MAX = 200;
export const CORE_MEMORY_CONTENT_MAX = 4_000;

export const CORE_MEMORY_CHANGE_ACTIONS = ["create", "update", "delete"] as const;
export const CoreMemoryChangeActionSchema = Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]);
export const CoreMemoryActorSchema = Type.Union([Type.Literal("user"), Type.Literal("lead")]);

// 一条常驻偏好最近一次改动。
export const CoreMemoryChangeDtoSchema = StrictObject({
  // 改动编号：撤销用它（操作层的 core_memory_change / <编号> / undo）。
  changeId: Id,
  // create 新加（或者从别的类别放进常驻），update 修改，delete 删除（或者从常驻里拿掉）。
  action: CoreMemoryChangeActionSchema,
  // 谁改的：user 你本人（设置页），lead 是 Lead。
  actor: CoreMemoryActorSchema,
  // 依据（Lead 写的理由，或者设置页的默认说法）。
  reason: Type.String(),
  // 改的时间（ISO）。
  at: Type.String(),
  // 这次改动本身是一次撤销时，被撤销的改动编号。
  undoOf: Nullable(Id),
  // 能不能撤销，和操作层的 available 是同一个判断。不能时 undoBlocked 写原因（用户能看懂的一句话）。
  canUndo: Type.Boolean(),
  undoBlocked: Nullable(Type.String()),
});
export type CoreMemoryChangeDto = Static<typeof CoreMemoryChangeDtoSchema>;

export const CoreMemoryEntryDtoSchema = StrictObject({
  // 编号：改、删用它（操作层的 core_memory / <编号>）。
  id: Id,
  kind: CoreMemoryKindSchema,
  title: Type.String(),
  content: Type.String(),
  // 最后一次修改的时间（ISO）。
  updatedAt: Type.String(),
  // 最近一次改动。以前写的、没有改动记录的是 null。
  lastChange: Nullable(CoreMemoryChangeDtoSchema),
});
export type CoreMemoryEntryDto = Static<typeof CoreMemoryEntryDtoSchema>;

export const MemoryPreferencesDtoSchema = StrictObject({
  // 先画像（profile），再偏好（preference），各自按编号。和系统提示词里的顺序一样。
  entries: Type.Array(CoreMemoryEntryDtoSchema),
  // 所有常驻偏好的标题加正文一共多少字、最多多少字。改完超过上限时操作被拒。
  used: Type.Integer({ minimum: 0 }),
  cap: Type.Integer({ minimum: 0 }),
});
export type MemoryPreferencesDto = Static<typeof MemoryPreferencesDtoSchema>;

export const MemoryPreferencesResponseSchema = StrictObject({ preferences: MemoryPreferencesDtoSchema });
export type MemoryPreferencesResponse = Static<typeof MemoryPreferencesResponseSchema>;

// 操作的输入（ui-actions.ts 的 core_memory.update）。只改给出的字段，至少给一项。前后的空白去掉，去掉以后不能是空的。
export const CoreMemoryUpdateRequestSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: CORE_MEMORY_TITLE_MAX })),
  content: Type.Optional(Type.String({ minLength: 1, maxLength: CORE_MEMORY_CONTENT_MAX })),
}, { additionalProperties: false, minProperties: 1 });
export type CoreMemoryUpdateRequest = Static<typeof CoreMemoryUpdateRequestSchema>;

// ── 事件：Lead 动态 ────────────────────────────────────────────────────────────────

export const CORE_MEMORY_CHANGED_KIND = "core_memory.changed";

/** 一条常驻偏好的对象键：core_memory:<编号>。撤销删除时重建的那一条编号不同，事件仍然记在原来的编号上。 */
export function coreMemoryEntityKey(noteId: number): string {
  return `core_memory:${noteId}`;
}

export const CoreMemoryChangedPayloadSchema = Type.Object({
  // 这条常驻偏好的编号（对象键里的那个）。
  noteId: Id,
  // 这条事件报告的改动（撤销时是撤销记下的那一行）。
  changeId: Id,
  action: CoreMemoryChangeActionSchema,
  actor: CoreMemoryActorSchema,
  // 这条事件报告的是一次撤销时，被撤销的改动编号；不是撤销时是 null。
  undoOf: Nullable(Id),
  title: Type.String(),
  reason: Type.String(),
  // 对用户说的那句话，例如「Fairy 改了常驻偏好「沟通偏好」：原来「…」，现在「…」。依据：…」。
  summary: Type.String(),
});
export type CoreMemoryChangedPayload = Static<typeof CoreMemoryChangedPayloadSchema>;

export const CORE_MEMORY_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    // Lead 改了常驻偏好，或者有人撤销了 Lead 的改动（用户 2026-10-29）。级别由写入方定：digest，在「Lead 动态」里告诉用户；
    // 依据是硬性规则 core_memory_change_reported。Lead 写的来源是 lead；用户撤销时来源是 system（来源 user 只给用户发给 Lead 的消息）。
    // 用户自己在设置页改的不写这条。entity_key 是 core_memory:<编号>。
    kind: CORE_MEMORY_CHANGED_KIND,
    sources: ["lead", "system"],
    payload: CoreMemoryChangedPayloadSchema,
    description: "常驻偏好变了：Lead 新加、修改、删掉了一条（带依据），或者有人撤销了 Lead 的改动。",
  },
];

for (const definition of CORE_MEMORY_EVENT_KINDS) registerEventKind(definition);
