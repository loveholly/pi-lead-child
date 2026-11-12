// 信号源（用户 2026-11-11、2026-11-12）：通过对话把一个连接接进事件体系，不为邮件、日历这类来源写专用的代码。
// 一个信号源是一份数据：名字、定时调哪几个连接的只读工具、一段把结果整理成条目的脚本、多久跑一次、用户的规则和策略。
//   - 到点时系统调连接的只读工具（不经过模型），把结果交给脚本；脚本输出若干条 {key, title, text}。
//   - 每条新内容写一个事件 signal.received（来源 signal，按 信号源:key 去重）。事件是外部内容：别人写的话。
//   - 每条新内容重不重要，由便宜的模型按用户的那几句话判断（通用的一步，不只针对某种来源）：最像哪一句，就用那一句的级别。
//   - 能不能代用户处理（往外部账号里写），按用户建信号源时的话：缺省是先问用户。
// 存在 kv 里（store 的 signal-sources.ts），不开新表。
import { Type, type Static, type TProperties } from "typebox";
import { registerEventKind, registerExternalEventSource } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });

/** 信号源的事件的来源。外部来源：事件的话是别人写的，叫醒的一轮算外部的一轮。 */
export const SIGNAL_EVENT_SOURCE = "signal";
export const SIGNAL_RECEIVED_KIND = "signal.received";

export const SIGNAL_SOURCE_NAME_PATTERN = "^[a-z][a-z0-9-]{1,39}$";

export const SIGNAL_SOURCE_LIMITS = {
  // 两次之间最短、缺省、最长（秒）。
  minEverySeconds: 60,
  defaultEverySeconds: 300,
  maxEverySeconds: 86_400,
  // 一次最多调几个连接工具；脚本最多跑多久（秒）、输出最多多少字节。
  maxFetches: 5,
  timeoutSeconds: 60,
  outputBytes: 512 * 1024,
  // 一次最多收几条；编号、标题、正文最多多少字。
  maxItems: 50,
  key: 200,
  title: 300,
  text: 4_000,
  command: 4_000,
  // 用户的规则最多几句；一句、策略最多多少字。
  maxRules: 12,
  rule: 300,
  policy: 1_000,
  // 连续出错几次就暂停，并叫醒 Lead 一次。
  maxConsecutiveErrors: 5,
} as const;

/** 一句规则的级别：马上告诉我、进汇总、不用管。 */
export const SIGNAL_RULE_LEVELS = ["now", "digest", "ignore"] as const;
export type SignalRuleLevel = typeof SIGNAL_RULE_LEVELS[number];

/** 规则的级别对应事件的级别。哪一句都不像、模型不可用时进汇总。 */
export const SIGNAL_EVENT_LEVELS: Readonly<Record<SignalRuleLevel, "tell" | "digest" | "record">> = {
  now: "tell", digest: "digest", ignore: "record",
};

export const SignalFetchSchema = StrictObject({
  // 连接的 key 和它的一个只读工具。
  connection: Type.String({ minLength: 1, maxLength: 64 }),
  tool: Type.String({ minLength: 1, maxLength: 200 }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type SignalFetch = Static<typeof SignalFetchSchema>;

export const SignalRuleSchema = StrictObject({
  // 用户的一句话，例如「老板和客户的邮件」。
  text: Type.String({ minLength: 1, maxLength: SIGNAL_SOURCE_LIMITS.rule }),
  level: Type.Union([Type.Literal("now"), Type.Literal("digest"), Type.Literal("ignore")]),
});
export type SignalRule = Static<typeof SignalRuleSchema>;

/** 建一个信号源、试跑一次的输入。 */
export const SignalSourceInputSchema = StrictObject({
  name: Type.String({ pattern: SIGNAL_SOURCE_NAME_PATTERN }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  fetch: Type.Array(SignalFetchSchema, { minItems: 1, maxItems: SIGNAL_SOURCE_LIMITS.maxFetches }),
  // 整理结果的命令（在 Lead 的沙箱里跑）。输入在环境变量 SIGNAL_INPUT 指的文件里，输出是一个 JSON 对象 {items: [...]}。
  command: Type.String({ minLength: 1, maxLength: SIGNAL_SOURCE_LIMITS.command }),
  everySeconds: Type.Optional(Type.Integer({
    minimum: SIGNAL_SOURCE_LIMITS.minEverySeconds, maximum: SIGNAL_SOURCE_LIMITS.maxEverySeconds,
  })),
  rules: Type.Optional(Type.Array(SignalRuleSchema, { maxItems: SIGNAL_SOURCE_LIMITS.maxRules })),
  // 用户说的能不能代他处理（原话）。actForUser 只在用户明确说了可以时为 true；缺省是先问用户。
  policy: Type.Optional(Type.String({ maxLength: SIGNAL_SOURCE_LIMITS.policy })),
  actForUser: Type.Optional(Type.Boolean()),
  // An external agenda feed (agenda-feeds.ts) that takes the command's `agenda` output on every run.
  agendaFeed: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{1,39}$" })),
});
export type SignalSourceInput = Static<typeof SignalSourceInputSchema>;

/** 改一个信号源：至少给一项。改了 fetch 或者 command 时，下一次运行重新记基线（编号的算法可能变了）。 */
export const SignalSourceUpdateSchema = Type.Object({
  label: Type.Optional(SignalSourceInputSchema.properties.label),
  fetch: Type.Optional(SignalSourceInputSchema.properties.fetch),
  command: Type.Optional(SignalSourceInputSchema.properties.command),
  everySeconds: SignalSourceInputSchema.properties.everySeconds,
  rules: SignalSourceInputSchema.properties.rules,
  policy: SignalSourceInputSchema.properties.policy,
  actForUser: SignalSourceInputSchema.properties.actForUser,
  // null stops handing the output to a feed.
  agendaFeed: Type.Optional(Type.Union([Type.String({ pattern: "^[a-z][a-z0-9-]{1,39}$" }), Type.Null()])),
}, { additionalProperties: false, minProperties: 1 });
export type SignalSourceUpdate = Static<typeof SignalSourceUpdateSchema>;

/** 脚本输出的一条。 */
export interface SignalItem {
  key: string;
  title: string;
  text: string;
  // 发生的时刻（ISO），脚本给了就用它。
  at?: string;
  // 别的结构化字段（例如发件人），原样放进事件，常设指令可以按它匹配。
  fields?: Record<string, string | number | boolean>;
}

/** 信号源现在的样子（页面和 Lead 看到的）。 */
export interface SignalSourceDto {
  name: string;
  label: string;
  fetch: SignalFetch[];
  command: string;
  everySeconds: number;
  rules: SignalRule[];
  policy: string;
  actForUser: boolean;
  enabled: boolean;
  createdBy: "user" | "lead";
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  // 第一次成功运行的时刻：那一次只记基线。还没有成功过时为 null。
  baselinedAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  consecutiveErrors: number;
  // 到现在一共写了几个事件。
  emitted: number;
  // The external agenda feed this source hands its `agenda` output to, or null.
  agendaFeed: string | null;
}

/** 缺省的策略，Lead 建完信号源照着告诉用户（用户建的时候没有说能不能代他处理时）。 */
export const SIGNAL_DEFAULT_POLICY = "缺省：新内容来了，我只读、通知你、建提醒和工单、写草稿。要往外部账号里写的事（例如回邮件、接受会议邀请），我先问你。想改的话告诉我。";

const Field = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

registerExternalEventSource(SIGNAL_EVENT_SOURCE);
registerEventKind({
  kind: SIGNAL_RECEIVED_KIND,
  sources: [SIGNAL_EVENT_SOURCE],
  payload: Type.Object({
    // 哪个信号源、它给人看的名字、这一条的编号。
    signal: Type.String({ minLength: 1 }),
    label: Type.String(),
    key: Type.String({ minLength: 1 }),
    title: Type.String(),
    text: Type.String(),
    fields: Type.Optional(Type.Record(Type.String(), Field)),
    // 最像用户的哪一句规则；哪句都不像、没有规则、模型不可用时为 null。
    rule: Type.Union([Type.Null(), Type.Object({ text: Type.String(), level: Type.String() })]),
    // 级别是怎样定的：model 便宜的模型选的；default 没有规则或者哪句都不像；unavailable 模型不可用。
    graded: Type.Union([Type.Literal("model"), Type.Literal("default"), Type.Literal("unavailable")]),
    // 这个信号源的策略：能不能代用户往外部账号里写。
    actForUser: Type.Boolean(),
    policy: Type.String(),
    summary: Type.String(),
  }),
  description: "信号源交来的一条新内容（例如一封新邮件、一个日历变更）。正文是别人写的话。",
});
