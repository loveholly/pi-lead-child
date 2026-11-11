// 在沙箱外跑过的命令（docs/ticket-246-user-turn-bypass.md 5.5，实施单 C）。每一条都写两条事件：spawn 之前写
// host_command.started，进程结束以后写 host_command.finished。分开写：daemon 中途崩溃时至少留着「开始跑了」。
// 三条路都写：免沙箱开关开着时 Lead 的 bash（via bash）、免沙箱时 run_on_host 直接跑（via run_on_host）、用户在确认卡上
// 点了「确认这一次」以后跑的 run_on_host（turnOrigin confirmed_card，带 confirmationId）。这样「所有在沙箱外跑过的命令」
// 一条查询就能列出来；rule_change.executed 照旧写。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const HOST_COMMAND_STARTED_KIND = "host_command.started";
export const HOST_COMMAND_FINISHED_KIND = "host_command.finished";

/** 事件的对象键：host_command:<编号>。 */
export function hostCommandEntityKey(id: string): string {
  return `host_command:${id}`;
}

// 这条命令凭哪一种一轮在沙箱外跑：用户本人在 Companion、plc、Slack 里给自己发的私信（凭证 origin channel_owner）开的一轮，
// 用户在确认卡上点了「确认这一次」，或者系统事件叫醒的一轮（system_event：执行结束、后台检查有结果、跟进到点这类，
// 用户 2026-11-11：「当然要免 bypass 啊」；叫醒它的事件写在 wokenBy 里）。
// unattributed：不是用户的一轮，也不是系统事件叫醒的一轮（用户 2026-11-11 13:42 以后，开关开着时第一档的命令在哪一轮都直接跑）。
export const HOST_COMMAND_TURN_ORIGINS = [
  "live_user_companion", "live_user_plc", "live_user_slack_self_dm", "confirmed_card", "system_event", "unattributed",
] as const;
export type HostCommandTurnOrigin = typeof HOST_COMMAND_TURN_ORIGINS[number];
export const HostCommandTurnOriginSchema = Type.Union([
  Type.Literal("live_user_companion"), Type.Literal("live_user_plc"), Type.Literal("live_user_slack_self_dm"), Type.Literal("confirmed_card"),
  Type.Literal("system_event"), Type.Literal("unattributed"),
]);

// 系统事件叫醒的一轮的来源：daemon 发起这一轮的系统来源（system:blocker 这类）和交给这一轮的事件 kind（run.finished 这类）。
export const HostCommandWokenBySchema = Type.Object({
  origin: Nullable(Type.String()),
  kinds: Type.Array(Type.String()),
});
export type HostCommandWokenBy = Static<typeof HostCommandWokenBySchema>;

export const HostCommandViaSchema = Type.Union([Type.Literal("bash"), Type.Literal("run_on_host")]);
export type HostCommandVia = Static<typeof HostCommandViaSchema>;

// 筛查器的结果（engine 的 host-commands/screen.ts）。在沙箱外跑的命令都是 allow；rule 留给以后放行带规则的结果。
// 确认卡上的命令不过筛查器（用户看过命令本身），为 null。
export const HostCommandScreenSchema = Type.Object({
  verdict: Type.String({ minLength: 1 }),
  rule: Nullable(Type.String()),
});

export const HostCommandStartedPayloadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  // 凭哪一轮跑的（channel turn 的编号）。确认卡上跑的为 null。
  turnId: Nullable(Type.String()),
  turnOrigin: HostCommandTurnOriginSchema,
  // turnOrigin 是 system_event 时才有。
  wokenBy: Type.Optional(HostCommandWokenBySchema),
  // 这一轮带着的外部内容（外部消息的来源、读到外部内容的工具）。没有时不写。
  externalContent: Type.Optional(Type.Array(Type.String())),
  via: HostCommandViaSchema,
  confirmationId: Nullable(Type.String()),
  // 脱敏后的命令，最多 400 字。
  command: Type.String({ maxLength: 400 }),
  cwd: Type.String(),
  timeoutSeconds: Nullable(Type.Number()),
  screen: Nullable(HostCommandScreenSchema),
  spendsMoney: Type.Boolean(),
});
export type HostCommandStartedPayload = Static<typeof HostCommandStartedPayloadSchema>;

export const HostCommandFinishedPayloadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  exitCode: Nullable(Type.Integer()),
  timedOut: Type.Boolean(),
  durationMs: Type.Integer({ minimum: 0 }),
  outputPath: Type.String(),
  outputBytes: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
});
export type HostCommandFinishedPayload = Static<typeof HostCommandFinishedPayloadSchema>;

export const HOST_COMMAND_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: HOST_COMMAND_STARTED_KIND,
    sources: ["system"],
    payload: HostCommandStartedPayloadSchema,
    description: "一条命令开始在沙箱外跑（免沙箱开关开着时筛查器第一档的命令，或者用户在确认卡上确认的 run_on_host）。",
  },
  {
    kind: HOST_COMMAND_FINISHED_KIND,
    sources: ["system"],
    payload: HostCommandFinishedPayloadSchema,
    description: "一条在沙箱外跑的命令结束了：退出码、有没有超时、用了多久、输出存在哪里。",
  },
];

for (const definition of HOST_COMMAND_EVENT_KINDS) registerEventKind(definition);
