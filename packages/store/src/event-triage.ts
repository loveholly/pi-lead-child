// 分诊（Lead 事件主干 spec D3，工单 05）：事件写入时按常设指令定级别，和依据一起写进 events（level、triage）。
// 01 的默认分诊（defaultTriageLevel）已经搬成第一批常设指令（standing-order-seeds.ts）；搬之前和搬之后的对照测试在
// store/test/event-triage.test.ts。events.ts 的 appendEvent 在写入前调用 triageEvent，它在调用方的写事务里运行。
//
// 顺序（都是 0 token 的规则层）：
//   1. 用户自己发给 Lead 的消息：conversation，不分诊（events.ts 直接定）。写入方给了级别的，用写入方的。
//   2. 定级别的常设指令按 priority 取第一条匹配的；都不匹配时用来源的默认级别（source.*）。
//   3. 来源的打断阈值：级别不超过这个来源的 maxLevel（source.*）。
//   4. 硬性安全规则（写在代码里，不进表，spec D4）。常设指令改不了它们：
//      - approval_reaches_user：审批要在过期前送到用户。审批的事件至少是 tell，不按根因合并。
//      - external_never_interrupts：外部来源的事件永远不插进 Lead 正在进行的回合，最高 tell（spec D3、D6）。
//      常设指令定不出 conversation，也只能用白名单里的规则（packages/protocol 的 standing-orders.ts 校验）。
//   5. 按根因合并（events.merge_root_cause）：同一种事件、同一个 root_cause.code、级别相同、还没有处置的，
//      后来的记成 superseded，指向第一条。Lead 说一次。
// 去重（同一次投递只记一条）在 events.ts；去抖和熔断在 inbox.ts（参数来自常设指令），这里只记它们的依据。
//
// 这里不能抛 SQL 错误：appendEventGuarded 会让原来的写入一起回滚。读常设指令出错时退回代码里的种子，
// 合并的查询出错时不合并。
import {
  EVENT_SOURCES, capTriageLevel, matchesStandingOrderCondition, standingOrderLevel, triageLevelRank,
  type ConditionSubject, type EventDisposition, type EventEnvelope, type EventLevel, type StandingOrder,
  type TriageBasis, type TriageLevel,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { activeStandingOrders, ruleStandingOrder, sourceThreshold, standingOrderRef } from "./standing-orders.js";

/** 分诊的输入：appendEvent 补好了 occurredAt 和 payload 的信封。 */
export type TriageEnvelope = EventEnvelope & { occurredAt: string; payload: Record<string, unknown> };

/** 分诊的结果：级别和依据。规则直接处理掉的事件（按根因合并）同时带处置。 */
export interface TriageDecision {
  level: EventLevel;
  basis: TriageBasis | null;
  disposition?: EventDisposition;
  dispositionDetail?: Record<string, unknown>;
}

/** 可以替换的分诊（events.ts 的 setEventTriage，测试用）。返回级别或者完整的结果。 */
export type EventTriage = (envelope: TriageEnvelope) => EventLevel | TriageDecision;

export const HARD_TRIAGE_RULES = {
  approvalReachesUser: "approval_reaches_user",
  externalNeverInterrupts: "external_never_interrupts",
} as const;

const DEFAULT_MERGE_WINDOW_MS = 30 * 60_000;

/** 条件看的对象：信封的来源、类型、对象、payload 和根因。 */
export function eventConditionSubject(envelope: Pick<EventEnvelope, "source" | "kind" | "entityKey" | "payload" | "rootCause">): ConditionSubject {
  return {
    source: envelope.source, kind: envelope.kind, entityKey: envelope.entityKey,
    payload: envelope.payload ?? {}, rootCause: envelope.rootCause ?? null,
  };
}

export function isInternalEventSource(source: string): boolean {
  return (EVENT_SOURCES as readonly string[]).includes(source);
}

// 审批的 inbox 行（engine 的 interventions.ts 写 authorityType=approval）。
function isApprovalEvent(envelope: TriageEnvelope): boolean {
  if (!envelope.kind.startsWith("inbox.")) return false;
  const original = envelope.payload.payload;
  return Boolean(original && typeof original === "object" && (original as Record<string, unknown>).authorityType === "approval");
}

type Applied = NonNullable<TriageBasis["applied"]>;

// 按根因合并的目标：同一种事件、同一个根因码、级别相同、还没有处置、在时间窗里的最近一条。
// 合并进去的事件已经记成 superseded，所以找到的总是这一组的第一条。
// WHERE 里写全 events_undisposed 这个部分索引的条件，查询走那个索引，不扫这一类事件的全部历史。
function rootCauseMergeTarget(db: Db, envelope: TriageEnvelope, level: EventLevel, order: StandingOrder): number | null {
  const code = envelope.rootCause?.code;
  if (!code || level === "record" || level === "conversation") return null;
  if (!matchesStandingOrderCondition(order.condition, eventConditionSubject(envelope))) return null;
  const windowMs = order.limits?.windowMs ?? DEFAULT_MERGE_WINDOW_MS;
  try {
    const row = db.prepare(
      `SELECT seq FROM events
       WHERE disposition IS NULL AND level IS NOT NULL AND level <> 'record' AND received_at >= ?
         AND kind = ? AND level = ? AND json_valid(root_cause) AND json_extract(root_cause, '$.code') = ?
       ORDER BY seq DESC LIMIT 1`,
    ).get(new Date(Date.now() - windowMs).toISOString(), envelope.kind, level, code) as { seq: number } | undefined;
    return row?.seq ?? null;
  } catch {
    return null;
  }
}

/** 按常设指令给一个事件分诊。不抛错（见文件头）。 */
export function triageEvent(db: Db, envelope: TriageEnvelope): TriageDecision {
  if (envelope.source === "user") return { level: "conversation", basis: null };
  const subject = eventConditionSubject(envelope);
  const orders = activeStandingOrders(db);
  const threshold = sourceThreshold(db, envelope.source);
  const matched = orders.find((order) => standingOrderLevel(order) !== null
    && matchesStandingOrderCondition(order.condition, subject));
  const basisOrder = matched ?? threshold.order;
  let level: TriageLevel = matched ? standingOrderLevel(matched)! : threshold.defaultLevel;
  const applied: Applied = [];
  const hardRules: string[] = [];

  // inbox 的去抖和熔断在写 inbox 时就做了（inbox.ts），这里记下它们的依据。
  if (envelope.kind.startsWith("inbox.")) {
    if (envelope.payload.delivery === "merged") {
      applied.push({ ...standingOrderRef(ruleStandingOrder(db, "inbox.merge_attention")), effect: "inbox_merged" });
    } else if (envelope.payload.delivery === "folded" && basisOrder.id !== "inbox.fuse_blockers") {
      applied.push({ ...standingOrderRef(ruleStandingOrder(db, "inbox.fuse_blockers")), effect: "inbox_folded" });
    }
  }

  if (triageLevelRank(level) > triageLevelRank(threshold.maxLevel)) {
    applied.push({ ...standingOrderRef(threshold.order), effect: `capped_from_${level}` });
    level = threshold.maxLevel;
  }
  if (!isInternalEventSource(envelope.source) && triageLevelRank(level) > triageLevelRank("tell")) {
    level = capTriageLevel(level, "tell");
    hardRules.push(HARD_TRIAGE_RULES.externalNeverInterrupts);
  }
  const approval = isApprovalEvent(envelope);
  if (approval && triageLevelRank(level) < triageLevelRank("tell")) {
    level = "tell";
    hardRules.push(HARD_TRIAGE_RULES.approvalReachesUser);
  }

  const basis: TriageBasis = {
    order: standingOrderRef(basisOrder),
    ...(applied.length ? { applied } : {}),
    ...(hardRules.length ? { hardRules } : {}),
  };
  if (approval) return { level, basis };

  const mergeOrder = ruleStandingOrder(db, "events.merge_root_cause");
  const mergedInto = rootCauseMergeTarget(db, envelope, level, mergeOrder);
  if (mergedInto === null) return { level, basis };
  return {
    level,
    basis: {
      ...basis,
      applied: [...applied, { ...standingOrderRef(mergeOrder), effect: "merged_root_cause" }],
      mergedInto,
    },
    disposition: "superseded",
    dispositionDetail: {
      reason: "merged_root_cause",
      mergedInto,
      rootCauseCode: envelope.rootCause!.code,
      standingOrder: standingOrderRef(mergeOrder),
    },
  };
}
