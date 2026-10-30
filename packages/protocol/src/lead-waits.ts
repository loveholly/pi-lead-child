// Lead 在等用户的下一步（2026-10-19）。
//
// 背景（2026-10-19 审查）：Lead 要等用户做完一件事才能接着做，用户做完了，Lead 却不知道。
//   · 工单 #98：Lead 等用户重新授权 GitHub。17:05 用户授权完成，没有任何事件叫醒 Lead，直到用户问「你没收到事件吗」。
//   · 工单 #85（10-18）：Lead 等用户点确认卡，用户改为点「验收」和「委托给 Lead」。主人操作对 Lead 一律跳过，Lead 没醒。
// 用户的意见：「你刚刚验收了工单」这类事件本身不重要，记日志即可；但 Lead 正在等用户的某个操作时，那个操作必须叫醒它。
//
// 做法是一种通用的等待，不为委托、授权分别写特例：
//   · 一条等待挂在一个对象上（对象键，和事件日志的 entity_key 同一套写法：ticket:98、connection:github、decision:12），
//     带一句备注（等什么、等到以后做什么）和超时。Lead 自己声明（wait_for_user_action），
//     或者 Lead 的工具返回「需要用户做什么」（user-actions.ts）时系统自动登记。
//   · 事件日志每写一条事件，store 看它是不是这个对象上的用户操作或状态变化（EventKindDefinition.waitSignal）。
//     是的话，这条等待了结，系统写一条 lead.wait_satisfied（tell 级），带着备注和发生了什么，交给 Lead。
//   · 到了超时还没等到：写一条 lead.wait_expired（tell 级）交给 Lead，等待随之清理。
//   · 没有人在等的主人操作照旧只记日志（daemon 的 lead-input.ts 对它们是 skip）。
// 表在 store 的 schema.ts（lead_waits，v49），读写在 store 的 lead-waits.ts。这个文件只定义事件和纯函数。
import { Type, type TSchema } from "typebox";
import { eventKindDefinition, registerEventKind, type EventKindDefinition } from "./events.ts";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Id = Type.Integer({ minimum: 1 });

export const LEAD_WAIT_SATISFIED_KIND = "lead.wait_satisfied";
export const LEAD_WAIT_EXPIRED_KIND = "lead.wait_expired";
export const CONNECTION_STATUS_CHANGED_KIND = "connection.status_changed";
export const DAEMON_STARTED_KIND = "daemon.started";
export const USER_REQUEST_EXPIRED_KIND = "user_request.expired";

/** daemon 这个对象的键：daemon.started 写在它上面，等重启完成的等待挂在它上面。 */
export const DAEMON_ENTITY_KEY = "daemon:main";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const LEAD_WAIT_LIMITS = {
  noteMaxChars: 500,
  minMs: 5 * MINUTE,
  maxMs: 14 * 24 * HOUR,
  // 没给超时时等多久。授权、验收这类事用户可能隔天才做。
  defaultMs: 24 * HOUR,
  // 了结、超时、取消以后的行留多久（给 Lead 和排查看），之后清理掉。
  keepResolvedMs: 7 * 24 * HOUR,
  // 当前局面里最多列几条。
  situationMax: 10,
} as const;

export const LEAD_WAIT_STATES = ["waiting", "satisfied", "expired", "cancelled"] as const;
export type LeadWaitState = typeof LEAD_WAIT_STATES[number];

// 对象的类型（对象键冒号前面的部分）。Lead 声明等待时只能挂在这些对象上：它们都有用户能做的操作。
export const LEAD_WAIT_ENTITY_PREFIXES = [
  "ticket", "reminder", "connection", "connection_confirmation", "decision", "approval", "run", "workspace", "daemon",
  "rule_change",
] as const;

const TriggerPayload = Type.Object({
  seq: Id,
  kind: Type.String({ minLength: 1 }),
  entityKey: Type.String({ minLength: 1 }),
  summary: Type.String(),
});

const WaitPayload = {
  waitId: Id,
  // 等待挂的对象（声明时的写法）。
  waitedKey: Type.String({ minLength: 1 }),
  note: Type.String({ minLength: 1 }),
  // lead：Lead 自己声明的；tool:<工具名>：工具返回「需要用户做什么」时系统登记的；system:<原因>：系统登记的。
  origin: Type.String({ minLength: 1 }),
  // true：这件事要告诉用户，Lead 不能只回 NO_REPLY（例如 Lead 请求的重启完成了）。
  mustTell: Type.Boolean(),
  waitingSince: Type.String({ minLength: 1 }),
  // 等的那件事的结构化数据（user-actions.ts 的 UserActionRequest）。没有时是 null。
  userAction: Nullable(Type.Unknown()),
};

export const LEAD_WAIT_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: LEAD_WAIT_SATISFIED_KIND,
    sources: ["system"],
    // coveredBySeq：已经有一条要交给 Lead 的事件在说这件事（系统自己的通路），这一条只记一笔（record 级）。
    payload: Type.Object({ ...WaitPayload, trigger: TriggerPayload, coveredBySeq: Nullable(Id) }),
    description: "Lead 在等的对象上发生了用户的操作或状态变化：等待了结，带着 Lead 的备注和发生了什么。",
  },
  {
    kind: LEAD_WAIT_EXPIRED_KIND,
    sources: ["timer"],
    payload: Type.Object({ ...WaitPayload, expiresAt: Type.String({ minLength: 1 }) }),
    description: "Lead 的一条等待到了超时还没等到：交给 Lead 决定再等、提醒用户还是放下。",
  },
  {
    // 连接的状态变了（store 的 updateConnection：connected、degraded、needs_reauth、disconnected 之间）。
    // 以前只写 connection_events，事件日志里没有，Lead 等用户授权时等不到（工单 #98）。
    // 级别是 record：只记日志；有人在等这个连接时，等待了结的那一条叫醒 Lead。
    kind: CONNECTION_STATUS_CHANGED_KIND,
    sources: ["system"],
    waitSignal: "state_change",
    payload: Type.Object({
      connectionId: Id,
      key: Type.String({ minLength: 1 }),
      label: Type.String(),
      from: Nullable(Type.String()),
      to: Type.String({ minLength: 1 }),
      tokenSource: Type.String(),
      summary: Type.String(),
    }),
    description: "第三方账号连接的状态变了：连上、要重新授权、断开、暂时连不上。",
  },
  {
    // daemon 启动了（重启、升级、换模型以后）。record 级；Lead 请求的维护登记了等它的等待，
    // 等待了结的那一条叫醒 Lead，并且要告诉用户（mustTell）。
    kind: DAEMON_STARTED_KIND,
    sources: ["system"],
    waitSignal: "state_change",
    payload: Type.Object({
      pid: Type.Integer({ minimum: 1 }),
      startedAt: Type.String({ minLength: 1 }),
      summary: Type.String(),
    }),
    description: "daemon 启动了。",
  },
  {
    // 一个等用户回答的请求过期了（决定请求、连接的写入确认）。用户没有做，这也是这个对象的状态变化。
    kind: USER_REQUEST_EXPIRED_KIND,
    sources: ["system"],
    waitSignal: "state_change",
    payload: Type.Object({
      requestKind: Type.Union([Type.Literal("decision"), Type.Literal("connection_confirmation")]),
      requestId: Type.String({ minLength: 1 }),
      summary: Type.String(),
    }),
    description: "一个等用户回答的请求过期了，用户没有回答。",
  },
];

for (const definition of LEAD_WAIT_EVENT_KINDS) registerEventKind(definition);

export interface LeadWaitEventLike {
  kind: string;
  source: string;
  entityKey: string;
  payload: Record<string, unknown>;
}

const positiveId = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

/**
 * 这条事件能不能了结等待（决策边界，纯函数）：它的类型声明了 waitSignal，并且不是 Lead 自己做的
 * （Lead 自己改的状态不是用户的下一步）。
 */
export function eventEndsLeadWait(event: LeadWaitEventLike): boolean {
  if (!eventKindDefinition(event.kind)?.waitSignal) return false;
  if (event.source === "lead") return false;
  if (event.kind === "stage.changed" && event.payload.actor === "lead") return false;
  return true;
}

/**
 * 这条事件碰到了哪些对象（等待按这些键匹配）：它自己的对象键，加上它挂的工单（payload.itemId、主人操作的 target.ticketId）。
 * 例如对工单 #98 的一条审批做了处理，等工单 #98 的等待也了结。
 */
export function leadWaitKeysOf(event: Pick<LeadWaitEventLike, "entityKey" | "payload">): string[] {
  const keys = new Set([event.entityKey]);
  const itemId = positiveId(event.payload.itemId);
  if (itemId !== null) keys.add(`ticket:${itemId}`);
  const target = event.payload.target;
  if (target && typeof target === "object") {
    const ticketId = positiveId((target as { ticketId?: unknown }).ticketId);
    if (ticketId !== null) keys.add(`ticket:${ticketId}`);
  }
  return [...keys];
}

/** Lead 声明的对象键合不合格：返回问题，空字符串表示可以用。 */
export function leadWaitKeyProblem(key: string): string {
  const at = key.indexOf(":");
  const prefix = at > 0 ? key.slice(0, at) : "";
  const id = at > 0 ? key.slice(at + 1) : "";
  if (!(LEAD_WAIT_ENTITY_PREFIXES as readonly string[]).includes(prefix) || !/^[A-Za-z0-9_.-]{1,60}$/u.test(id)) {
    return `对象要写成「类型:编号」，类型是 ${LEAD_WAIT_ENTITY_PREFIXES.join("、")} 之一，例如 ticket:98、connection:github、decision:12`;
  }
  return "";
}
