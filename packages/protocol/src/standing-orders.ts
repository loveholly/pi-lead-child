// 常设指令（Lead 事件主干 spec D3、D4，工单 05）：形状、校验和条件匹配。
//
// 常设指令是数据：规则层按它给事件定级别、合并、升级，写在代码里的几条规则（inbox 的合并和熔断、瞬时失败重试、
// 模型目录的说明、提醒到点）从它读参数。表在 packages/store 的 standing_orders（v44），每次修改写一个新版本，
// 旧版本保留。Lead 读用 list_standing_orders、get_standing_order；改用 propose_standing_order_change，
// 档位（更保守、更放开、硬性规则）的判断在 standing-order-tiers.ts（工单 10）。
//
// 一条常设指令有两种动作：
//   - level：只定级别。条件匹配的事件按它定级别（规则层按 priority 从小到大取第一条匹配的）。
//   - rule：白名单里的一条规则（STANDING_ORDER_RULES），params 是它的参数。可以同时带 level：
//     条件匹配的事件（通常是这条规则自己写出来的说明）按它定级别，依据就是这条规则。
// 硬性安全规则不进常设指令（spec D4），写在 store 的 event-triage.ts 里。
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { EventLevel } from "./events.ts";
import { CHANNEL_INTENT_PERMISSIONS, CHANNEL_INTENTS, DELEGATION_CATEGORIES, SENDER_TRUST_LEVELS } from "./channel-policy.ts";
import { LOOKUP_PLAYBOOKS } from "./channel-lookup.ts";
import { ChannelConfidenceParamsSchema } from "./channel-confidence.ts";
import { channelHandbookProblems, ChannelHandbookSchema } from "./channel-handbook.ts";

// 分诊能定的级别。conversation 只给用户自己的消息，常设指令不能定。
export const TRIAGE_LEVELS = ["record", "digest", "auto", "tell", "interrupt"] as const;
export type TriageLevel = typeof TRIAGE_LEVELS[number];

const LEVEL_RANK: Record<TriageLevel, number> = { record: 0, digest: 1, auto: 2, tell: 3, interrupt: 4 };

export function isTriageLevel(level: unknown): level is TriageLevel {
  return typeof level === "string" && (TRIAGE_LEVELS as readonly string[]).includes(level);
}

/** 级别的高低：record < digest < auto < tell < interrupt。conversation 不在这条线上，返回 -1。 */
export function triageLevelRank(level: EventLevel | null | undefined): number {
  return isTriageLevel(level) ? LEVEL_RANK[level] : -1;
}

/** 把级别压到 max 以下。 */
export function capTriageLevel(level: TriageLevel, max: TriageLevel): TriageLevel {
  return LEVEL_RANK[level] > LEVEL_RANK[max] ? max : level;
}

export const STANDING_ORDER_AUTHORS = ["system", "lead", "user"] as const;
export type StandingOrderAuthor = typeof STANDING_ORDER_AUTHORS[number];

export const STANDING_ORDER_STATUSES = ["active", "disabled"] as const;
export type StandingOrderStatus = typeof STANDING_ORDER_STATUSES[number];

// 规则的白名单（spec D4：动作只能从白名单里选）。每个名字对应一段写在代码里的规则，常设指令给它参数。
// 第 1 期没有「代你执行」的工具：不可逆或高风险的动作不在白名单里（硬性安全规则）。
export const STANDING_ORDER_RULES = [
  "inbox.merge_attention",
  "inbox.fuse_blockers",
  "inbox.wake_lead",
  "run.transient_retry",
  "model_catalog.announce",
  "reminder.fire",
  "events.merge_root_cause",
  "events.escalate_overdue",
  "events.digest_batch",
  "source.threshold",
  // Jev 分诊的启用开关（工单 09）：按事件类型启用。第 1 期只跑影子模式，开关缺省全部关闭。
  "triage.jev",
  // 通道（工单 11）：一个外部来源的消息怎样投递给用户（四种投递，含这个来源的打断阈值），和代你行动的闸门参数。
  // 每个来源一条，由来源插件写成系统种子；Lead 和用户只能改参数。
  "channel.delivery",
  "channel.delegate",
  // 代查和按信心代回（代查与按信心代回 spec D2）：要不要代查（宽松）、查完以后要不要自动回复（谨慎）。
  // 同样每个来源一条，由来源插件写成系统种子；Lead 和用户只能改参数。
  "channel.lookup",
  "channel.reply",
  // 授权表（落地计划 A5）：按对方的意图，通道能替你做什么。一条通用的（source "*"），来源可以有自己的一条覆盖它。
  "channel.authority",
  // 交接说明（自动代你处理方案 B，channel-handbook.ts）：每种情况一句话、一种做法，加上对方的上限。只有一条，对所有来源生效。
  "channel.handbook",
] as const;
export type StandingOrderRule = typeof STANDING_ORDER_RULES[number];

const Strict = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const Scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const TriageLevelSchema = Type.Union(TRIAGE_LEVELS.map((level) => Type.Literal(level)));

// 字段的测试：写一个值表示相等；{ in }、{ notIn } 是列表；{ not } 是不等；{ exists } 是有没有值（null 算没有）。
const FieldTestSchema = Type.Union([
  Scalar,
  Strict({ in: Type.Array(Scalar) }),
  Strict({ notIn: Type.Array(Scalar) }),
  Strict({ not: Scalar }),
  Strict({ exists: Type.Boolean() }),
]);
export type StandingOrderFieldTest = Static<typeof FieldTestSchema>;

// 条件的一支。kinds 可以写 "inbox.*" 匹配前缀；fields 的键是点分路径，例如 payload.wakeLead、rootCause.scope。
const ConditionBranchSchema = Strict({
  kinds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  sources: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  fields: Type.Optional(Type.Record(Type.String({ minLength: 1 }), FieldTestSchema)),
});
// 条件：自己的 kinds、sources、fields 都要满足；有 anyOf 时还要满足其中一支。空条件匹配一切。
export const StandingOrderConditionSchema = Strict({
  kinds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  sources: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  fields: Type.Optional(Type.Record(Type.String({ minLength: 1 }), FieldTestSchema)),
  anyOf: Type.Optional(Type.Array(ConditionBranchSchema, { minItems: 1 })),
});
export type StandingOrderCondition = Static<typeof StandingOrderConditionSchema>;

export const StandingOrderActionSchema = Type.Union([
  Strict({ type: Type.Literal("level"), level: TriageLevelSchema }),
  Strict({
    type: Type.Literal("rule"),
    rule: Type.Union(STANDING_ORDER_RULES.map((rule) => Type.Literal(rule))),
    params: Type.Record(Type.String(), Type.Unknown()),
    level: Type.Optional(TriageLevelSchema),
  }),
]);
export type StandingOrderAction =
  | { type: "level"; level: TriageLevel }
  | { type: "rule"; rule: StandingOrderRule; params: Record<string, unknown>; level?: TriageLevel };

// 上限（spec D4）：次数、时间窗、预算。超限以后怎样由规则自己说（例如熔断、升起 blocker）。
export const StandingOrderLimitsSchema = Strict({
  count: Type.Optional(Type.Integer({ minimum: 0 })),
  windowMs: Type.Optional(Type.Integer({ minimum: 0 })),
  budget: Type.Optional(Type.Number({ minimum: 0 })),
});
export type StandingOrderLimits = Static<typeof StandingOrderLimitsSchema>;

/** 一条常设指令的内容（一个版本里除了版本号、作者、状态以外的部分）。 */
export interface StandingOrderDefinition {
  // 编号：小写字母开头，点分，例如 inbox.wake_lead。版本之间不变。
  id: string;
  title: string;
  // 匹配的先后：小的先匹配。只对定级别的指令有意义。
  priority: number;
  condition: StandingOrderCondition;
  action: StandingOrderAction;
  limits: StandingOrderLimits | null;
  // 超限或到时限还没有处置时升到的级别。null 表示不升。
  escalateTo: TriageLevel | null;
  // 为什么有这条指令。新版本写为什么改。
  reason: string;
}

/** 库里的一个版本。 */
export interface StandingOrder extends StandingOrderDefinition {
  version: number;
  author: StandingOrderAuthor;
  approvedBy: string | null;
  status: StandingOrderStatus;
  createdAt: string;
  // 系统种子的修订号：这一版是代码里第几次修订的种子写的。只有作者是 system 的版本有，Lead 或用户写的是 null。
  // 同步只往前走：库里的修订号小于代码里的才写新版本（store 的 syncSystemStandingOrders）。
  seedRevision: number | null;
}

/** 一个决定的依据：哪条常设指令的哪一版（spec D5、用户故事 16）。version 为 0 表示库里读不到，用的是代码里的种子。 */
export interface StandingOrderRef {
  id: string;
  version: number;
}

/**
 * 事件的分诊依据，存进 events.triage（JSON）。order 是定级别的指令；applied 是别的起作用的指令
 * （合并、熔断、封顶），hardRules 是起作用的硬性安全规则（写在代码里，不进表）。
 */
export interface TriageBasis {
  order: StandingOrderRef | null;
  applied?: Array<StandingOrderRef & { effect: string }>;
  hardRules?: string[];
  // 按根因合并进了哪一条（seq）。合并的事件同时记成 superseded。
  mergedInto?: number;
}

// model_catalog.announce 的 stableRefreshes：没写时的值（不去抖），和允许的最大值。
export const MODEL_CATALOG_STABLE_REFRESHES_UNSET = 1;
export const MODEL_CATALOG_STABLE_REFRESHES_MAX = 10;

// 每条规则的参数 schema。写入和读出时都校验：读出来不合格的版本不用，规则退回代码里的种子。
const Ms = Type.Integer({ minimum: 1 });
export const STANDING_ORDER_RULE_PARAMS: Record<StandingOrderRule, TSchema> = {
  "inbox.merge_attention": Strict({}),
  "inbox.fuse_blockers": Strict({}),
  "inbox.wake_lead": Strict({ wakeWhen: StandingOrderConditionSchema }),
  "run.transient_retry": Strict({ baseMs: Ms, maxMs: Ms }),
  "model_catalog.announce": Strict({
    announceFirstRefresh: Type.Boolean(),
    refreshOnFailureScopes: Type.Array(Type.String({ minLength: 1 })),
    wakeLead: Type.Boolean(),
    // 去抖（工单 14）：连续几次刷新的结果相同才算一次变化。1 是不去抖。
    // 没写时按 1：这个参数出现以前写的版本就是这样运行的（MODEL_CATALOG_STABLE_REFRESHES_UNSET）。
    stableRefreshes: Type.Optional(Type.Integer({ minimum: 1, maximum: MODEL_CATALOG_STABLE_REFRESHES_MAX })),
  }),
  "reminder.fire": Strict({
    notificationKind: Type.String({ minLength: 1 }),
    urgency: Type.Union([Type.Literal("immediate"), Type.Literal("batchable")]),
    titlePrefix: Type.String(),
  }),
  "events.merge_root_cause": Strict({}),
  "events.escalate_overdue": Strict({
    // 没有分诊依据（或者依据的指令没写 escalateTo 以外的情况）时，按这张表升级。
    ladder: Type.Record(Type.String(), TriageLevelSchema),
  }),
  "events.digest_batch": Strict({ maxWaitMs: Ms, onUserReturn: Type.Boolean() }),
  "source.threshold": Strict({
    // 来源名；"*" 是没有自己指令的来源（外部来源的默认值）。
    source: Type.String({ minLength: 1 }),
    // 没有别的指令匹配时的级别。
    defaultLevel: TriageLevelSchema,
    // 打断阈值：这个来源的事件最高到哪一级（含升级）。
    maxLevel: TriageLevelSchema,
  }),
  "triage.jev": Strict({
    // 由 Jev 定级别的事件类型（精确的 kind）。空数组表示全部关闭：Jev 只做影子判断，不改级别。
    // 只有用户写的、或者用户批准过的版本里的类型才算数（store 的 jevTriageSwitch）。
    enabledKinds: Type.Array(Type.String({ minLength: 1 })),
  }),
  // 不能代回时怎样投递给用户（spec D10）。按 push → card → digest 的顺序取第一个匹配的条件，都不匹配时只记录。
  // 条件看事件（source、kind、entityKey、payload），写法和定级别的条件一样；null 表示这一档不用。
  // pushWhen 是这个来源的打断阈值：外部来源永远不插进 Lead 的回合（硬性规则），它的紧急程度只影响这里的投递方式。
  "channel.delivery": Strict({
    source: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
    pushWhen: Type.Union([StandingOrderConditionSchema, Type.Null()]),
    cardWhen: Type.Union([StandingOrderConditionSchema, Type.Null()]),
    digestWhen: Type.Union([StandingOrderConditionSchema, Type.Null()]),
  }),
  // 代你行动的闸门参数（spec D14）。闸门本身是 engine 的纯函数（delegation-gate.ts），五个条件都满足才自动回复：
  //   1. 类别在白名单里，并且在 openCategories 里（只有用户写的、或者用户批准过的版本里出现过的类别算数）；
  //   2. 发信人的信任级别在 allowedTrust 里（外部客户永不，硬性规则）；
  //   3. 风险低，并且类别的置信度不低于 minConfidence；
  //   4. 每个敏感话题的概率都低于 maxSensitivity；
  //   5. 这一类通过了影子模式：至少 shadowMinSamples 个样本，用户照草稿回复的比例不低于 shadowMinAgreement。
  // 自动回复以后留 revokeWindowMs 的撤回窗口。
  "channel.delegate": Strict({
    source: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
    openCategories: Type.Array(Type.Union(DELEGATION_CATEGORIES.map((category) => Type.Literal(category)))),
    allowedTrust: Type.Array(Type.Union(SENDER_TRUST_LEVELS.map((trust) => Type.Literal(trust)))),
    minConfidence: Type.Number({ minimum: 0, maximum: 1 }),
    maxSensitivity: Type.Number({ minimum: 0, maximum: 1 }),
    revokeWindowMs: Type.Integer({ minimum: 60_000 }),
    shadowMinSamples: Type.Integer({ minimum: 1 }),
    shadowMinAgreement: Type.Number({ minimum: 0, maximum: 1 }),
  }),
  // 代查闸门的参数（代查与按信心代回 spec D2、D4）。闸门是 engine 的纯函数，宽松的是「要不要查」，不是「能查什么」：
  //   - playbooks：开放的剧本；只有用户写的、系统种子、或者用户批准过的版本里出现过的剧本算数（store 的 channelLookupPolicy）。
  //   - allowedTrust：能代查的发信人（外部客户永不，硬性规则）。
  //   - minAskConfidence：请求 A 判断「这是一个请求」的置信度门槛；maxSensitiveQuery：每个敏感查询的概率上限。
  //   - 配额：perRequesterDaily 同一个请求者每天、dailyMax 全部每天、concurrent 同时进行的数量。
  //   - timeoutMs：一次代查从开始到结束的时限；maxRepos：一次最多查几个仓库（作用域的上限是 4）。
  "channel.lookup": Strict({
    source: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
    playbooks: Type.Array(Type.Union(LOOKUP_PLAYBOOKS.map((playbook) => Type.Literal(playbook)))),
    allowedTrust: Type.Array(Type.Union(SENDER_TRUST_LEVELS.map((trust) => Type.Literal(trust)))),
    minAskConfidence: Type.Number({ minimum: 0, maximum: 1 }),
    maxSensitiveQuery: Type.Number({ minimum: 0, maximum: 1 }),
    perRequesterDaily: Type.Integer({ minimum: 0 }),
    dailyMax: Type.Integer({ minimum: 0 }),
    concurrent: Type.Integer({ minimum: 1, maximum: 10 }),
    timeoutMs: Type.Integer({ minimum: 60_000, maximum: 60 * 60_000 }),
    maxRepos: Type.Integer({ minimum: 1, maximum: 4 }),
  }),
  // 代回闸门的参数（spec D2、D7）。查完以后才判断，必须同时满足才可能自动发：
  //   - autoReply：每个剧本开不开自动代回；打开的只有用户写的、系统种子、或者用户批准过的版本里出现过才算数
  //     （store 的 channelReplyPolicy）。
  //   - 信心 c 是最弱的一环。校准的样本够 calibrationMinSamples 时，要 c ≥ threshold 并且同意率不低于
  //     calibrationMinAgreement；样本不够时（冷启动）要 c ≥ coldStartMin。
  //   - maxSensitivity：请求 A 的话题概率上限（否决项）；maxResultAgeMs：结果超过这么久就不自动发。
  //   - revokeWindowMs：自动回复以后的撤回窗口。
  "channel.reply": Strict({
    source: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
    autoReply: Strict({ lookup: Type.Boolean(), review: Type.Boolean() }),
    threshold: Type.Number({ minimum: 0, maximum: 1 }),
    coldStartMin: Type.Number({ minimum: 0, maximum: 1 }),
    calibrationMinSamples: Type.Integer({ minimum: 1 }),
    calibrationMinAgreement: Type.Number({ minimum: 0, maximum: 1 }),
    maxSensitivity: Type.Number({ minimum: 0, maximum: 1 }),
    maxResultAgeMs: Type.Integer({ minimum: 60_000 }),
    revokeWindowMs: Type.Integer({ minimum: 60_000 }),
  }),
  // 授权表（落地计划 A5，engine 的 channels/authority.ts）：按请求 A 认出的意图，通道能替你做什么。
  //   - source："*" 是通用的一条（系统种子）；来源可以有自己的一条（来源插件的种子），有时用它。
  //   - intents：8 个意图各一项。action 是 auto（替你做）、remind（只提醒你）、refuse（用固定的话拒绝）、ask（问你）；
  //     minConfidence 是代你回复的最低信心（不写时按代价分档的门槛）。
  // 收紧（改成问你、提高门槛）Lead 可以直接改；放开要你批准（store 的 channelAuthorityTable 只认系统种子、你写的、
  // 你批准过的版本里出现过的放开）。涉密的永远不能替你做（硬性规则）。
  "channel.authority": Strict({
    source: Type.String({ pattern: "^(\\*|[a-z][a-z0-9_-]*)$" }),
    intents: Strict(Object.fromEntries(CHANNEL_INTENTS.map((intent) => [intent, Strict({
      action: Type.Union(CHANNEL_INTENT_PERMISSIONS.map((permission) => Type.Literal(permission))),
      minConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    })]))),
    // 自动代你处理的开关和信心模型的参数（2026-10-23，channel-confidence.ts）。没写时：开着、缺省参数。
    autoReply: Type.Optional(Type.Boolean()),
    model: Type.Optional(ChannelConfidenceParamsSchema),
  }),
  // 交接说明（channel-handbook.ts）。除了形状，还要有兜底的一句、编号不重复、客户的上限不超过「交给你」
  // （validStandingOrderRuleParams 和 validateStandingOrderDefinition 用 channelHandbookProblems 查）。
  "channel.handbook": ChannelHandbookSchema,
};

/** 规则的参数合不合格（store 读出一个版本时用：不合格的版本不用）。 */
export function validStandingOrderRuleParams(rule: StandingOrderRule, params: unknown): boolean {
  if (!Value.Check(STANDING_ORDER_RULE_PARAMS[rule], params)) return false;
  return rule !== "channel.handbook" || channelHandbookProblems(params).length === 0;
}

export const STANDING_ORDER_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** 校验一条常设指令的内容。返回所有问题；空数组表示可以用。 */
export function validateStandingOrderDefinition(definition: StandingOrderDefinition): string[] {
  const errors: string[] = [];
  if (typeof definition.id !== "string" || !STANDING_ORDER_ID_PATTERN.test(definition.id)) {
    errors.push(`编号 ${String(definition.id)} 要写成小写的点分形式，例如 inbox.wake_lead`);
  }
  if (typeof definition.title !== "string" || !definition.title.trim()) errors.push("标题不能为空");
  if (typeof definition.reason !== "string" || !definition.reason.trim()) errors.push("原因不能为空");
  if (!Number.isInteger(definition.priority)) errors.push("priority 要是整数");
  if (!Value.Check(StandingOrderConditionSchema, definition.condition)) errors.push("条件不符合 schema");
  if (!Value.Check(StandingOrderActionSchema, definition.action)) {
    errors.push("动作不符合 schema（level，或者白名单里的 rule 加 params）");
  } else if (definition.action.type === "rule"
    && !Value.Check(STANDING_ORDER_RULE_PARAMS[definition.action.rule], definition.action.params)) {
    errors.push(`规则 ${definition.action.rule} 的参数不符合 schema`);
  } else if (definition.action.type === "rule" && definition.action.rule === "channel.handbook") {
    errors.push(...channelHandbookProblems(definition.action.params));
  }
  if (definition.limits !== null && !Value.Check(StandingOrderLimitsSchema, definition.limits)) errors.push("上限不符合 schema");
  if (definition.escalateTo !== null && !isTriageLevel(definition.escalateTo)) errors.push(`escalateTo ${String(definition.escalateTo)} 不是级别`);
  // 形状不对时，下面的检查读不了字段。
  if (errors.length) return errors;
  // 定级别的指令必须说清对哪些事件：空条件会把所有事件都改成同一个级别。
  const level = standingOrderLevel(definition);
  if (level && !definition.condition.kinds?.length && !definition.condition.sources?.length) {
    errors.push("定级别的指令要写 kinds 或 sources");
  }
  if (level && definition.escalateTo && triageLevelRank(definition.escalateTo) <= triageLevelRank(level)) {
    errors.push(`escalateTo ${definition.escalateTo} 要比级别 ${level} 高`);
  }
  if (definition.condition.sources?.some((source) => !/^[a-z][a-z0-9_-]*$/.test(source))) {
    errors.push("sources 里有不合格的来源名");
  }
  return errors;
}

/** 这条指令定的级别：level 动作的级别，或者 rule 动作带的 level。不定级别时是 null。 */
export function standingOrderLevel(definition: Pick<StandingOrderDefinition, "action">): TriageLevel | null {
  return definition.action.type === "level" ? definition.action.level : definition.action.level ?? null;
}

// ── 条件匹配 ─────────────────────────────────────────────────────────────────────────

/** 条件看的对象。事件用 { source, kind, entityKey, payload, rootCause }；inbox 的一行用 { severity, payload }。 */
export type ConditionSubject = Record<string, unknown>;

function pathValue(subject: ConditionSubject, path: string): unknown {
  let value: unknown = subject;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function fieldPasses(value: unknown, test: StandingOrderFieldTest): boolean {
  if (test === null || typeof test !== "object") return value === test;
  if ("in" in test) return test.in.some((candidate) => candidate === value);
  if ("notIn" in test) return !test.notIn.some((candidate) => candidate === value);
  if ("not" in test) return value !== test.not;
  return test.exists ? value !== undefined && value !== null : value === undefined || value === null;
}

function kindPasses(kind: unknown, kinds: readonly string[]): boolean {
  if (typeof kind !== "string") return false;
  return kinds.some((pattern) => pattern.endsWith(".*") ? kind.startsWith(pattern.slice(0, -1)) : kind === pattern);
}

type Branch = Static<typeof ConditionBranchSchema>;

function branchPasses(branch: Branch, subject: ConditionSubject): boolean {
  if (branch.kinds?.length && !kindPasses(subject.kind, branch.kinds)) return false;
  if (branch.sources?.length && !branch.sources.includes(String(subject.source))) return false;
  for (const [path, test] of Object.entries(branch.fields ?? {})) {
    if (!fieldPasses(pathValue(subject, path), test)) return false;
  }
  return true;
}

/** 条件匹配：自己的 kinds、sources、fields 都满足，并且（有 anyOf 时）满足其中一支。 */
export function matchesStandingOrderCondition(condition: StandingOrderCondition, subject: ConditionSubject): boolean {
  if (!branchPasses(condition, subject)) return false;
  return !condition.anyOf?.length || condition.anyOf.some((branch) => branchPasses(branch, subject));
}
