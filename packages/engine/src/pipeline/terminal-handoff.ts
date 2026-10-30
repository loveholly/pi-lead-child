import type { Db } from "@pi-lead-child/store";
import { createCheckpointDomainService } from "../coordinator/checkpoints.js";
import { raiseBlocker, retractCheckpointBlockers } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { getRun, updateRun } from "@pi-lead-child/store";
import { runUpdatedEvent } from "@pi-lead-child/store";

export interface CriticalToolFailure {
  name: string;
  error: string;
}

const CRITICAL_HANDOFF_TOOLS = new Set([
  "ticket_update",
  "submit_checkpoint",
  "notify_lead",
  "request_approval",
  "request_decision",
  "review_verdict",
]);

export function criticalHandoffToolName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const normalized = name.includes("__")
    ? (name.split("__").at(-1) ?? name)
    : (name.split(".").at(-1) ?? name);
  return CRITICAL_HANDOFF_TOOLS.has(normalized) ? normalized : null;
}

function parseMetadata(serialized: string): Record<string, unknown> {
  try {
    const value = JSON.parse(serialized);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function failureSummary(runId: number, failure?: CriticalToolFailure | null): string {
  if (!failure) {
    return `Run #${runId} 已结束，但 child 未将工单推进到 Review，也没有完成终态交接。`;
  }
  return `Run #${runId} 已结束，但关键交接工具 ${failure.name} 调用失败：${failure.error.slice(0, 1_200)}`;
}

export function recordTerminalHandoffFailure(
  db: Db,
  args: {
    itemId: number;
    runId: number;
    at?: Date;
    criticalToolFailure?: CriticalToolFailure | null;
  },
): boolean {
  const at = args.at ?? new Date();
  const checkpointKey = `run-handoff-failed:${args.runId}`;
  return db.transaction(() => {
    const run = getRun(db, args.runId);
    const item = getItem(db, args.itemId);
    if (!run || run.item_id !== args.itemId || run.state !== "finished" || run.role !== "executor") {
      return false;
    }
    if (!item || item.stage !== "active" || ["waiting", "integrating"].includes(item.plan_state ?? "none")) {
      return false;
    }
    if (db.prepare("SELECT 1 FROM checkpoints WHERE idempotency_key=?").get(checkpointKey)) {
      return false;
    }

    const summary = failureSummary(args.runId, args.criticalToolFailure);
    const reason = args.criticalToolFailure
      ? `terminal handoff failed: ${args.criticalToolFailure.name}`
      : "run ended without terminal handoff";
    transition(db, {
      itemId: args.itemId,
      to: "blocked",
      actor: "system",
      reason,
      runId: args.runId,
      now: at,
    });
    updateRun(db, args.runId, {
      metadata: {
        ...parseMetadata(run.metadata),
        terminalHandoff: {
          state: "failed",
          detectedAt: at.toISOString(),
          ...(args.criticalToolFailure ? {
            tool: args.criticalToolFailure.name,
            error: args.criticalToolFailure.error,
          } : {}),
        },
      },
    });
    createCheckpointDomainService({ db, now: () => at }).recordSystemCheckpoint({
      itemId: args.itemId,
      runId: args.runId,
      kind: "blocked",
      title: "运行结束，交接失败",
      summary,
      nextStep: "检查本次运行结果，修复交接通道后重新提交状态与终态 Checkpoint，再进入 Review。",
      keyFacts: [
        { label: "Run", value: `#${args.runId}` },
        { label: "工单状态", value: "已从进行中转为阻塞" },
        ...(args.criticalToolFailure
          ? [{ label: "失败工具", value: args.criticalToolFailure.name }]
          : []),
      ],
      idempotencyKey: checkpointKey,
      leadVisible: true,
      precedingEvents: [runUpdatedEvent(args.itemId, args.runId, at)],
    });
    raiseBlocker(db, {
      // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
      needsUser: false,
      itemId: args.itemId,
      runId: args.runId,
      code: "terminal_handoff_failed",
      payloadKind: "terminal_handoff_failed",
      title: "运行结束，交接失败",
      summary,
      nextStep: "检查本次运行结果，修复交接通道后重新提交状态与终态 Checkpoint，再进入 Review。",
      source: "structural",
      dedupKey: checkpointKey,
      evidence: {
        runId: args.runId,
        ...(args.criticalToolFailure ? { failedTool: args.criticalToolFailure.name } : {}),
      },
      at,
    });
    return true;
  }).immediate();
}

/**
 * 撤回这个 Run 的「交接失败」blocker：inbox 行和通知。检查点保留，它是历史事实。
 * 只有成果修复回合（工单 09）调用它：成果补交以后，stage 也随之推进，交接失败不再成立。
 * 其他途径补上成果时工单仍然停在 blocked，撤回它会让 blocked 没有理由，所以它们不调用。
 */
export function retractTerminalHandoffBlocker(db: Db, runId: number): number {
  const key = `run-handoff-failed:${runId}`;
  const inbox = db.prepare(
    "DELETE FROM inbox WHERE severity='blocker' AND json_extract(payload, '$.blockerKey')=?",
  ).run(key).changes;
  const notifications = db.prepare("DELETE FROM notifications WHERE dedup_key=?").run(`blocker:${key}`).changes;
  // 启动时的补发可能为同一张检查点又升起一条 blocker。它也不再成立。
  return inbox + notifications + retractCheckpointBlockers(db, [key]);
}

// 修复回合（outcome_repair）不是执行 Run：它不需要终态交接，也不算工单最新的执行 Run。
export function repairTerminalHandoffFailures(db: Db, at = new Date()): number {
  const candidates = db.prepare(
    `SELECT r.id AS run_id, r.item_id
     FROM runs r
     JOIN items i ON i.id = r.item_id
     WHERE r.state = 'finished' AND r.role = 'executor' AND r.purpose <> 'outcome_repair' AND i.stage = 'active'
       AND COALESCE(i.plan_state, 'none') NOT IN ('waiting','integrating')
       AND r.id = (
         SELECT MAX(latest.id) FROM runs latest
         WHERE latest.item_id = r.item_id AND latest.role = 'executor' AND latest.purpose <> 'outcome_repair'
       )
     ORDER BY r.id`,
  ).all() as Array<{ run_id: number; item_id: number }>;
  let repaired = 0;
  for (const candidate of candidates) {
    if (recordTerminalHandoffFailure(db, {
      itemId: candidate.item_id,
      runId: candidate.run_id,
      at,
    })) repaired++;
  }
  return repaired;
}
