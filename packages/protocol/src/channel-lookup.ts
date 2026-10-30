// 代查（Slack 代查与按信心代回 spec D5，.scratch/slack-takeover/spec.md）的共享契约：
// 通道 hub（engine）、代查的运行（lead / daemon）和卡的线上形状（channels.ts）都用这里的类型。
// 这里不出现任何具体来源的名字。
//
// 一次代查是：hub 定下作用域（LookupScope），daemon 的启动器开一张工单、起一个 purpose 为 lookup 的 Run，
// 代查 agent 只能用作用域里的只读工具，最后交一份结构化结果（LookupResult）。代码再核实每一条出处
// （LookupSource.verified），连同这次读过什么（LookupReadRecord，审计用）交回 hub（LookupOutcome）。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));

/** 剧本：lookup 回答能查到的问题；review 只留 comment 的 PR review。 */
export const LOOKUP_PLAYBOOKS = ["lookup", "review"] as const;
export type LookupPlaybook = typeof LOOKUP_PLAYBOOKS[number];

/** 一次代查的状态。queued 和 running 是没结束的。 */
export const LOOKUP_STATES = ["queued", "running", "finished", "failed", "cancelled", "denied"] as const;
export type LookupState = typeof LOOKUP_STATES[number];
export const LOOKUP_ACTIVE_STATES: readonly LookupState[] = ["queued", "running"];

export const LOOKUP_FOUND = ["yes", "partial", "no"] as const;
export type LookupFound = typeof LOOKUP_FOUND[number];

// 结果和出处的上限：代查 agent 交的东西超过这些就被拒收（submit 工具的 schema）。
export const LOOKUP_LIMITS = {
  answerChars: 4_000,
  draftChars: 2_000,
  quoteChars: 1_000,
  sources: 12,
  checked: 20,
  caveats: 10,
  reviewComments: 30,
  reviewCommentChars: 2_000,
} as const;

export const LookupRepoSchema = StrictObject({
  // owner/name；本地仓库没有 GitHub 远端时是目录名。
  repo: Type.String({ minLength: 1, maxLength: 200 }),
  // 本地仓库的根目录（绝对路径）。
  root: Type.String({ minLength: 1, maxLength: 1_000 }),
});

export const LookupGithubRepoSchema = StrictObject({
  owner: Type.String({ minLength: 1, maxLength: 100 }),
  repo: Type.String({ minLength: 1, maxLength: 100 }),
});

/** 代查的作用域。工具只能读这里列出的仓库；代码在每次工具调用时检查。 */
export const LookupScopeSchema = StrictObject({
  local: Type.Array(LookupRepoSchema, { maxItems: 4 }),
  github: Type.Array(LookupGithubRepoSchema, { maxItems: 4 }),
  pullRequest: Type.Optional(StrictObject({
    owner: Type.String({ minLength: 1, maxLength: 100 }),
    repo: Type.String({ minLength: 1, maxLength: 100 }),
    number: Type.Integer({ minimum: 1 }),
  })),
});
export type LookupScope = Static<typeof LookupScopeSchema>;

/** 一条出处。quote 是原文摘录，出处核实时要在这次读到的内容里找得到。 */
export const LookupSourceSchema = StrictObject({
  via: Literals(["local", "github"] as const),
  repo: Type.String({ minLength: 1, maxLength: 200 }),
  path: Type.String({ minLength: 1, maxLength: 1_000 }),
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  quote: Type.String({ minLength: 1, maxLength: LOOKUP_LIMITS.quoteChars }),
  // 本地是读的时候的 HEAD sha，GitHub 是 ref 或 sha。
  ref: Type.Optional(Type.String({ maxLength: 200 })),
  // 出处核实以后由代码填；代查 agent 交的时候没有这个字段。
  verified: Type.Optional(Type.Boolean()),
});
export type LookupSource = Static<typeof LookupSourceSchema>;

export const LookupReviewCommentSchema = StrictObject({
  path: Type.String({ minLength: 1, maxLength: 1_000 }),
  line: Type.Integer({ minimum: 1 }),
  side: Literals(["RIGHT", "LEFT"] as const),
  body: Type.String({ minLength: 1, maxLength: LOOKUP_LIMITS.reviewCommentChars }),
});
export type LookupReviewComment = Static<typeof LookupReviewCommentSchema>;

/**
 * 一条引用连接查询结果的出处（例如 CDP、Jira）：quote 要在这次运行里这个连接的这个工具返回的原文里找得到。
 * 文件的出处用 LookupSourceSchema（via local 或 github，带路径和行号）。
 */
export const ConnectionSourceSchema = StrictObject({
  via: Type.Literal("connection"),
  connection: Type.String({ minLength: 1, maxLength: 40 }),
  tool: Type.String({ minLength: 1, maxLength: 100 }),
  quote: Type.String({ minLength: 1, maxLength: LOOKUP_LIMITS.quoteChars }),
  // 核实以后由代码填；子 agent 交的时候没有这个字段。
  verified: Type.Optional(Type.Boolean()),
});
export type ConnectionSource = Static<typeof ConnectionSourceSchema>;

/** 子 agent 经连接中心做了的一个写操作（例如在 PR 上提交的 review），卡上显示。出处是连接中心的审计。 */
export const LookupActionSchema = StrictObject({
  summary: Type.String({ maxLength: 300 }),
  url: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  // 别人看不看得到（例如没提交的 pending review 看不到）。
  visible: Type.Boolean(),
});
export type LookupAction = Static<typeof LookupActionSchema>;

/**
 * 代查 agent 交的结构化结果。2026-10-22 起通道派的子 agent 工单（落地计划 D1）也存成这个形状：
 * connectionSources 是引用连接查询结果的出处，actions 是子 agent 做了的写操作。旧的代查没有这两项。
 */
export const LookupResultSchema = StrictObject({
  found: Literals(LOOKUP_FOUND),
  // 给用户看的答案。
  answer: Type.String({ maxLength: LOOKUP_LIMITS.answerChars }),
  sources: Type.Array(LookupSourceSchema, { maxItems: LOOKUP_LIMITS.sources }),
  // 查过哪些地方（没查到时也有用）。
  checked: Type.Array(Type.String({ maxLength: 300 }), { maxItems: LOOKUP_LIMITS.checked }),
  caveats: Type.Array(Type.String({ maxLength: 500 }), { maxItems: LOOKUP_LIMITS.caveats }),
  // 给对方的回复草稿，不含披露署名（署名由 hub 加）。
  replyDraft: Type.String({ maxLength: LOOKUP_LIMITS.draftChars }),
  review: Type.Optional(StrictObject({
    summary: Type.String({ maxLength: LOOKUP_LIMITS.answerChars }),
    comments: Type.Array(LookupReviewCommentSchema, { maxItems: LOOKUP_LIMITS.reviewComments }),
  })),
  connectionSources: Type.Optional(Type.Array(ConnectionSourceSchema, { maxItems: LOOKUP_LIMITS.sources })),
  actions: Type.Optional(Type.Array(LookupActionSchema, { maxItems: 20 })),
});
export type LookupResult = Static<typeof LookupResultSchema>;

/** 这次代查读过的一样东西（审计用，卡上显示）。不含内容本身。 */
export const LookupReadRecordSchema = StrictObject({
  tool: Type.String({ minLength: 1, maxLength: 100 }),
  repo: Type.String({ minLength: 1, maxLength: 200 }),
  path: Type.Optional(Type.String({ maxLength: 1_000 })),
  lines: Type.Optional(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })])),
  ref: Type.Optional(Type.String({ maxLength: 200 })),
  bytes: Type.Integer({ minimum: 0 }),
  // 工具拒绝了这次调用（作用域外、禁止名单、超限）时的原因。
  refused: Type.Optional(Type.String({ maxLength: 300 })),
  at: Type.String(),
});
export type LookupReadRecord = Static<typeof LookupReadRecordSchema>;


/** 一次代查结束时交回 hub 的东西。result.sources[].verified 已经由代码填好。 */
export interface LookupOutcome {
  status: "finished" | "failed" | "cancelled";
  result: LookupResult | null;
  reads: LookupReadRecord[];
  error: string | null;
}

