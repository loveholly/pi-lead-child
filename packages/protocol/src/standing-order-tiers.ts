// 常设指令修改的三档（Lead 事件主干 spec D4，工单 10）。档位由代码比较新旧版本判断，不由 Lead 自己说。
//
// 三档：
//   - conservative 更保守：自动做得更少，更多交给用户或 Lead。Lead 改了直接生效，事后告诉用户。
//   - permissive 更放开：反方向（交给人的更少、自动做的更多），或者无法判断。要用户在审批卡上批准。
//   - forbidden 碰到硬性安全规则：拒绝，不写。
//
// 「保守」按两个维度比较级别（levelAtLeastAsConservative）：
//   - 交给人的程度：record 0 < digest 1 = auto 1 < tell 2 < interrupt 3（auto 做完进摘要，和 digest 一样只进「Lead 动态」）；
//   - 自动做的程度：auto 是 1，其余是 0。
//   a 至少和 b 一样保守：交给人的不少于 b，并且自动做的不多于 b。所以 digest → auto 是更放开（新增自动动作），
//   auto → digest 是更保守（去掉自动动作），auto → record 是更放开（交给人的更少）。
//
// 定级别的指令（level 动作，或者带 level 的规则）的判断是可靠的（sound），宁可多判「更放开」：
//   一个事件的结果是（级别，到时限升到的级别）。改一条指令只影响三类事件：
//   1. 新旧版本都匹配、都由它定级别的：新结果要至少和旧结果一样保守。
//   2. 新版本多接手的（条件放宽、priority 提前、新增或启用）：它们原来由排在新位置后面的指令或来源的默认级别处理。
//      新结果要至少和其中每一个一样保守。
//   3. 新版本放掉的（条件收窄、priority 推后、停用）：它们改由排在旧位置后面的指令或来源的默认级别处理。
//      其中每一个都要至少和旧结果一样保守。
//   条件是否收窄、放宽用 conditionImplies 判断（只认能证明的情况）。哪些指令可能和它重叠用 conditionsMayOverlap 排除
//   （只排除能证明不重叠的）。证明不了就按会发生处理。
//   不考虑来源的打断阈值（maxLevel）的封顶：封顶对新旧两边一样，不改变比较的结论。只有封顶到 auto 时会把高的级别
//   压成自动处理，这时一律按更放开处理。
//
// 规则类指令（白名单里的规则）按每条规则的参数语义判断，见 RULE_PARAM_CHECKS 和 LIMIT_DIRECTIONS。
// 对这条规则不起作用的字段（例如定级别的指令的 limits）改了，按「无法判断」处理，也就是更放开。
//
// 「关掉一条规则」（工单 10 的定义）：规则类指令不能停用，只能改参数。理由：
//   - 有几条规则没有安全的「关」：inbox.wake_lead 关了 blocker 不再叫醒 Lead，events.digest_batch 关了摘要永远不交给 Lead，
//     reminder.fire 关了提醒到点不再通知（硬性规则）。
//   - 想让一条规则少做事，都能用参数表达：run.transient_retry 的 limits.count 设 0 就不自动重试，
//     inbox.fuse_blockers 的 limits.count 调大就几乎不熔断，events.merge_root_cause 的条件收窄就少合并。
//   - store 读规则时，停用的版本退回代码里的种子（ruleStandingOrder）。如果允许停用，一个更保守的参数版本被停用后，
//     行为会悄悄退回种子，可能更放开，却没有经过批准。
// 所以停用规则类指令按硬性规则拒绝（rules_stay_on）。定级别的指令可以停用：停用就是不再参加匹配，按上面第 3 类判断。
//
// 「升到 interrupt」单独一条（interruptFindings，审查后加的）：任何让事件升到 interrupt 的修改都按更放开处理，要用户批准。
// interrupt 会推送到用户手机，也会插进 Lead 正在进行的回合，用户明确说过不想被淹没；所以它不能按「交给人的更多」直接生效。
// 包括：定级别的指令把级别或 escalateTo 改成 interrupt、新建或启用定为 interrupt 的指令、放宽或提前一条已经是 interrupt 的指令、
// 来源阈值的打断上限或默认级别升到 interrupt、events.escalate_overdue 的 ladder 新增升到 interrupt 的一级。
// 这一条只加一项「更放开」的判断，不改上面两个维度的比较；升到 tell 及以下仍按原来的规则判断。
import { EVENT_SOURCES, eventKindDefinition } from "./events.ts";
import {
  CHANNEL_INTENT_PERMISSION_RANK, CHANNEL_INTENTS, DELEGATION_CATEGORY_LABELS, LOOKUP_PLAYBOOK_LABELS, NEVER_DELEGATED_TRUST, SENDER_TRUST_LABELS,
  type ChannelIntentPermission, type DelegationCategory, type SenderTrust,
} from "./channel-policy.ts";
import { LOOKUP_PLAYBOOKS, type LookupPlaybook } from "./channel-lookup.ts";
import { CHANNEL_AUTO_REPLY_DEFAULT, CHANNEL_CONFIDENCE_DEFAULTS, type ChannelConfidenceParams } from "./channel-confidence.ts";
import {
  ChannelHandbookSchema, HANDBOOK_CAP_SENDERS, HANDBOOK_FALLBACK_ID, handbookModeCovers,
  type ChannelHandbook, type HandbookAbility, type HandbookMode, type HandbookSituation,
} from "./channel-handbook.ts";
import {
  MODEL_CATALOG_STABLE_REFRESHES_UNSET, STANDING_ORDER_RULE_PARAMS, standingOrderLevel, triageLevelRank,
  type StandingOrderCondition, type StandingOrderDefinition, type StandingOrderFieldTest, type StandingOrderRule,
  type StandingOrderStatus, type TriageLevel,
} from "./standing-orders.ts";
import { DEFAULT_LOCALE, type Locale } from "./i18n.ts";
import { standingOrderChangeText, TRIAGE_LEVEL_LABELS } from "./standing-order-tiers.messages.ts";
import { Value } from "typebox/value";

export const STANDING_ORDER_CHANGE_TIERS = ["conservative", "permissive", "forbidden"] as const;
export type StandingOrderChangeTier = typeof STANDING_ORDER_CHANGE_TIERS[number];

// Lead 能提的修改：新增、修改、停用、启用、回滚到某一版。
export const STANDING_ORDER_CHANGE_OPS = ["create", "update", "disable", "enable", "rollback"] as const;
export type StandingOrderChangeOp = typeof STANDING_ORDER_CHANGE_OPS[number];

// 修改时会碰到的硬性规则（写在代码里，不进常设指令表）。前两条和 store 的 event-triage.ts 分诊时用的是同一组。
export const STANDING_ORDER_HARD_RULES = {
  // 审批要在过期前送到用户：常设指令不能针对审批的事件（authorityType）。
  approvalReachesUser: "approval_reaches_user",
  // 外部来源的事件永远不打断 Lead 正在进行的回合：不能给外部来源定 interrupt。
  externalNeverInterrupts: "external_never_interrupts",
  // 提醒到点一定发通知：reminder.fire 不能关。
  reminderAlwaysFires: "reminder_always_fires",
  // 规则类指令不能停用，只能改参数（见文件头）。
  rulesStayOn: "rules_stay_on",
  // 规则类指令不能换规则，也不能和定级别的指令互换；新指令只能定级别，或者是来源阈值（source.threshold）。
  ruleIdentityFixed: "rule_identity_fixed",
  // 外部客户的消息永不代回（spec D4、D14）：channel.delegate 的 allowedTrust 不能有 customer。
  customersNeverDelegated: "customers_never_delegated",
  // 外部客户的消息永不代查（代查与按信心代回 spec D2）：channel.lookup 的 allowedTrust 不能有 customer。
  customersNeverLookedUp: "customers_never_looked_up",
  // 涉密的永远不替你做（用户 2026-10-22，落地计划 A5）：channel.authority 的 secret 不能是 auto。
  secretsNeverDelegated: "secrets_never_delegated",
} as const;

export interface StandingOrderChangeFinding {
  tier: StandingOrderChangeTier;
  // 哪一方面：hard_rule、level、escalate_to、condition、priority、status、limits、params、title。
  aspect: string;
  // 给人看的一句话。
  detail: string;
  // forbidden 时是哪条硬性规则。
  hardRule?: string;
}

export interface StandingOrderChangeClassification {
  tier: StandingOrderChangeTier;
  // false：新内容和现在的一样（只有原因不同），不用写新版本。
  changed: boolean;
  findings: StandingOrderChangeFinding[];
}

/** 一条指令的一个状态：内容加上 active 或 disabled。 */
export type StandingOrderState = StandingOrderDefinition & { status: StandingOrderStatus };

export interface StandingOrderChangeInput {
  // 现在生效的全部指令（store 的 activeStandingOrders）：每条的最新版本，active 并且合格；不合格的系统指令已经换成种子。
  active: readonly StandingOrderState[];
  // 改之前的样子：这条指令现在的版本（停用的也算）。新增时是 null。
  before: StandingOrderState | null;
  // 改之后的样子。
  after: StandingOrderState;
  // finding.detail 用的语言。缺省英文；store 现在传 "zh"。
  locale?: Locale;
}

// ── 级别的比较 ────────────────────────────────────────────────────────────────────

const ATTENTION: Record<TriageLevel, number> = { record: 0, digest: 1, auto: 1, tell: 2, interrupt: 3 };
const AUTOMATION: Record<TriageLevel, number> = { record: 0, digest: 0, auto: 1, tell: 0, interrupt: 0 };

// 级别的中文名（store 写事件摘要时用）。定义在 standing-order-tiers.messages.ts，和 finding 的中文共用。
export { TRIAGE_LEVEL_LABELS };

// 给人看的句子（finding.detail）的文案，按 input.locale 取。classifyStandingOrderChange 是同步的纯函数：
// 进来时把 t 换成那种语言的文案，出去时还原；下面写句子的函数都读 t，不用一层层传。
let t = standingOrderChangeText(DEFAULT_LOCALE);

const levelText = (level: TriageLevel) => t.level(level);

/** a 至少和 b 一样保守：交给人的不少于 b，自动做的不多于 b。 */
export function levelAtLeastAsConservative(a: TriageLevel, b: TriageLevel): boolean {
  return ATTENTION[a] >= ATTENTION[b] && AUTOMATION[a] <= AUTOMATION[b];
}

// 一个事件的结果：一开始的级别，和到时限还没有处置时升到的级别（不升时等于 level）。
interface Outcome { level: TriageLevel; eventual: TriageLevel }

const DEFAULT_LADDER: Readonly<Record<string, TriageLevel>> = { digest: "tell", auto: "tell" };

// 和 store 的 event-rules.ts（escalationTarget）一样：先看指令的 escalateTo，没写时按 ladder；只往上升。record 不升级。
function outcome(level: TriageLevel, escalateTo: TriageLevel | null, ladder: Readonly<Record<string, TriageLevel>>): Outcome {
  if (level === "record") return { level, eventual: level };
  const target = escalateTo ?? ladder[level] ?? null;
  return { level, eventual: target && triageLevelRank(target) > triageLevelRank(level) ? target : level };
}

const outcomeAtLeastAsConservative = (a: Outcome, b: Outcome) =>
  levelAtLeastAsConservative(a.level, b.level) && levelAtLeastAsConservative(a.eventual, b.eventual);
const sameOutcome = (a: Outcome, b: Outcome) => a.level === b.level && a.eventual === b.eventual;
const outcomeText = (o: Outcome) => o.eventual === o.level ? levelText(o.level) : t.outcome(levelText(o.level), o.eventual);

function escalationLadder(active: readonly StandingOrderState[]): Readonly<Record<string, TriageLevel>> {
  const order = active.find((candidate) => candidate.action.type === "rule" && candidate.action.rule === "events.escalate_overdue");
  const ladder = order?.action.type === "rule" ? (order.action.params as { ladder?: unknown }).ladder : undefined;
  if (!ladder || typeof ladder !== "object") return DEFAULT_LADDER;
  return Object.fromEntries(Object.entries(ladder as Record<string, unknown>)
    .filter((entry): entry is [string, TriageLevel] => typeof entry[1] === "string" && entry[1] in ATTENTION));
}

// ── 条件的包含和重叠（只认能证明的情况） ──────────────────────────────────────────

type Branch = Pick<StandingOrderCondition, "kinds" | "sources" | "fields">;
type Scalar = string | number | boolean | null;

// 匹配 p 的每一种事件也匹配 q。q 是 "inbox.*" 这样的前缀时，p 以它开头就行。
function kindCovered(p: string, q: string): boolean {
  if (p === q) return true;
  return q.endsWith(".*") && p.startsWith(q.slice(0, -1));
}

function kindsMayOverlap(p: string, q: string): boolean {
  const pp = p.endsWith(".*") ? p.slice(0, -1) : null;
  const qp = q.endsWith(".*") ? q.slice(0, -1) : null;
  if (pp === null && qp === null) return p === q;
  if (pp !== null && qp !== null) return pp.startsWith(qp) || qp.startsWith(pp);
  return pp !== null ? q.startsWith(pp) : p.startsWith(qp!);
}

const isScalar = (test: StandingOrderFieldTest): test is Scalar => test === null || typeof test !== "object";

/** 通过测试 a 的值一定通过测试 b。 */
export function fieldTestImplies(a: StandingOrderFieldTest, b: StandingOrderFieldTest): boolean {
  if (stableJson(a) === stableJson(b)) return true;
  // a 允许的值是一个有限的集合时，逐个检查。
  if (isScalar(a)) return valuePasses(a, b);
  if ("in" in a) return a.in.length > 0 && a.in.every((value) => valuePasses(value, b));
  if (isScalar(b) || "in" in b) return false;
  if ("notIn" in a) {
    if ("notIn" in b) return b.notIn.every((value) => a.notIn.includes(value));
    if ("not" in b) return a.notIn.includes(b.not);
    return false;
  }
  if ("not" in a) {
    if ("not" in b) return a.not === b.not;
    if ("notIn" in b) return b.notIn.every((value) => value === a.not);
    return false;
  }
  // a 是 exists。
  if ("exists" in b) return a.exists === b.exists;
  if (a.exists) {
    // 值不是 undefined，也不是 null。
    if ("not" in b) return b.not === null;
    return b.notIn.every((value) => value === null);
  }
  // 值是 undefined 或 null。
  if ("not" in b) return b.not !== null;
  return !b.notIn.includes(null);
}

function valuePasses(value: Scalar, test: StandingOrderFieldTest): boolean {
  if (isScalar(test)) return value === test;
  if ("in" in test) return test.in.includes(value);
  if ("notIn" in test) return !test.notIn.includes(value);
  if ("not" in test) return value !== test.not;
  return test.exists ? value !== null : value === null;
}

// 能证明两个测试没有共同的值时返回 true。
function fieldTestsDisjoint(a: StandingOrderFieldTest, b: StandingOrderFieldTest): boolean {
  const finite = (test: StandingOrderFieldTest): Scalar[] | null => isScalar(test) ? [test] : "in" in test ? test.in : null;
  const va = finite(a);
  const vb = finite(b);
  if (va) return !va.some((value) => valuePasses(value, b));
  if (vb) return !vb.some((value) => valuePasses(value, a));
  return !isScalar(a) && !isScalar(b) && "exists" in a && "exists" in b && a.exists !== b.exists;
}

// 一组同时成立的分支（conj）能不能推出分支 b 的每一项要求。
function branchesImply(conj: readonly Branch[], b: Branch): boolean {
  if (b.kinds?.length && !conj.some((a) => a.kinds?.length && a.kinds.every((p) => b.kinds!.some((q) => kindCovered(p, q))))) {
    return false;
  }
  if (b.sources?.length && !conj.some((a) => a.sources?.length && a.sources.every((source) => b.sources!.includes(source)))) {
    return false;
  }
  for (const [path, test] of Object.entries(b.fields ?? {})) {
    if (!conj.some((a) => a.fields?.[path] !== undefined && fieldTestImplies(a.fields[path]!, test))) return false;
  }
  return true;
}

/** 匹配 a 的事件一定匹配 b（a 是 b 的子集）。证明不了时返回 false。 */
export function conditionImplies(a: StandingOrderCondition, b: StandingOrderCondition): boolean {
  const top: Branch = { kinds: a.kinds, sources: a.sources, fields: a.fields };
  const bTop: Branch = { kinds: b.kinds, sources: b.sources, fields: b.fields };
  const cases: Branch[][] = a.anyOf?.length ? a.anyOf.map((branch) => [top, branch]) : [[top]];
  return cases.every((conj) => branchesImply(conj, bTop) && (!b.anyOf?.length || b.anyOf.some((branch) => branchesImply(conj, branch))));
}

/** 两个条件可能匹配同一个事件。只有能证明不重叠时返回 false（只看顶层的 kinds、sources、fields）。 */
export function conditionsMayOverlap(a: StandingOrderCondition, b: StandingOrderCondition): boolean {
  if (a.kinds?.length && b.kinds?.length && !a.kinds.some((p) => b.kinds!.some((q) => kindsMayOverlap(p, q)))) return false;
  const sa = possibleSources(a);
  const sb = possibleSources(b);
  if (sa && sb && !sa.some((source) => sb.includes(source))) return false;
  for (const [path, test] of Object.entries(a.fields ?? {})) {
    const other = b.fields?.[path];
    if (other !== undefined && fieldTestsDisjoint(test, other)) return false;
  }
  return true;
}

// 匹配这个条件的事件可能来自哪些来源。写了 sources 时就是它；只写了注册过的事件类型（不带 .*）时，是这些类型的来源；
// 其余情况不知道（null）。
function possibleSources(condition: StandingOrderCondition): string[] | null {
  if (condition.sources?.length) return [...condition.sources];
  const kinds = condition.kinds;
  if (!kinds?.length || kinds.some((kind) => kind.endsWith(".*") || !eventKindDefinition(kind))) return null;
  return [...new Set(kinds.flatMap((kind) => [...eventKindDefinition(kind)!.sources]))];
}

const isInternalSource = (source: string) => (EVENT_SOURCES as readonly string[]).includes(source);

// ── 排序和阈值 ────────────────────────────────────────────────────────────────────

// a 排在 b 前面（和 store 的 byPriority 一样：priority 小的先，相同时按编号）。
function sortsBefore(a: Pick<StandingOrderDefinition, "priority" | "id">, b: Pick<StandingOrderDefinition, "priority" | "id">): boolean {
  return a.priority < b.priority || (a.priority === b.priority && a.id < b.id);
}

const isThreshold = (order: StandingOrderState | null): order is StandingOrderState & { action: { type: "rule" } } =>
  order !== null && order.action.type === "rule" && order.action.rule === "source.threshold"
  && Value.Check(STANDING_ORDER_RULE_PARAMS["source.threshold"], order.action.params);

interface ThresholdParams { source: string; defaultLevel: TriageLevel; maxLevel: TriageLevel }
const thresholdParams = (order: StandingOrderState) => (order.action as { params: unknown }).params as ThresholdParams;

function withChange(active: readonly StandingOrderState[], after: StandingOrderState): StandingOrderState[] {
  return [...active.filter((order) => order.id !== after.id), ...(after.status === "active" ? [after] : [])]
    .sort((a, b) => sortsBefore(a, b) ? -1 : sortsBefore(b, a) ? 1 : 0);
}

// 和 store 的 sourceThreshold 一样：这个来源自己的阈值，没有时用 "*"。
function pickThreshold(list: readonly StandingOrderState[], source: string): StandingOrderState | null {
  const thresholds = list.filter((order) => order.status === "active" && isThreshold(order));
  return thresholds.find((order) => thresholdParams(order).source === source)
    ?? thresholds.find((order) => thresholdParams(order).source === "*") ?? null;
}

// 条件匹配不到的事件按哪些阈值的默认级别处理。来源知道时只看这些来源的阈值，不知道时看全部。
function relevantThresholds(condition: StandingOrderCondition, lists: readonly (readonly StandingOrderState[])[]): StandingOrderState[] {
  const sources = possibleSources(condition);
  const found = new Map<string, StandingOrderState>();
  for (const list of lists) {
    const candidates = sources
      ? sources.map((source) => pickThreshold(list, source)).filter((order): order is StandingOrderState => order !== null)
      : list.filter((order) => order.status === "active" && isThreshold(order));
    for (const order of candidates) found.set(stableJson(order), order);
  }
  return [...found.values()];
}

// ── 判断 ──────────────────────────────────────────────────────────────────────────

const finding = (tier: StandingOrderChangeTier, aspect: string, detail: string, hardRule?: string): StandingOrderChangeFinding =>
  ({ tier, aspect, detail, ...(hardRule ? { hardRule } : {}) });

function fieldPaths(condition: StandingOrderCondition | undefined): string[] {
  if (!condition) return [];
  return [condition, ...(condition.anyOf ?? [])].flatMap((branch) => Object.keys(branch.fields ?? {}));
}

function conditionSources(condition: StandingOrderCondition): string[] {
  return [condition, ...(condition.anyOf ?? [])].flatMap((branch) => branch.sources ?? []);
}

function hardRuleFindings({ before, after }: StandingOrderChangeInput): StandingOrderChangeFinding[] {
  const found: StandingOrderChangeFinding[] = [];
  const params = after.action.type === "rule" ? after.action.params as Record<string, unknown> : {};
  const wakeWhen = after.action.type === "rule" && after.action.rule === "inbox.wake_lead"
    ? params.wakeWhen as StandingOrderCondition | undefined : undefined;
  if ([...fieldPaths(after.condition), ...fieldPaths(wakeWhen)].some((path) => /authorityType/i.test(path))) {
    found.push(finding("forbidden", "hard_rule", t.hard.approvalEvents,
      STANDING_ORDER_HARD_RULES.approvalReachesUser));
  }
  const level = standingOrderLevel(after);
  if (after.status === "active" && (level === "interrupt" || after.escalateTo === "interrupt")
    && conditionSources(after.condition).some((source) => !isInternalSource(source))) {
    found.push(finding("forbidden", "hard_rule", t.hard.externalNeverInterrupts,
      STANDING_ORDER_HARD_RULES.externalNeverInterrupts));
  }
  if (isThreshold(after)) {
    const threshold = thresholdParams(after);
    if (!isInternalSource(threshold.source) && (threshold.maxLevel === "interrupt" || threshold.defaultLevel === "interrupt")) {
      found.push(finding("forbidden", "hard_rule", t.hard.externalThreshold(threshold.source),
        STANDING_ORDER_HARD_RULES.externalNeverInterrupts));
    }
  }
  if (before && before.action.type !== after.action.type) {
    found.push(finding("forbidden", "hard_rule", t.hard.ruleLevelSwap, STANDING_ORDER_HARD_RULES.ruleIdentityFixed));
  } else if (before?.action.type === "rule" && after.action.type === "rule" && before.action.rule !== after.action.rule) {
    found.push(finding("forbidden", "hard_rule", t.hard.ruleSwap(before.action.rule), STANDING_ORDER_HARD_RULES.ruleIdentityFixed));
  } else if (!before && after.action.type === "rule" && after.action.rule !== "source.threshold") {
    found.push(finding("forbidden", "hard_rule", t.hard.ruleHasOrder(after.action.rule),
      STANDING_ORDER_HARD_RULES.ruleIdentityFixed));
  }
  if (after.action.type === "rule" && (after.action.rule === "channel.delegate" || after.action.rule === "channel.lookup")) {
    const trust = Array.isArray(params.allowedTrust) ? params.allowedTrust.map(String) : [];
    const never = trust.filter((level) => (NEVER_DELEGATED_TRUST as readonly string[]).includes(level));
    const lookup = after.action.rule === "channel.lookup";
    if (never.length) {
      found.push(finding("forbidden", "hard_rule", t.hard.neverDelegated(never, lookup),
        lookup ? STANDING_ORDER_HARD_RULES.customersNeverLookedUp : STANDING_ORDER_HARD_RULES.customersNeverDelegated));
    }
  }
  if (after.action.type === "rule" && after.action.rule === "channel.authority") {
    const secret = ((params.intents ?? {}) as Record<string, { action?: unknown } | undefined>).secret;
    if (secret?.action === "auto") {
      found.push(finding("forbidden", "hard_rule", t.hard.secret,
        STANDING_ORDER_HARD_RULES.secretsNeverDelegated));
    }
  }
  if (after.action.type === "rule" && after.status === "disabled") {
    found.push(after.action.rule === "reminder.fire"
      ? finding("forbidden", "hard_rule", t.hard.reminderFires, STANDING_ORDER_HARD_RULES.reminderAlwaysFires)
      : finding("forbidden", "hard_rule", t.hard.rulesStayOn, STANDING_ORDER_HARD_RULES.rulesStayOn));
  }
  return found;
}

interface Candidate { label: string; outcome: Outcome }

const candidateList = (candidates: readonly Candidate[]) =>
  t.list(candidates.map((c) => t.levels.candidate(c.label, outcomeText(c.outcome))));

function levelFindings(input: StandingOrderChangeInput, ladder: Readonly<Record<string, TriageLevel>>): StandingOrderChangeFinding[] {
  const { active, before, after } = input;
  const levelBefore = before && before.status === "active" ? standingOrderLevel(before) : null;
  const levelAfter = after.status === "active" ? standingOrderLevel(after) : null;
  if (!levelBefore && !levelAfter) {
    // 停用着的定级别的指令：改了也不起作用，以后启用时再判断。
    return before && standingOrderLevel(after) !== null && behaviourKey(before) !== behaviourKey(after)
      ? [finding("conservative", "status", t.levels.disabled)]
      : [];
  }
  const found: StandingOrderChangeFinding[] = [];
  const outBefore = levelBefore ? outcome(levelBefore, before!.escalateTo, ladder) : null;
  const outAfter = levelAfter ? outcome(levelAfter, after.escalateTo, ladder) : null;
  const others = active.filter((order) => order.id !== after.id && order.status === "active" && standingOrderLevel(order) !== null);
  const lists = [active, withChange(active, after)];
  const orderCandidate = (order: StandingOrderState): Candidate =>
    ({ label: order.id, outcome: outcome(standingOrderLevel(order)!, order.escalateTo, ladder) });
  // 条件变了时：排在 position 后面、可能重叠的指令，加上来源的默认级别。
  const candidates = (position: StandingOrderState): Candidate[] => [
    ...others.filter((order) => sortsBefore(position, order) && conditionsMayOverlap(position.condition, order.condition))
      .map(orderCandidate),
    ...relevantThresholds(position.condition, lists).map((order) => ({
      label: t.levels.thresholdDefault(order.id), outcome: outcome(thresholdParams(order).defaultLevel, order.escalateTo, ladder),
    })),
  ];
  // 只挪了位置时：只有两个位置之间、可能重叠的指令会接手或被接手。事件仍然匹配这条指令，落不到来源的默认级别。
  const between = (first: StandingOrderState, second: StandingOrderState, condition: StandingOrderCondition): Candidate[] =>
    others.filter((order) => sortsBefore(first, order) && sortsBefore(order, second) && conditionsMayOverlap(condition, order.condition))
      .map(orderCandidate);

  if (outBefore && outAfter && !sameOutcome(outBefore, outAfter)) {
    found.push(outcomeAtLeastAsConservative(outAfter, outBefore)
      ? finding("conservative", "level", t.levels.safer(outcomeText(outBefore), outcomeText(outAfter)))
      : finding("permissive", "level", t.levels.looser(outcomeText(outBefore), outcomeText(outAfter))));
  }
  // 多接手的事件：新增或启用，新条件不能证明是旧条件的子集，或者排到了更前面。
  const narrowerOrSame = outBefore !== null && conditionImplies(after.condition, before!.condition);
  const captures = outAfter !== null && (!narrowerOrSame || sortsBefore(after, before!));
  if (captures) {
    const pool = narrowerOrSame ? between(after, before!, after.condition) : candidates(after);
    const weaker = pool.filter((candidate) => !outcomeAtLeastAsConservative(outAfter!, candidate.outcome));
    found.push(weaker.length
      ? finding("permissive", "condition",
        t.levels.captureLooser(candidateList(weaker), outcomeText(outAfter!)))
      : finding("conservative", "condition", t.levels.captureSafe(outcomeText(outAfter!))));
  }
  // 放掉的事件：停用，旧条件不能证明是新条件的子集，或者排到了更后面。
  const widerOrSame = outAfter !== null && outBefore !== null && conditionImplies(before!.condition, after.condition);
  const releases = outBefore !== null && (!widerOrSame || sortsBefore(before!, after));
  if (releases) {
    const pool = widerOrSame ? between(before!, after, before!.condition) : candidates(before!);
    const weaker = pool.filter((candidate) => !outcomeAtLeastAsConservative(candidate.outcome, outBefore!));
    found.push(weaker.length
      ? finding("permissive", outAfter ? "condition" : "status",
        t.levels.releaseLooser(candidateList(weaker), outcomeText(outBefore!)))
      : finding("conservative", outAfter ? "condition" : "status", t.levels.releaseSafe(outcomeText(outBefore!))));
  }
  if (outBefore && outAfter && sameOutcome(outBefore, outAfter) && !captures && !releases) {
    found.push(finding("conservative", "level", t.levels.same(outcomeText(outAfter))));
  }
  // 来源的阈值封顶到 auto 时，上面的比较不可靠：比 auto 高的级别会被压成自动处理。封顶到别的级别不影响比较的结论。
  if (lists.some((list) => list.some((order) => isThreshold(order) && thresholdParams(order).maxLevel === "auto"))) {
    found.push(finding("permissive", "level", t.levels.capAuto));
  }
  return found;
}

// 规则的上限：哪个方向更保守。没列的上限对这条规则不起作用。
const LIMIT_DIRECTIONS: Partial<Record<StandingOrderRule, Partial<Record<"count" | "windowMs" | "budget", "higher" | "lower">>>> = {
  // 熔断：同一范围第 count 条 blocker 起熔断。count 越大、窗口越短，熔断越晚，告诉 Lead 的越多。
  "inbox.fuse_blockers": { count: "higher", windowMs: "lower" },
  // 自动重试的次数越少越保守。
  "run.transient_retry": { count: "lower" },
  // 按根因合并的时间窗越短，合并得越少。
  "events.merge_root_cause": { windowMs: "lower" },
  // 每一轮升级的条数越多、时限越短，越保守。
  "events.escalate_overdue": { count: "higher", windowMs: "lower" },
};

function limitFindings(rule: StandingOrderRule | null, before: StandingOrderState | null, after: StandingOrderState): StandingOrderChangeFinding[] {
  const found: StandingOrderChangeFinding[] = [];
  const old = (before?.limits ?? {}) as Record<string, number | undefined>;
  const next = (after.limits ?? {}) as Record<string, number | undefined>;
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (old[key] === next[key]) continue;
    const direction = rule ? LIMIT_DIRECTIONS[rule]?.[key as "count"] : undefined;
    const label = t.limits.label(key, t.limits.labels[key] ?? key);
    if (!direction) {
      found.push(finding("permissive", "limits", t.limits.noEffect(label)));
    } else if (typeof old[key] !== "number" || typeof next[key] !== "number") {
      found.push(finding("permissive", "limits", t.limits.changedUnknown(label, String(old[key] ?? t.unset), String(next[key] ?? t.unset))));
    } else {
      const conservative = direction === "higher" ? next[key]! > old[key]! : next[key]! < old[key]!;
      found.push(finding(conservative ? "conservative" : "permissive", "limits", t.limits.changed(label, String(old[key]), String(next[key]))));
    }
  }
  return found;
}

// 一个布尔参数：true 更保守（conservativeWhen=true）或者 false 更保守。
function booleanParam(name: string, old: unknown, next: unknown, conservativeWhen: boolean, label: string): StandingOrderChangeFinding[] {
  if (old === next) return [];
  return [finding(next === conservativeWhen ? "conservative" : "permissive", "params", t.changed(t.param(name, label), String(old), String(next)))];
}

function anyChange(name: string, old: unknown, next: unknown, tier: StandingOrderChangeTier, detail: string): StandingOrderChangeFinding[] {
  return stableJson(old) === stableJson(next) ? [] : [finding(tier, "params", t.detail(name, detail))];
}

// 模型目录的去抖（工单 14）：连续几次刷新的结果相同才算变化。数字调大，告诉 Lead 的更少，更放开；调小更保守。
// 没写按 1（MODEL_CATALOG_STABLE_REFRESHES_UNSET）。不是正整数的值无法判断。
function stableRefreshesFindings(old: unknown, next: unknown): StandingOrderChangeFinding[] {
  const value = (raw: unknown) => raw === undefined ? MODEL_CATALOG_STABLE_REFRESHES_UNSET : raw;
  const before = value(old);
  const after = value(next);
  if (before === after) return [];
  const label = t.param("stableRefreshes", t.params.stableRefreshes);
  if (!Number.isInteger(before) || !Number.isInteger(after)) {
    return [finding("permissive", "params", t.changedUnknown(label, String(before), String(after)))];
  }
  return [finding(Number(after) < Number(before) ? "conservative" : "permissive", "params", t.changed(label, String(before), String(after)))];
}

type ParamCheck = (old: Record<string, unknown>, next: Record<string, unknown>, ladder: Readonly<Record<string, TriageLevel>>) => StandingOrderChangeFinding[];

// 一个数值参数：变大更保守（conservativeWhen="higher"）或者变小更保守。
function numberParam(name: string, old: unknown, next: unknown, conservativeWhen: "higher" | "lower", label: string): StandingOrderChangeFinding[] {
  if (old === next) return [];
  if (typeof old !== "number" || typeof next !== "number") {
    return [finding("permissive", "params", t.changedUnknown(t.param(name, label), String(old), String(next)))];
  }
  const conservative = conservativeWhen === "higher" ? next > old : next < old;
  return [finding(conservative ? "conservative" : "permissive", "params", t.changed(t.param(name, label), String(old), String(next)))];
}

// 一个集合参数：加进去的项更放开（例如开放代回的类别），去掉的项更保守。
function setParam(name: string, old: unknown, next: unknown, label: (value: string) => string, verb: string): StandingOrderChangeFinding[] {
  // verb 是 t.set.verbs 里的一个。
  const before = new Set(Array.isArray(old) ? old.map(String) : []);
  const after = new Set(Array.isArray(next) ? next.map(String) : []);
  const added = [...after].filter((value) => !before.has(value));
  const removed = [...before].filter((value) => !after.has(value));
  return [
    ...(added.length ? [finding("permissive", "params", t.set.added(name, verb, t.list(added.map(label))))] : []),
    ...(removed.length ? [finding("conservative", "params", t.set.removed(name, verb, t.list(removed.map(label))))] : []),
  ];
}

// 一档投递的条件（channel.delivery）。widerIsConservative：条件放宽时交给用户的更多（会话卡、摘要）。
// 打断（推送）这一档两个方向都要用户批准：放宽是升到打断（见 interruptFindings 的理由），收窄是交给用户的更少。
function deliveryCondition(name: string, old: unknown, next: unknown, label: string, push: boolean): StandingOrderChangeFinding[] {
  const a = (old ?? null) as StandingOrderCondition | null;
  const b = (next ?? null) as StandingOrderCondition | null;
  if (stableJson(a) === stableJson(b)) return [];
  if (push) {
    const wider = a === null || (b !== null && conditionImplies(a, b));
    return [finding("permissive", "params", wider ? t.delivery.pushWider(t.param(name, label)) : t.delivery.pushNarrower(t.param(name, label)))];
  }
  const wider = b !== null && (a === null || conditionImplies(a, b));
  return [wider
    ? finding("conservative", "params", t.delivery.wider(t.param(name, label)))
    : finding("permissive", "params", t.delivery.narrower(t.param(name, label)))];
}

// 每条规则的参数：哪个方向更保守。没有方向的参数改了按「无法判断」处理。
const RULE_PARAM_CHECKS: Record<StandingOrderRule, ParamCheck> = {
  "inbox.merge_attention": () => [],
  "inbox.fuse_blockers": () => [],
  "inbox.wake_lead": (old, next) => {
    const a = old.wakeWhen as StandingOrderCondition;
    const b = next.wakeWhen as StandingOrderCondition;
    if (stableJson(a) === stableJson(b)) return [];
    return conditionImplies(a, b)
      ? [finding("conservative", "params", t.params.wakeWider)]
      : [finding("permissive", "params", t.params.wakeNarrower)];
  },
  "run.transient_retry": (old, next) => [
    ...anyChange("baseMs", old.baseMs, next.baseMs, "permissive", t.params.retryWait),
    ...anyChange("maxMs", old.maxMs, next.maxMs, "permissive", t.params.retryMax),
  ],
  "model_catalog.announce": (old, next) => [
    ...booleanParam("announceFirstRefresh", old.announceFirstRefresh, next.announceFirstRefresh, true, t.params.announceFirst),
    ...booleanParam("wakeLead", old.wakeLead, next.wakeLead, true, t.params.wakeLead),
    ...anyChange("refreshOnFailureScopes", old.refreshOnFailureScopes, next.refreshOnFailureScopes, "permissive", t.params.refreshScopes),
    ...stableRefreshesFindings(old.stableRefreshes, next.stableRefreshes),
  ],
  "reminder.fire": (old, next) => [
    ...(old.urgency === next.urgency ? [] : [finding(next.urgency === "immediate" ? "conservative" : "permissive", "params",
      t.changed("urgency", String(old.urgency), String(next.urgency)))]),
    ...anyChange("notificationKind", old.notificationKind, next.notificationKind, "permissive", t.params.notificationKind),
    ...anyChange("titlePrefix", old.titlePrefix, next.titlePrefix, "conservative", t.params.titlePrefix),
  ],
  "events.merge_root_cause": () => [],
  "events.escalate_overdue": (old, next) => {
    const a = (old.ladder ?? {}) as Record<string, TriageLevel | undefined>;
    const b = (next.ladder ?? {}) as Record<string, TriageLevel | undefined>;
    const found: StandingOrderChangeFinding[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] === b[key]) continue;
      if (!(key in ATTENTION)) {
        found.push(finding("permissive", "params", t.params.notLevel(key)));
        continue;
      }
      const from = key as TriageLevel;
      const eventual = (target: TriageLevel | undefined) => target && triageLevelRank(target) > triageLevelRank(from) ? target : from;
      found.push(finding(levelAtLeastAsConservative(eventual(b[key]), eventual(a[key])) ? "conservative" : "permissive", "params",
        t.params.ladder(key, b[key], a[key])));
    }
    return found;
  },
  "events.digest_batch": (old, next) => [
    ...(old.maxWaitMs === next.maxWaitMs ? [] : [finding(Number(next.maxWaitMs) < Number(old.maxWaitMs) ? "conservative" : "permissive", "params",
      t.changed(t.param("maxWaitMs", t.params.maxWait), String(old.maxWaitMs), String(next.maxWaitMs)))]),
    ...booleanParam("onUserReturn", old.onUserReturn, next.onUserReturn, true, t.params.onUserReturn),
  ],
  // 来源阈值看的是整份清单（thresholdFindings）。
  "source.threshold": () => [],
  // Jev 分诊的开关（工单 09）：给更多事件类型打开，就是让 Jev 自动定更多事件的级别，更放开；关掉一部分更保守。
  // 别的参数（例如以后的置信度门槛）改了按「无法判断」处理。
  "triage.jev": (old, next) => {
    const before = new Set(Array.isArray(old.enabledKinds) ? old.enabledKinds.map(String) : []);
    const after = new Set(Array.isArray(next.enabledKinds) ? next.enabledKinds.map(String) : []);
    const added = [...after].filter((kind) => !before.has(kind));
    const removed = [...before].filter((kind) => !after.has(kind));
    const { enabledKinds: _a, ...oldRest } = old;
    const { enabledKinds: _b, ...nextRest } = next;
    return [
      ...(added.length ? [finding("permissive", "params", t.params.jevOn(t.list(added)))] : []),
      ...(removed.length ? [finding("conservative", "params", t.params.jevOff(t.list(removed)))] : []),
      ...anyChange("triage.jev", oldRest, nextRest, "permissive", t.params.jevOther),
    ];
  },
  // 通道的投递（工单 11）：会话卡、摘要两档放宽更保守；推送这一档两个方向都更放开（见 deliveryCondition）。
  "channel.delivery": (old, next) => [
    ...anyChange("source", old.source, next.source, "permissive", t.params.sourceChanged),
    ...deliveryCondition("pushWhen", old.pushWhen, next.pushWhen, t.delivery.push, true),
    ...deliveryCondition("cardWhen", old.cardWhen, next.cardWhen, t.delivery.card, false),
    ...deliveryCondition("digestWhen", old.digestWhen, next.digestWhen, t.delivery.digest, false),
  ],
  // 代你行动的闸门（工单 11）：开放更多类别、信任更多发信人、放低门槛、缩短撤回窗口都是更放开，要用户批准。
  "channel.delegate": (old, next) => [
    ...anyChange("source", old.source, next.source, "permissive", t.params.sourceChanged),
    ...setParam("openCategories", old.openCategories, next.openCategories,
      (value) => t.labeled(DELEGATION_CATEGORY_LABELS[value as DelegationCategory], value), t.set.verbs.autoReply),
    ...setParam("allowedTrust", old.allowedTrust, next.allowedTrust,
      (value) => t.labeled(SENDER_TRUST_LABELS[value as SenderTrust], value), t.set.verbs.reply),
    ...numberParam("minConfidence", old.minConfidence, next.minConfidence, "higher", t.params.minConfidence),
    ...numberParam("maxSensitivity", old.maxSensitivity, next.maxSensitivity, "lower", t.params.maxSensitivity),
    ...numberParam("revokeWindowMs", old.revokeWindowMs, next.revokeWindowMs, "higher", t.params.revokeWindow),
    ...numberParam("shadowMinSamples", old.shadowMinSamples, next.shadowMinSamples, "higher", t.params.shadowMinSamples),
    ...numberParam("shadowMinAgreement", old.shadowMinAgreement, next.shadowMinAgreement, "higher", t.params.shadowMinAgreement),
  ],
  // 代查闸门（代查与按信心代回 spec D2）：开更多剧本、代查更多发信人、降门槛、加配额、放长时限、多查仓库都是更放开，
  // 要用户批准；反方向（收紧）Lead 可以直接改。
  "channel.lookup": (old, next) => [
    ...anyChange("source", old.source, next.source, "permissive", t.params.sourceChanged),
    ...setParam("playbooks", old.playbooks, next.playbooks, playbookText, t.set.verbs.lookup),
    ...setParam("allowedTrust", old.allowedTrust, next.allowedTrust,
      (value) => t.labeled(SENDER_TRUST_LABELS[value as SenderTrust], value), t.set.verbs.lookup),
    ...numberParam("minAskConfidence", old.minAskConfidence, next.minAskConfidence, "higher", t.params.minAskConfidence),
    ...numberParam("maxSensitiveQuery", old.maxSensitiveQuery, next.maxSensitiveQuery, "lower", t.params.maxSensitiveQuery),
    ...numberParam("perRequesterDaily", old.perRequesterDaily, next.perRequesterDaily, "lower", t.params.perRequesterDaily),
    ...numberParam("dailyMax", old.dailyMax, next.dailyMax, "lower", t.params.dailyMax),
    ...numberParam("concurrent", old.concurrent, next.concurrent, "lower", t.params.concurrent),
    ...numberParam("timeoutMs", old.timeoutMs, next.timeoutMs, "lower", t.params.timeout),
    ...numberParam("maxRepos", old.maxRepos, next.maxRepos, "lower", t.params.maxRepos),
  ],
  // 代回闸门（spec D2、D7）：打开 autoReply、降低信心门槛、减少校准要求、放宽敏感话题、放长结果的有效期、缩短撤回窗口
  // 都是更放开，要用户批准；反方向 Lead 可以直接改。
  "channel.reply": (old, next) => {
    const before = (old.autoReply ?? {}) as Record<string, unknown>;
    const after = (next.autoReply ?? {}) as Record<string, unknown>;
    const known = new Set<string>(LOOKUP_PLAYBOOKS);
    const unknownKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !known.has(key));
    return [
      ...anyChange("source", old.source, next.source, "permissive", t.params.sourceChanged),
      ...LOOKUP_PLAYBOOKS.flatMap((playbook) =>
        booleanParam(`autoReply.${playbook}`, before[playbook], after[playbook], false, t.params.playbookAutoReply(playbook))),
      ...unknownKeys.flatMap((key) => anyChange(`autoReply.${key}`, before[key], after[key], "permissive", t.params.unknownPlaybook)),
      ...numberParam("threshold", old.threshold, next.threshold, "higher", t.params.replyThreshold),
      ...numberParam("coldStartMin", old.coldStartMin, next.coldStartMin, "higher", t.params.coldStartMin),
      ...numberParam("calibrationMinSamples", old.calibrationMinSamples, next.calibrationMinSamples, "higher", t.params.calibrationMinSamples),
      ...numberParam("calibrationMinAgreement", old.calibrationMinAgreement, next.calibrationMinAgreement, "higher", t.params.calibrationMinAgreement),
      ...numberParam("maxSensitivity", old.maxSensitivity, next.maxSensitivity, "lower", t.params.maxSensitivity),
      ...numberParam("maxResultAgeMs", old.maxResultAgeMs, next.maxResultAgeMs, "lower", t.params.maxResultAge),
      ...numberParam("revokeWindowMs", old.revokeWindowMs, next.revokeWindowMs, "higher", t.params.revokeWindow),
    ];
  },
  // 授权表（落地计划 A5）：一个意图从问你、提醒你改成拒绝或替你做，或者降低代你回复的门槛，都是更放开，要用户批准；
  // 反方向 Lead 可以直接改。问你和提醒你都不替你发东西，互相改算收紧。门槛只在前后都是「替你做」时比较。
  "channel.authority": (old, next) => {
    const before = (old.intents ?? {}) as Record<string, { action?: unknown; minConfidence?: unknown } | undefined>;
    const after = (next.intents ?? {}) as Record<string, { action?: unknown; minConfidence?: unknown } | undefined>;
    const rank = (value: unknown) => CHANNEL_INTENT_PERMISSION_RANK[value as ChannelIntentPermission];
    return [
      ...anyChange("source", old.source, next.source, "permissive", t.params.sourceChanged),
      ...CHANNEL_INTENTS.flatMap((intent) => {
        const a = before[intent] ?? {};
        const b = after[intent] ?? {};
        const found: StandingOrderChangeFinding[] = [];
        if (a.action !== b.action) {
          const known = rank(a.action) !== undefined && rank(b.action) !== undefined;
          found.push(finding(known && rank(b.action)! <= rank(a.action)! ? "conservative" : "permissive", "params",
            t.params.intentAction(intent, t.params.permission(a.action), t.params.permission(b.action))));
        }
        if (a.action === "auto" && b.action === "auto") {
          found.push(...numberParam(`intents.${intent}.minConfidence`, a.minConfidence, b.minConfidence, "higher",
            t.params.intentThreshold(intent)));
        }
        return found;
      }),
      // 自动代你处理（2026-10-23）：打开更放开，关掉更保守。没写按开着。
      ...booleanParam("autoReply", old.autoReply ?? CHANNEL_AUTO_REPLY_DEFAULT, next.autoReply ?? CHANNEL_AUTO_REPLY_DEFAULT, false, t.params.autoHandle),
      ...confidenceFindings(old.model, next.model),
    ];
  },
  "channel.handbook": (old, next) => handbookFindings(old, next),
  // 对话的熔断和静音（工单 #533）：静音让交给你和 Lead 的更少，所以更容易熔断（窗口更长、次数更少）、静音更久都是更放开；
  // 反方向 Lead 可以直接改。
  "channel.mute": (old, next) => [
    ...numberParam("breakerWindowMs", old.breakerWindowMs, next.breakerWindowMs, "lower", t.params.muteWindow),
    ...numberParam("breakerWakes", old.breakerWakes, next.breakerWakes, "higher", t.params.muteWakes),
    ...numberParam("breakerMuteMs", old.breakerMuteMs, next.breakerMuteMs, "lower", t.params.muteBreaker),
    ...numberParam("maxMuteMs", old.maxMuteMs, next.maxMuteMs, "lower", t.params.muteMax),
  ],
};

// 交接说明（channel.handbook，自动代你处理方案 B）。下面这些都更放开，要用户本人改；反方向 Lead 可以直接改：
//   - 一句的做法、例外的做法多发或者多做（handbookModeCovers），或者多了能力；
//   - 新加的一句比兜底的一句放开（不加这一句时，这类消息落到兜底）；删掉的一句比兜底严（删了以后它的消息落到兜底）；
//   - 对方的上限放开；打开总开关；
//   - 改了说法、例句或例外的说法：哪些消息落到这一句变了，无法判断。
// 只改段落不改变助手能做的事。
function handbookFindings(oldRaw: unknown, nextRaw: unknown): StandingOrderChangeFinding[] {
  if (!Value.Check(ChannelHandbookSchema, oldRaw) || !Value.Check(ChannelHandbookSchema, nextRaw)) {
    return anyChange("handbook", oldRaw, nextRaw, "permissive", t.handbook.badShape);
  }
  const old = oldRaw as ChannelHandbook;
  const next = nextRaw as ChannelHandbook;
  const before = new Map(old.situations.map((situation) => [situation.id, situation]));
  const after = new Map(next.situations.map((situation) => [situation.id, situation]));
  const modeFinding = (name: string, from: HandbookMode, to: HandbookMode, what: string): StandingOrderChangeFinding[] =>
    from === to ? [] : [finding(handbookModeCovers(from, to) ? "conservative" : "permissive", "params", t.handbook.modeChange(t.param(name, what), from, to))];
  const extraAbilities = (name: string, granted: readonly HandbookAbility[], wanted: readonly HandbookAbility[]) => {
    const extra = wanted.filter((ability) => !granted.includes(ability));
    return extra.length ? [finding("permissive", "params", t.handbook.abilities(name, extra))] : [];
  };
  // 和一句（或者兜底的一句）比：做法、例外、能力。
  const compare = (name: string, base: HandbookSituation, wanted: HandbookSituation): StandingOrderChangeFinding[] => [
    ...modeFinding(name, base.mode, wanted.mode, t.handbook.mode),
    ...(wanted.exception ? modeFinding(`${name}.exception`, base.exception?.mode ?? base.mode, wanted.exception.mode, t.handbook.exceptionMode) : []),
    ...extraAbilities(name, base.abilities, wanted.abilities),
  ];
  const fallbackBefore = before.get(HANDBOOK_FALLBACK_ID);
  const fallbackAfter = after.get(HANDBOOK_FALLBACK_ID);
  const found: StandingOrderChangeFinding[] = [];
  for (const situation of next.situations) {
    const name = `situations.${situation.id}`;
    const prior = before.get(situation.id);
    if (!prior) {
      found.push(finding("conservative", "params", t.handbook.added(situation.text)));
      if (fallbackBefore) found.push(...compare(name, fallbackBefore, situation));
      continue;
    }
    found.push(...compare(name, prior, situation));
    if (prior.text !== situation.text || prior.example !== situation.example || prior.exception?.text !== situation.exception?.text) {
      found.push(finding("permissive", "params", t.handbook.wording(name)));
    }
    if (prior.section !== situation.section) found.push(finding("conservative", "params", t.handbook.section(name)));
    if (prior.does !== situation.does || prior.autoPhrase !== situation.autoPhrase) {
      found.push(finding("conservative", "params", t.handbook.does(name)));
    }
  }
  for (const situation of old.situations) {
    if (after.has(situation.id) || !fallbackAfter) continue;
    found.push(finding("conservative", "params", t.handbook.removed(situation.text)));
    found.push(...compare(t.handbook.removedName(situation.id), situation, fallbackAfter));
  }
  if (stableJson(old.situations.map((situation) => situation.id)) !== stableJson(next.situations.map((situation) => situation.id))
    && !found.length) {
    found.push(finding("conservative", "params", t.handbook.reordered));
  }
  for (const sender of HANDBOOK_CAP_SENDERS) found.push(...modeFinding(`caps.${sender}`, old.caps[sender], next.caps[sender], t.handbook.cap));
  found.push(...booleanParam("autoReply", old.autoReply, next.autoReply, false, t.params.autoHandle));
  return found;
}

// 信心模型的参数（channel.authority 的 model，2026-10-23）。没写按缺省。门槛、指数、冷启动加档调高更保守；
// 话题和草稿的加档线调低更保守（更早加档）；「核实」「有据」「理解」的最低倍数调低更保守（扣得更多）；
// 不打扰线调高是更多消息只记录，按放开算；底线从硬拦改成加权更放开；校准的先验无法判断。
function confidenceFindings(oldRaw: unknown, nextRaw: unknown): StandingOrderChangeFinding[] {
  const old = (oldRaw ?? CHANNEL_CONFIDENCE_DEFAULTS) as ChannelConfidenceParams;
  const next = (nextRaw ?? CHANNEL_CONFIDENCE_DEFAULTS) as ChannelConfidenceParams;
  return [
    ...[0, 1, 2, 3].flatMap((index) =>
      numberParam(`model.tiers[${index}]`, old.tiers?.[index], next.tiers?.[index], "higher", t.confidence.tier(index + 1))),
    ...numberParam("model.noReplyBelow", old.noReplyBelow, next.noReplyBelow, "lower", t.confidence.noReplyBelow),
    ...numberParam("model.weights.needs_reply", old.weights?.needs_reply, next.weights?.needs_reply, "higher", t.confidence.needsReply),
    ...numberParam("model.weights.fulfills", old.weights?.fulfills, next.weights?.fulfills, "higher", t.confidence.fulfills),
    ...anyChange("model.priorStrength", old.priorStrength, next.priorStrength, "permissive", t.confidence.prior),
    ...numberParam("model.coldStartTiers", old.coldStartTiers, next.coldStartTiers, "higher", t.confidence.coldStartTiers),
    ...(old.lockMode === next.lockMode ? [] : [finding(next.lockMode === "hard" ? "conservative" : "permissive", "params",
      t.changed(t.param("model.lockMode", t.confidence.lockMode), String(old.lockMode), String(next.lockMode)))]),
    ...numberParam("model.tuning.topicStep", old.tuning?.topicStep, next.tuning?.topicStep, "lower", t.confidence.topicStep),
    ...numberParam("model.tuning.draftRiskStep", old.tuning?.draftRiskStep, next.tuning?.draftRiskStep, "lower", t.confidence.draftRiskStep),
    ...numberParam("model.tuning.verifiedFloor", old.tuning?.verifiedFloor, next.tuning?.verifiedFloor, "lower", t.confidence.verifiedFloor),
    ...numberParam("model.tuning.groundedFloor", old.tuning?.groundedFloor, next.tuning?.groundedFloor, "lower", t.confidence.groundedFloor),
    ...numberParam("model.tuning.understoodFloor", old.tuning?.understoodFloor, next.tuning?.understoodFloor, "lower", t.confidence.understoodFloor),
  ];
}

function playbookText(value: string): string {
  return t.labeled(LOOKUP_PLAYBOOK_LABELS[value as LookupPlaybook], value);
}

function ruleFindings(input: StandingOrderChangeInput, ladder: Readonly<Record<string, TriageLevel>>): StandingOrderChangeFinding[] {
  const { before, after } = input;
  if (after.action.type !== "rule") {
    // 定级别的指令不用 limits。
    return limitFindings(null, before, after);
  }
  const rule = after.action.rule;
  const found: StandingOrderChangeFinding[] = [];
  if (before?.action.type === "rule") {
    if (before.status === "disabled" && after.status === "active") {
      found.push(finding("permissive", "status", t.rules.enableDisabled));
    }
    found.push(...RULE_PARAM_CHECKS[rule](before.action.params, after.action.params, ladder));
  }
  found.push(...limitFindings(rule, before, after));
  const hasLevel = standingOrderLevel(after) !== null || (before !== null && standingOrderLevel(before) !== null);
  if (!before || hasLevel || rule === "source.threshold") return found;
  // 按根因合并用条件决定合并哪些事件：条件收窄就合并得少。
  const mergeCondition = rule === "events.merge_root_cause";
  if (mergeCondition && stableJson(before.condition) !== stableJson(after.condition)) {
    found.push(conditionImplies(after.condition, before.condition)
      ? finding("conservative", "condition", t.rules.mergeNarrower)
      : finding("permissive", "condition", t.rules.mergeWider));
  }
  // 不定级别的规则不用 priority、escalateTo，除了按根因合并以外也不用 condition。
  for (const [aspect, old, next] of [
    ["condition", mergeCondition ? null : before.condition, mergeCondition ? null : after.condition],
    ["priority", before.priority, after.priority], ["escalate_to", before.escalateTo, after.escalateTo],
  ] as const) {
    if (stableJson(old) !== stableJson(next)) found.push(finding("permissive", aspect, t.rules.noEffect(aspect, rule)));
  }
  return found;
}

function thresholdFindings(input: StandingOrderChangeInput, ladder: Readonly<Record<string, TriageLevel>>): StandingOrderChangeFinding[] {
  const { active, before, after } = input;
  const changed = [before, after].filter(isThreshold);
  if (!changed.length) return [];
  const sources = [...new Set(changed.map((order) => thresholdParams(order).source))];
  const listAfter = withChange(active, after);
  const found: StandingOrderChangeFinding[] = [];
  for (const source of sources) {
    const name = source === "*" ? t.threshold.fallbackSource : t.threshold.source(source);
    const old = pickThreshold(active, source);
    const next = pickThreshold(listAfter, source);
    if (!old || !next) {
      found.push(finding("permissive", "params", t.threshold.missing(name)));
      continue;
    }
    const oldParams = thresholdParams(old);
    const nextParams = thresholdParams(next);
    const a = outcome(oldParams.defaultLevel, old.escalateTo, ladder);
    const b = outcome(nextParams.defaultLevel, next.escalateTo, ladder);
    if (!sameOutcome(a, b)) {
      found.push(finding(outcomeAtLeastAsConservative(b, a) ? "conservative" : "permissive", "params",
        t.threshold.defaultLevel(name, outcomeText(a), outcomeText(b))));
    }
    if (oldParams.maxLevel !== nextParams.maxLevel) {
      found.push(finding(levelAtLeastAsConservative(nextParams.maxLevel, oldParams.maxLevel) ? "conservative" : "permissive", "params",
        t.threshold.maxLevel(name, oldParams.maxLevel, nextParams.maxLevel)));
    }
  }
  return found;
}

// ── 升到 interrupt：一律要用户批准（见文件头） ──────────────────────────────────

const reachesInterrupt = (o: Outcome | null) => o !== null && (o.level === "interrupt" || o.eventual === "interrupt");

function interruptFindings(input: StandingOrderChangeInput, ladder: Readonly<Record<string, TriageLevel>>): StandingOrderChangeFinding[] {
  const { active, before, after } = input;
  const found: StandingOrderChangeFinding[] = [];
  const raise = (detail: string) => found.push(finding("permissive", "interrupt", t.interrupt.raise(detail)));
  // 定级别的指令：新状态让事件到 interrupt（一开始或到时限），旧状态没有；或者已经是 interrupt，又可能多接手事件。
  const levelBefore = before && before.status === "active" ? standingOrderLevel(before) : null;
  const levelAfter = after.status === "active" ? standingOrderLevel(after) : null;
  const outBefore = levelBefore ? outcome(levelBefore, before!.escalateTo, ladder) : null;
  const outAfter = levelAfter ? outcome(levelAfter, after.escalateTo, ladder) : null;
  if (reachesInterrupt(outAfter)) {
    if (!reachesInterrupt(outBefore)) {
      raise(t.interrupt.matching(outcomeText(outAfter!)));
    } else if (!conditionImplies(after.condition, before!.condition) || sortsBefore(after, before!)) {
      raise(t.interrupt.more);
    }
  }
  // 来源阈值：打断上限或默认级别（含到时限升到的级别）升到 interrupt。
  const thresholds = [before, after].filter(isThreshold);
  const listAfter = withChange(active, after);
  for (const source of new Set(thresholds.map((order) => thresholdParams(order).source))) {
    const old = pickThreshold(active, source);
    const next = pickThreshold(listAfter, source);
    if (!next) continue;
    const nextParams = thresholdParams(next);
    const oldParams = old ? thresholdParams(old) : null;
    if (nextParams.maxLevel === "interrupt" && oldParams?.maxLevel !== "interrupt") raise(t.interrupt.sourceCap(source));
    const nextDefault = outcome(nextParams.defaultLevel, next.escalateTo, ladder);
    const oldDefault = oldParams ? outcome(oldParams.defaultLevel, old!.escalateTo, ladder) : null;
    if (reachesInterrupt(nextDefault) && !reachesInterrupt(oldDefault)) raise(t.interrupt.sourceDefault(source, outcomeText(nextDefault)));
  }
  // 到时限升级的 ladder：新增升到 interrupt 的一级。
  if (after.action.type === "rule" && after.action.rule === "events.escalate_overdue") {
    const oldLadder = (before?.action.type === "rule" ? (before.action.params as { ladder?: Record<string, unknown> }).ladder : undefined) ?? {};
    const newLadder = ((after.action.params as { ladder?: Record<string, unknown> }).ladder) ?? {};
    for (const [from, to] of Object.entries(newLadder)) {
      if (to === "interrupt" && oldLadder[from] !== "interrupt") raise(t.interrupt.ladder(from));
    }
  }
  return found;
}

// 影响行为的部分（不含标题和原因）。
function behaviourKey(order: StandingOrderState): string {
  return stableJson({
    priority: order.priority, condition: order.condition, action: order.action, limits: order.limits,
    escalateTo: order.escalateTo, status: order.status,
  });
}

const TIER_ORDER: Record<StandingOrderChangeTier, number> = { conservative: 0, permissive: 1, forbidden: 2 };

/**
 * 判断一次修改的档位。纯函数：只看传进来的指令。
 * 有硬性规则的问题时只返回这些问题（forbidden）。其余按最差的一项定档：有一项更放开就是更放开。
 * 内容变了却没有一项能判断时，按更放开处理。
 */
export function classifyStandingOrderChange(input: StandingOrderChangeInput): StandingOrderChangeClassification {
  const previous = t;
  t = standingOrderChangeText(input.locale ?? DEFAULT_LOCALE);
  try {
    return classify(input);
  } finally {
    t = previous;
  }
}

function classify(input: StandingOrderChangeInput): StandingOrderChangeClassification {
  const { before, after } = input;
  const behaviourChanged = !before || behaviourKey(before) !== behaviourKey(after);
  const titleChanged = Boolean(before && before.title !== after.title);
  if (!behaviourChanged && !titleChanged) return { tier: "conservative", changed: false, findings: [] };
  const hard = hardRuleFindings(input);
  if (hard.length) return { tier: "forbidden", changed: true, findings: hard };
  const ladder = escalationLadder(input.active);
  const findings = behaviourChanged
    ? [
      ...levelFindings(input, ladder), ...ruleFindings(input, ladder), ...thresholdFindings(input, ladder),
      // 单独的一条：让事件升到 interrupt 的修改一律更放开（见文件头）。
      ...interruptFindings(input, ladder),
    ]
    : [];
  if (titleChanged) findings.push(finding("conservative", "title", t.title(before!.title, after.title)));
  if (!findings.length) findings.push(finding("permissive", "unknown", t.unknown));
  const tier = findings.reduce<StandingOrderChangeTier>(
    (worst, item) => TIER_ORDER[item.tier] > TIER_ORDER[worst] ? item.tier : worst, "conservative");
  return { tier, changed: true, findings };
}

/** 键排好序的 JSON：比较两个条件或参数是否相同。 */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
