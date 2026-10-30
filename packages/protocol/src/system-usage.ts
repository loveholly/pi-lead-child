// 系统组件的调用记录（Lead 事件主干 spec D17，工单 13）。
//
// 用户问「Jev 被调用了几次」时，Lead 的数字只能来自事件日志，不能来自它的记忆。所以组件的每次调用写一条
// record 级的事件，写入时直接记处置 handled_by_rule（它不进「没有处置的事件」）：
//   - decision_model.called：SmartModel 的一次判断（决策模型 Jev，或者兜底的 LLM）。Lead 的会话在
//     engine 的 withCallObserver 回调里写（packages/lead 的 session.ts）。
//   - memory.recalled：daemon 向记忆服务（Hindsight）召回一次笔记（engine 的 notes-memory.ts）。
// Hindsight 在自己的进程里调用决策模型做重排序。这些调用不经过 daemon，这里记不到。
// 事件里只有用途、后端、模型、耗时、成败和失败原因。不写 state、问题、回答、查询原文和密钥。
// 所以这两种 payload 的 schema 不收多出来的字段（和 events.ts 里双写的类型不同）：写入点只有 store 的
// system-usage.ts 一处，多一个字段就是有人想把别的内容写进来。
import { Type, type TProperties, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

export const SYSTEM_COMPONENTS = ["decision_model", "memory"] as const;
export type SystemComponent = typeof SYSTEM_COMPONENTS[number];

export const COMPONENT_CALL_KINDS: Readonly<Record<SystemComponent, string>> = {
  decision_model: "decision_model.called",
  memory: "memory.recalled",
};

/** 组件调用事件的对象键，例如 component:decision_model。 */
export function componentEntityKey(component: SystemComponent): string {
  return `component:${component}`;
}

// 失败原因的上限。写入前先截断再脱敏（store 的 system-usage.ts 用 redactAndCap）。
export const COMPONENT_CALL_ERROR_MAX = 500;

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Strict = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const ErrorText = Type.String({ maxLength: COMPONENT_CALL_ERROR_MAX + 1 });

export const COMPONENT_CALL_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: COMPONENT_CALL_KINDS.decision_model,
    sources: ["system"],
    payload: Strict({
      component: Type.Literal("decision_model"),
      // 这次判断的用途，例如 route（suggest_route）。和决策日志同一个规则，不合法时是 unspecified。
      purpose: Type.String({ minLength: 1, maxLength: 40 }),
      // 回答的后端（jev、llm）。全部失败时是整条链的名字，例如 jev→llm。
      backend: Type.String({ minLength: 1, maxLength: 80 }),
      model: Nullable(Type.String({ maxLength: 200 })),
      latencyMs: Type.Integer({ minimum: 0 }),
      ok: Type.Boolean(),
      error: Nullable(ErrorText),
      // network、timeout、http、invalid_answer、aborted，或者 input（调用方给的输入不合法）。
      errorKind: Nullable(Type.String({ maxLength: 40 })),
      // 前一个后端失败、换了后端时：前一个后端和它的错误。
      fallbackFrom: Nullable(Strict({ backend: Type.String({ maxLength: 80 }), error: ErrorText })),
    }),
    description: "SmartModel 的一次判断（决策模型 Jev 或兜底的 LLM）：用途、后端、模型、耗时、成败。",
  },
  {
    kind: COMPONENT_CALL_KINDS.memory,
    sources: ["system"],
    payload: Strict({
      component: Type.Literal("memory"),
      // 记忆后端的名字，例如 hindsight。
      backend: Type.String({ minLength: 1, maxLength: 80 }),
      latencyMs: Type.Integer({ minimum: 0 }),
      ok: Type.Boolean(),
      error: Nullable(ErrorText),
      // 后端召回到几条。失败时是 0。
      hits: Type.Integer({ minimum: 0 }),
      // 这次召回改用了 SQLite 全文检索（主后端不可用，.scratch/hindsight-primary-memory/spec.md D6）。旧事件没有这两个字段。
      fallback: Type.Optional(Type.Boolean()),
      // 改用 SQLite 的原因：down、error、timeout、not_ready。没有改用时是 null。
      reason: Type.Optional(Nullable(Type.Union([
        Type.Literal("down"), Type.Literal("error"), Type.Literal("timeout"), Type.Literal("not_ready"),
      ]))),
    }),
    description: "daemon 向记忆服务召回一次笔记：后端、耗时、成败、召回条数；改用 SQLite 时写明原因。",
  },
];

for (const definition of COMPONENT_CALL_EVENT_KINDS) registerEventKind(definition);
