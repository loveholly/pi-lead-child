import type {
  KernelActiveExecution,
  KernelAttempt,
  KernelCheckpoint,
  KernelCheckpointV2,
  KernelTicketPow,
  KernelTicketProgress,
  KernelOutcomeSnapshotResource,
  KernelTicket,
  KernelTicketWorkbench,
  KernelTicketWorkbenchV2,
  KernelTicketWorkItem,
  KernelTicketWorkItemV2,
  KernelTicketTiming,
} from "@pi-lead-child/protocol";
import { toWireAttemptPurpose, toWireAttemptState } from "@pi-lead-child/core";
import { activeRun } from "@pi-lead-child/store";
import { listCheckpoints } from "@pi-lead-child/store";
import { listChildren } from "@pi-lead-child/store";
import type { Db } from "@pi-lead-child/store";
import { deliveryRunSql, latestDeliveryRunId } from "../pipeline/delivery-run.js";
import { verificationBoundaryRunId } from "./review-authority.js";
import { getItem, listItems } from "@pi-lead-child/store";
import { getItemTiming } from "@pi-lead-child/store";
import { countDistinctToolStartedForItem } from "@pi-lead-child/store";
import type { Run, Checkpoint, Item } from "@pi-lead-child/core";
import { presentUserFacingCheckpoint } from "@pi-lead-child/store";
import type { InterventionDomainService } from "./interventions.js";
import {
  countOutcomeSnapshots,
  getLatestOutcomeSnapshot,
  type OutcomeSnapshot,
} from "@pi-lead-child/store";

function iso(value: string | null): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}.000Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? normalized : date.toISOString();
}

// 派生，不落库（spec §11）：items 表多一列"有没有 Run"就是一份迟早会和 runs
// 表对不上的冗余，而对不上的那一刻没有任何东西会报错。EXISTS 走 runs(item_id) 索引，
// 便宜到不值得为它加缓存列。
//
// 判据是"曾经存在过 Run"而不是"现在有 Run 在跑"：跑完的任务照样要能回看 checkpoint 和产物。
export function itemHasRun(db: Db, itemId: number): boolean {
  return Boolean((db.prepare(
    "SELECT EXISTS(SELECT 1 FROM runs WHERE item_id = ?) AS present",
  ).get(itemId) as { present: number }).present);
}

function recordPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { raw };
  }
}

function stringArrayPayload(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

// ── 投影边界：内部 item/run → 线上 ticket/attempt ─────────────────────────────
// 本文件产出的每一个对象都是 packages/protocol 冻结的线上 DTO（Kernel*）。
// v16 起 DB 与内部代码讲 item / run / stage / finished / failed，线上仍讲
// ticket / attempt / status / settled / crashed——companion 有 95 处消费这些名字，
// test/kernel-protocol-contract.test.ts 按字节守着它们。
// 下面每一个 ticketId / attemptId / status / parentTicketId / settled 都是**有意的映射**，
// 不是漏改。任何一侧改动都必须同时改这里；要收敛只能等 protocol v3。

function kernelTicket(item: Item): KernelTicket {
  return {
    id: item.id,
    title: item.title,
    brief: item.brief,
    body: item.body,
    status: item.stage,
    priority: item.priority,
    project: item.project,
    projectId: item.project_id,
    parentTicketId: item.parent_item_id,
    rootTicketId: item.root_item_id,
    createdByAttemptId: item.created_by_run_id,
    orchestrationState: item.plan_state,
    requestedRuntime: item.requested_runtime,
    requestedModel: item.requested_model,
    purpose: item.purpose === null ? null : toWireAttemptPurpose(item.purpose),
    // 已停用，只为旧客户端照发 null（protocol 的 KernelTicketSchema，工单 09）。
    reviewPolicy: null,
    verificationPolicy: item.verification_policy,
    acceptancePolicy: item.acceptance_policy,
    reworkPolicy: item.rework_policy,
    deliveryPolicy: item.delivery_policy,
    maxDepth: item.max_depth,
    maxChildren: item.max_children,
    maxConcurrency: item.max_concurrency,
    tokenBudget: item.token_budget,
    costBudgetUsd: item.cost_budget_usd,
    retryLimit: item.retry_limit,
    activePlanRevision: item.active_plan_revision,
    workdir: item.workdir,
    createdBy: item.created_by,
    createdAt: iso(item.created_at) ?? item.created_at,
    updatedAt: iso(item.updated_at) ?? item.updated_at,
    lastActivityAt: iso(item.last_activity_at),
    totalTokens: item.total_tokens,
    totalCostUsd: item.total_cost_usd,
    dueAt: iso(item.due_at),
    remindAt: iso(item.remind_at),
  };
}

function kernelTicketV1(item: Item): KernelTicket {
  const {
    verificationPolicy,
    acceptancePolicy,
    reworkPolicy,
    deliveryPolicy,
    ...ticket
  } = kernelTicket(item);
  void verificationPolicy;
  void acceptancePolicy;
  void reworkPolicy;
  void deliveryPolicy;
  return ticket;
}

function kernelAttempt(run: Run): KernelAttempt {
  return {
    id: run.id,
    ticketId: run.item_id,
    role: run.role,
    state: toWireAttemptState(run.state),
    runtime: run.runtime,
    purpose: toWireAttemptPurpose(run.purpose),
    model: run.model,
    runtimeVersion: run.runtime_version,
    externalSessionId: run.external_session_id,
    sessionId: run.session_id,
    sessionPath: run.session_path,
    pid: run.pid,
    eventCursor: run.event_cursor,
    lastEntryCursor: run.last_entry_cursor,
    exitCode: run.exit_code,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    metadata: recordPayload(run.metadata),
    costKnown: Boolean(run.cost_known),
    eventLogDirty: Boolean(run.event_log_dirty),
    startedAt: iso(run.started_at) ?? run.started_at,
    endedAt: iso(run.ended_at),
  };
}

function activeExecution(run: Run | undefined): KernelActiveExecution | null {
  if (!run) return null;
  return {
    attemptId: run.id,
    role: run.role,
    runtime: run.runtime,
    state: toWireAttemptState(run.state),
    model: run.model,
    externalSessionId: run.external_session_id,
  };
}

function kernelCheckpoint(checkpoint: Checkpoint): KernelCheckpoint {
  const presented = presentUserFacingCheckpoint({
    kind: checkpoint.kind,
    title: checkpoint.title,
    summary: checkpoint.summary,
    nextStep: checkpoint.nextStep,
  });
  const base = {
    id: checkpoint.id,
    ticketId: checkpoint.itemId,
    attemptId: checkpoint.runId,
    author: checkpoint.author,
    source: checkpoint.source,
    stage: checkpoint.stage,
    title: presented.title,
    summary: presented.summary,
    keyFacts: checkpoint.keyFacts,
    artifactRefs: checkpoint.artifactRefs,
    createdAt: checkpoint.createdAt,
  };
  if (checkpoint.kind === "delegation") {
    if (!checkpoint.relatedItemIds.length) {
      throw new Error(`delegation checkpoint ${checkpoint.id} has no related item`);
    }
    return {
      ...base,
      kind: "delegation",
      relatedTicketIds: checkpoint.relatedItemIds,
      nextStep: presented.nextStep,
      actionRef: checkpoint.actionRef,
    };
  }
  if (checkpoint.kind === "blocked") {
    if (presented.nextStep !== null) {
      return {
        ...base,
        kind: "blocked",
        relatedTicketIds: checkpoint.relatedItemIds,
        nextStep: presented.nextStep,
        actionRef: checkpoint.actionRef,
      };
    }
    if (checkpoint.actionRef !== null) {
      return {
        ...base,
        kind: "blocked",
        relatedTicketIds: checkpoint.relatedItemIds,
        nextStep: null,
        actionRef: checkpoint.actionRef,
      };
    }
    throw new Error(`blocked checkpoint ${checkpoint.id} has no unblock path`);
  }
  return {
    ...base,
    kind: checkpoint.kind,
    relatedTicketIds: checkpoint.relatedItemIds,
    nextStep: presented.nextStep,
    actionRef: checkpoint.actionRef,
  };
}

function kernelCheckpointV2(checkpoint: Checkpoint): KernelCheckpointV2 {
  return {
    ...kernelCheckpoint(checkpoint),
    progress: checkpoint.progress,
    proofItems: checkpoint.proofItems,
  };
}

function kernelOutcomeSnapshot(snapshot: OutcomeSnapshot): KernelOutcomeSnapshotResource["latest"] {
  return {
    id: snapshot.id,
    ticketId: snapshot.itemId,
    executorAttemptId: snapshot.executorRunId,
    completionCheckpointId: snapshot.completionCheckpointId,
    source: snapshot.source,
    sourceEventSeq: snapshot.sourceEventSeq,
    sourceOutputSha256: snapshot.sourceOutputSha256,
    summary: snapshot.summary,
    changes: snapshot.changes,
    deliverables: snapshot.deliverables,
    validations: snapshot.validations,
    completeness: snapshot.completeness,
    missingFields: snapshot.missingFields,
    recoveryNote: snapshot.recoveryNote,
    createdAt: iso(snapshot.createdAt) ?? snapshot.createdAt,
  };
}


function latestReviewVerdictAfter(
  db: Db,
  itemId: number,
  executorRunId: number | null,
): KernelOutcomeSnapshotResource["reviewerVerdict"] {
  const row = db.prepare(
    `SELECT run_id, verdict, evidence, evidence_refs
     FROM review_verdicts
     WHERE item_id=?
     ORDER BY run_id DESC LIMIT 1`,
  ).get(itemId) as {
    run_id: number;
    verdict: "pass" | "fail";
    evidence: string;
    evidence_refs?: string;
  } | undefined;
  if (!row) return null;
  if (executorRunId !== null && row.run_id <= executorRunId) return null;
  return {
    verdict: row.verdict,
    attemptId: row.run_id,
    evidence: row.evidence,
    evidenceRefs: stringArrayPayload(row.evidence_refs ?? "[]"),
  };
}

function acceptanceFact(db: Db, item: Item): KernelOutcomeSnapshotResource["facts"]["acceptance"] {
  // Acceptance describes the current outcome, not an old review→done event.
  // Once a done item is reopened for rework, the previous acceptance must not
  // remain visible while the new outcome is awaiting review.
  if (item.stage !== "done") return "none";
  // Lead 在你这一轮里代你验收（工单操作层）：actor 是 lead，onBehalfOf 是 user。决定仍是你的。
  const row = db.prepare(
    `SELECT actor, json_extract(payload, '$.onBehalfOf') AS on_behalf_of FROM activities
     WHERE item_id=? AND kind='transition'
       AND json_extract(payload, '$.from')='review'
       AND json_extract(payload, '$.to')='done'
     ORDER BY id DESC LIMIT 1`,
  ).get(item.id) as { actor: string; on_behalf_of: string | null } | undefined;
  if (row?.actor === "user" || row?.on_behalf_of === "user") return "user";
  if (row?.actor === "system") return "automatic";
  return "none";
}

function outcomeSnapshotResource(db: Db, item: Item): KernelOutcomeSnapshotResource {
  const latest = getLatestOutcomeSnapshot(db, item.id);
  const executorRunId = latest?.executorRunId ?? latestDeliveryRunId(db, item.id);
  const reviewerVerdict = latestReviewVerdictAfter(db, item.id, executorRunId);
  const independentEvidence = !reviewerVerdict
    ? "missing"
    : reviewerVerdict.evidenceRefs.length > 0
      ? "complete"
      : "partial";
  return {
    latest: latest ? kernelOutcomeSnapshot(latest) : null,
    historyCount: countOutcomeSnapshots(db, item.id),
    facts: {
      implementationCompleted: latest !== undefined,
      independentEvidence,
      acceptance: acceptanceFact(db, item),
    },
    reviewerVerdict,
  };
}

export function projectItemProgress(db: Db, item: Item): KernelTicketProgress | null {
  if (item.stage === "cancelled") return null;
  if (item.stage === "done") {
    return {
      current: 1,
      total: 1,
      percent: 100,
      label: null,
      source: "terminal",
      checkpointId: null,
    };
  }
  const explicit = db.prepare(
    `SELECT id, progress_current, progress_total, progress_label
     FROM checkpoints
     WHERE item_id=? AND progress_current IS NOT NULL AND progress_total IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  ).get(item.id) as {
    id: number;
    progress_current: number;
    progress_total: number;
    progress_label: string | null;
  } | undefined;
  if (explicit) {
    return {
      current: explicit.progress_current,
      total: explicit.progress_total,
      percent: Math.round(explicit.progress_current * 100 / explicit.progress_total),
      label: explicit.progress_label,
      source: "explicit",
      checkpointId: explicit.id,
    };
  }
  const children = listChildren(db, item.id).filter((child) => child.stage !== "cancelled");
  if (children.length === 0) return null;
  const current = children.filter((child) => child.stage === "done").length;
  return {
    current,
    total: children.length,
    percent: Math.round(current * 100 / children.length),
    label: "子任务",
    source: "children",
    checkpointId: null,
  };
}

function latestPassingReviewCheckpoint(db: Db, itemId: number): { runId: number; checkpointId: number | null } | null {
  // 对话 Run 和修复回合不会让核查结论过期（delivery-run.ts），除非对话改过工作区（review-currency.ts）。
  const latestExecutor = { run_id: verificationBoundaryRunId(db, itemId) };
  const pass = db.prepare(
    `SELECT MAX(run_id) AS run_id FROM review_verdicts
     WHERE item_id=? AND verdict='pass'
       AND (? IS NULL OR run_id > ?)`,
  ).get(itemId, latestExecutor.run_id, latestExecutor.run_id) as { run_id: number | null };
  if (pass.run_id === null) return null;
  const checkpoint = db.prepare(
    "SELECT MAX(id) AS checkpoint_id FROM checkpoints WHERE item_id=? AND run_id=?",
  ).get(itemId, pass.run_id) as { checkpoint_id: number | null };
  return { runId: pass.run_id, checkpointId: checkpoint.checkpoint_id };
}

// 当前有效的 PASS 之后，未通过的条目只在它写于通过的那条核查记录之后时才算数：
//   · 更早的条目描述的是已经被核查覆盖的那份成果；
//   · 通过的 reviewer 在自己那条记录里留下的未通过项，是它看过并接受的保留意见。
// 以前还用一条正则把文字像"环境问题"（EPERM 等）的失败项藏起来，等于相信 agent 自己的解释；
// 现在只看谁、在什么时候写下的，不看文字（工单 #66 复核 F7）。
function activeProofRowsAfterReviewPass<T extends { state: string; checkpoint_id: number }>(
  rows: T[],
  pass: { checkpointId: number | null } | null,
): T[] {
  if (!pass) return rows;
  return rows.filter((row) => row.state === "passed"
    || pass.checkpointId === null
    || row.checkpoint_id > pass.checkpointId);
}

export function projectItemPow(
  db: Db,
  item: Item,
  timing: KernelTicketTiming,
  interventions: ReturnType<InterventionDomainService["listInterventionRefs"]>,
  now: Date,
): KernelTicketPow {
  // item_proof_items 是 checkpoints.proof_items 的物化表：每一行都指向写下它的 checkpoint，
  // checkpoint 带着 run_id。所以"这一项是哪次 Run 报的"用 JOIN 就能得到，不需要再存一份。
  // 条目属于哪一次交付（工单 #66 release review 4）：交付 Run 报的就是它自己；reviewer、
  // 工单对话和修复回合报的，属于它们之前最近的那次交付。规则与 delivery-run.ts 同源。
  const rows = db.prepare(
    `SELECT p.proof_key, p.label, p.state, p.evidence, p.checkpoint_id, p.updated_at, c.run_id,
            CASE
              WHEN r.id IS NULL THEN NULL
              WHEN ${deliveryRunSql("r")} THEN r.id
              ELSE (SELECT MAX(d.id) FROM runs d WHERE d.item_id = r.item_id AND d.id < r.id AND ${deliveryRunSql("d")})
            END AS delivery_run_id
     FROM item_proof_items p
     LEFT JOIN checkpoints c ON c.id = p.checkpoint_id
     LEFT JOIN runs r ON r.id = c.run_id
     WHERE p.item_id=?
     ORDER BY p.checkpoint_id, p.proof_key`,
  ).all(item.id) as Array<{
    proof_key: string;
    label: string;
    state: "pending" | "passed" | "failed";
    evidence: string | null;
    checkpoint_id: number;
    updated_at: string;
    run_id: number | null;
    delivery_run_id: number | null;
  }>;
  const items = activeProofRowsAfterReviewPass(rows, latestPassingReviewCheckpoint(db, item.id)).map((row) => ({
    id: row.proof_key,
    label: row.label,
    state: row.state,
    evidence: row.evidence,
    checkpointId: row.checkpoint_id,
    attemptId: row.run_id,
    deliveryAttemptId: row.delivery_run_id,
    updatedAt: iso(row.updated_at) ?? row.updated_at,
  }));
  const passed = items.filter((item) => item.state === "passed").length;
  const pendingInterventionCount = interventions.filter((item) => item.state === "pending").length;
  const attention = item.stage === "blocked"
    || pendingInterventionCount > 0
    || items.some((item) => item.state === "failed");
  const verdict: KernelTicketPow["verdict"] = items.length === 0
    ? "empty"
    : attention
      ? "attention"
      : passed === items.length
        ? "passed"
        : "running";
  const checkpointCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM checkpoints WHERE item_id=?",
  ).get(item.id) as { n: number }).n;
  return {
    verdict,
    items,
    metrics: {
      passed,
      total: items.length,
      checkpointCount,
      toolOperationCount: countDistinctToolStartedForItem(db, item.id),
      elapsedMs: timing.elapsedMs,
      pendingInterventionCount,
    },
    deliveryAttemptId: latestDeliveryRunId(db, item.id),
    computedAt: now.toISOString(),
  };
}

export interface WorkbenchDomainService {
  getTicketWorkbench(itemId: number): KernelTicketWorkbench | undefined;
  getTicketWorkbenchV2(itemId: number): KernelTicketWorkbenchV2 | undefined;
  listTicketWorkItems(query?: { itemIds?: number[] }): KernelTicketWorkItem[];
  listTicketWorkItemsV2(query?: { itemIds?: number[] }): KernelTicketWorkItemV2[];
  listTicketCheckpointsV2(
    ticketId: number,
    query?: { beforeId?: number; afterId?: number; limit?: number },
  ): { items: KernelCheckpointV2[]; hasMore: boolean; nextBeforeId: number | null } | undefined;
}

export function createWorkbenchDomainService(args: {
  db: Db;
  interventions: InterventionDomainService;
  now?: () => Date;
}): WorkbenchDomainService {
  const { db, interventions } = args;
  const now = args.now ?? (() => new Date());

  const workItem = (item: Item): KernelTicketWorkItem => {
    const run = activeRun(db, item.id);
    const latestCheckpoint = db.prepare(
      "SELECT id FROM checkpoints WHERE item_id=? ORDER BY id DESC LIMIT 1",
    ).get(item.id) as { id: number } | undefined;
    return {
      ticketId: item.id,
      // 没有 Run 就整个不投 timing（spec §11）。展开语法而不是投 undefined：
      // JSON.stringify 会把 undefined 的键丢掉，但 `'timing' in obj` 仍为真，
      // 而下游有按 in / hasOwnProperty 判断的写法。
      ...(itemHasRun(db, item.id)
        ? { timing: getItemTiming(db, item.id, now()) }
        : {}),
      activeExecution: activeExecution(run),
      pendingInterventionCount: interventions.listInterventionRefs({
        itemId: item.id,
        state: "pending",
      }).length,
      latestCheckpointId: latestCheckpoint?.id ?? null,
    };
  };

  const workItemV2 = (item: Item): KernelTicketWorkItemV2 => ({
    ...workItem(item),
    progress: projectItemProgress(db, item),
  });

  return {
    getTicketWorkbench(itemId): KernelTicketWorkbench | undefined {
      const item = getItem(db, itemId);
      if (!item) return undefined;
      const run = activeRun(db, itemId);
      const hasRun = itemHasRun(db, itemId);
      return {
        ticket: kernelTicketV1(item),
        ...(hasRun ? { timing: getItemTiming(db, itemId, now()) } : {}),
        activeAttempt: run ? kernelAttempt(run) : null,
        children: listChildren(db, itemId).map(kernelTicketV1),
        ...(hasRun
          ? {
              latestCheckpoints: listCheckpoints(db, { itemId, limit: 50 })
                .items.map(kernelCheckpoint),
            }
          : {}),
        interventionRefs: interventions.listInterventionRefs({ itemId }),
      };
    },

    getTicketWorkbenchV2(itemId): KernelTicketWorkbenchV2 | undefined {
      const item = getItem(db, itemId);
      if (!item) return undefined;
      const at = now();
      const base = this.getTicketWorkbench(itemId)!;
      const interventionRefs = interventions.listInterventionRefs({ itemId });
      // pow 与 timing 同理：没有 Run 时 verdict 只会是 'empty'、metrics 全是 0，
      // 那不是"这件事的证据为空"，而是"这件事根本不产生证据"。两者要能区分。
      const hasRun = itemHasRun(db, itemId);
      const timing = hasRun ? getItemTiming(db, itemId, at) : undefined;
      return {
        ...base,
        ticket: kernelTicket(item),
        children: listChildren(db, itemId).map(kernelTicket),
        ...(timing ? { timing } : {}),
        interventionRefs,
        progress: projectItemProgress(db, item),
        ...(timing
          ? { pow: projectItemPow(db, item, timing, interventionRefs, at) }
          : {}),
        outcomeSnapshot: outcomeSnapshotResource(db, item),
      };
    },

    listTicketWorkItems(query): KernelTicketWorkItem[] {
      const ids = query?.itemIds ? new Set(query.itemIds) : null;
      return listItems(db).filter((item) => !ids || ids.has(item.id)).map(workItem);
    },

    listTicketWorkItemsV2(query): KernelTicketWorkItemV2[] {
      const ids = query?.itemIds ? new Set(query.itemIds) : null;
      return listItems(db).filter((item) => !ids || ids.has(item.id)).map(workItemV2);
    },

    listTicketCheckpointsV2(itemId, query) {
      if (!getItem(db, itemId)) return undefined;
      const page = listCheckpoints(db, { itemId, ...query });
      return { ...page, items: page.items.map(kernelCheckpointV2) };
    },
  };
}
