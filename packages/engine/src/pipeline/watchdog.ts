import type { Db } from "@pi-lead-child/store";
import {
  addActivity, addInbox, getItem, getRun, markRunFailed, raiseBlocker, runUpdatedEvent, transition,
} from "@pi-lead-child/store";
import { liveChildren } from "../children/manager.js";
import {
  loadCheckpointPolicyConfig,
  type CheckpointPolicyConfig,
  type Run,
  type RunPurpose,
} from "@pi-lead-child/core";
import { runtimeDisplayName, typedFailure } from "@pi-lead-child/runtime";
import { createDispatcher } from "../coordinator/dispatch.js";
import { createCoordinator } from "../coordinator/service.js";
import {
  checkpointReminderDue,
  readCheckpointPolicyState,
} from "../coordinator/checkpoint-policy.js";

const CHECKPOINT_REMINDER = [
  "You have completed meaningful work without a recent Checkpoint.",
  "If a phase conclusion now exists, call submit_checkpoint.",
  "If you are still in the same phase, continue without reporting.",
].join(" ");

interface WatchdogOptions {
  stallMs?: number;
  // 启动看门狗的阈值（startStallMs）。不给时读 PLC_START_STALL_MS，缺省 5 分钟。
  startStallMs?: number;
  // runtime 还没启动、还在准备工作区的 Run 等多久算挂死。不给时读 PLC_START_PREPARE_STALL_MS，缺省 45 分钟。
  prepareStallMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  checkpointPolicy?: CheckpointPolicyConfig;
  sendReminder?: (itemId: number, runId: number, message: string) => Promise<void> | void;
}

function addNotificationActivity(
  db: Db,
  input: { itemId: number; runId: number | null; payload: Record<string, unknown>; now: Date },
): void {
  db.prepare(
    `INSERT INTO activities
      (item_id, run_id, actor, kind, payload, created_at)
     VALUES (?, ?, 'system', 'notification', ?, ?)`,
  ).run(input.itemId, input.runId, JSON.stringify(input.payload), input.now.toISOString());
}

// ── 启动看门狗 ─────────────────────────────────────────────────────────────────
// 2026-10-29：Run #185 停在 starting、一条事件都没有，12 分钟没人处理，Lead 手动停掉重跑才好。
// 下面的 checkStalls 只看有活动的工单，15 分钟后发一条通知，也不处理它。
// Run 在 starting、没有任何事件、超过阈值时：
//   - 停掉它的 child，按可续跑的中断记下（run_interrupted：这次尝试被打断，不扣工单的重试额度）。
//   - 执行、核查和集成的 Run 自动重排一次：派发队列派出的，原来的请求回到队列（和租约过期一样，dispatch.ts 的
//     reclaimExpired）；直接启动的，排一条新的请求。
//   - 同一张工单上一个同类 Run 也是启动卡住的（连续两次）：不再重排，交给 Lead。工单对话不重排，交给 Lead 重发。
// 代查（lookup）的结果交回通道 hub，成果修复和学习有自己的收尾，这里不管它们。
export const START_STALLED = "start_stalled";
const START_STALL_PURPOSES: readonly RunPurpose[] = ["execution", "review", "integration", "conversation"];
const START_RETRY_PURPOSES: readonly RunPurpose[] = ["execution", "review", "integration"];

export function startStallMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.PLC_START_STALL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60_000;
}

function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.max(1, Math.round(ms / 1_000))} 秒`;
}

// 上一个同类 Run（同一张工单、同一个角色和用途）也是启动卡住的。没启动成的 Run（run_start_refused）不算一次尝试。
function previousAlsoStalled(db: Db, run: Run): boolean {
  const previous = db.prepare(
    `SELECT error_code FROM runs
     WHERE item_id=? AND role=? AND purpose=? AND id<? AND error_code IS NOT 'run_start_refused'
     ORDER BY id DESC LIMIT 1`,
  ).get(run.item_id, run.role, run.purpose, run.id) as { error_code: string | null } | undefined;
  return previous?.error_code === START_STALLED;
}

function stopStalledStart(db: Db, run: Run, input: { at: Date; stallMs: number }): boolean {
  const agent = runtimeDisplayName(run.runtime);
  const reason = `${agent} 的 Run #${run.id} 停在启动，超过 ${duration(input.stallMs)} 没有任何事件。`;
  const claim = db.prepare("SELECT request_id FROM dispatch_claims WHERE run_id=?").get(run.id) as
    { request_id: number } | undefined;
  const again = START_RETRY_PURPOSES.includes(run.purpose) && !previousAlsoStalled(db, run);
  const stopped = db.transaction((): boolean => {
    if (getRun(db, run.id)?.state !== "starting") return false;
    // 先落 failed 再停进程：之后进程退出时，manager 和 ingest 看到 Run 已经结束，不再记一次崩溃（lifecycle.ts 的同一条规则）。
    markRunFailed(db, run.id, {
      errorCode: START_STALLED, errorMessage: reason,
      failure: typedFailure("run_interrupted", { errorCode: START_STALLED, message: reason }),
    });
    // 活动里记着请求的 id：回到队列的请求不会被自己派出的这个 Run 作废（dispatch.ts 的 supersededRetry）。
    addActivity(db, {
      itemId: run.item_id, runId: run.id, actor: "system", kind: "crash",
      payload: {
        errorCode: START_STALLED, failureScope: "attempt", failureCode: "run_interrupted", reason,
        ...(claim ? { dispatchRequestId: claim.request_id } : {}),
      },
    });
    if (claim) {
      db.prepare("UPDATE dispatch_requests SET state=?, updated_at=datetime('now') WHERE id=?")
        .run(again ? "pending" : "failed", claim.request_id);
      db.prepare("DELETE FROM dispatch_claims WHERE run_id=?").run(run.id);
    } else if (again) {
      createDispatcher(db).request({
        itemId: run.item_id, role: run.role, purpose: run.purpose, runtime: run.runtime,
        ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}),
        ...(run.resumed_from_run_id !== null ? { resumeFromRunId: run.resumed_from_run_id } : {}),
        retryOfRunId: run.id,
        trigger: "start-stall-retry",
        idempotencyKey: `start-stall-retry:${run.id}`,
      });
    }
    const recover = (action: string) => `recover_ticket_run（ticket_id=${run.item_id}，run_id=${run.id}，action=${action}）`;
    createCoordinator({ db, now: () => input.at }).recordSystemCheckpoint({
      itemId: run.item_id,
      runId: run.id,
      kind: again || run.purpose === "conversation" ? "progress" : "blocked",
      title: "Run 启动卡住",
      summary: reason,
      nextStep: again
        ? "系统停掉了这个 Run，重新排了一次派发。不需要任何操作。这次中断不扣工单的重试额度。"
        : run.purpose === "conversation"
          ? "系统停掉了这个 Run。这条消息没有答上，需要重发。"
          : "这张工单连续两次启动卡住，系统停掉了 Run，不再自动重排。需要先查清 runtime 为什么起不来，再重跑。",
      keyFacts: [
        { label: "Agent", value: agent },
        { label: "Runtime", value: run.runtime },
        { label: "Model", value: run.model ?? "默认模型" },
      ],
      idempotencyKey: `run-crash:${run.id}`,
      // 自动重排时不打扰 Lead。交给 Lead 时，Lead 的说明是下面那一条。
      leadVisible: false,
      precedingEvents: [runUpdatedEvent(run.item_id, run.id)],
    });
    if (again) return true;
    if (run.purpose === "conversation") {
      // 工单对话没答上不是 blocker（ingest.ts 的同一条规则）：叫醒 Lead，让它重发。
      addInbox(db, {
        itemId: run.item_id,
        severity: "attention",
        source: "structural",
        summary: `工单 #${run.item_id} 的对话 Run #${run.id} 启动卡住，已经停下：${reason}`,
        payload: {
          kind: "conversation_run_failed", runId: run.id, errorCode: START_STALLED, wakeLead: true, needsUser: false,
          leadNextStep: `用 ${recover("retry")} 重发这条消息；runtime 一直起不来时换一个（action=switch_runtime）。`,
        },
      });
      return true;
    }
    // 连续两次：只给 Lead 的 blocker（和崩溃同一个键，daemon 重启时的补发认得它）。执行者的工单进 blocked。
    raiseBlocker(db, {
      needsUser: false,
      itemId: run.item_id,
      runId: run.id,
      code: START_STALLED,
      title: "Run 连续两次启动卡住",
      summary: reason,
      nextStep: "这张工单连续两次启动卡住，系统不再自动重排。需要先查清 runtime 为什么起不来，再重跑。",
      leadNextStep: `先查 ${agent} 为什么起不来（plc recheck ${run.runtime}、它的启动日志），`
        + `再用 ${recover("retry")} 重跑，或者用 action=switch_runtime 换一个 runtime。`,
      source: "structural",
      dedupKey: `run-crash:${run.id}`,
      evidence: { errorCode: START_STALLED, failure: { scope: "attempt", retry: "resume", needs: "none", code: "run_interrupted" } },
      at: input.at,
    });
    if (run.role === "executor" && getItem(db, run.item_id)?.stage === "active") {
      transition(db, { itemId: run.item_id, to: "blocked", actor: "system", reason, runId: run.id });
    }
    return true;
  }).immediate();
  if (!stopped) return false;
  // 停掉 child（停 Run 的同一个做法，ticket-actions/lifecycle.ts 的 killRunProcess）。进程还没挂上 live 表时（runtime.start
  // 还没返回），manager 在挂上的那一刻看到 Run 已经结束，自己中断它。
  const child = liveChildren().get(run.item_id);
  if (child && child.runId === run.id) {
    liveChildren().delete(run.item_id);
    try {
      if (child.handle) void child.handle.interrupt(reason).catch(() => {});
      else child.proc?.kill();
    } catch {
      // 停不掉时不算失败：Run 已经记成 failed，进程退出时 manager 照常收尾。
    }
  }
  return true;
}

export function createWatchdog(db: Db, opts: WatchdogOptions = {}) {
  const stallMs = opts.stallMs ?? Number(process.env.PLC_STALL_MS ?? 15 * 60_000);
  const startStall = opts.startStallMs ?? startStallMs();
  // 准备工作区（runtime 还没启动）最多等多久才算挂死。PLC_START_PREPARE_STALL_MS 可以改，缺省 45 分钟，不小于启动的阈值。
  const prepareStall = Math.max(startStall, opts.prepareStallMs ?? (Number(process.env.PLC_START_PREPARE_STALL_MS) || 45 * 60_000));
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const checkpointPolicy = opts.checkpointPolicy ?? loadCheckpointPolicyConfig();

  const checkStartStalls = (at: Date): void => {
    const cutoff = new Date(at.getTime() - startStall).toISOString();
    const stuck = db.prepare(
      `SELECT r.* FROM runs r
       WHERE r.state='starting'
         AND r.purpose IN (${START_STALL_PURPOSES.map(() => "?").join(",")})
         AND julianday(r.started_at) < julianday(?)
         AND NOT EXISTS (SELECT 1 FROM runtime_events e WHERE e.run_id=r.id)
       ORDER BY r.id`,
    ).all(...START_STALL_PURPOSES, cutoff) as Run[];
    for (const run of stuck) {
      // runtime 还没启动时，Run 在准备工作区（装依赖、核查前记指纹）。#185 是这样：它在克隆 node_modules，19 分钟后正常启动，
      // 却在第 12 分钟被当成卡死停掉。这一段不按阈值算，只用 prepareStall（缺省 45 分钟）兜住真正挂死的。
      // runtime 已经起来（child 挂上了 live 表）还是一条事件都没有，才按阈值算卡住。
      const child = liveChildren().get(run.item_id);
      const runtimeStarted = child?.runId === run.id;
      const startedAt = Date.parse(run.started_at.includes("T") ? run.started_at : `${run.started_at.replace(" ", "T")}Z`);
      if (!runtimeStarted && at.getTime() - startedAt < prepareStall) continue;
      // 一个 Run 处理出错不挡别的 Run，也不让 daemon 的计时器抛错。
      try {
        if (stopStalledStart(db, run, { at, stallMs: startStall })) log(`[watchdog] run #${run.id} stalled at start; stopped`);
      } catch (error) {
        log(`[watchdog] run #${run.id} stalled at start, stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const checkStalls = (at: Date): void => {
    const threshold = new Date(at.getTime() - stallMs).toISOString();
    // 停滞判定的两处口径都随 Item/Run 分离改了（spec §5.2）：
    // 1. 运行态 stage 现在叫 active（旧 in_progress/assigned 已并入它）；
    // 2. item 停在 active 不再意味着有进程在跑——暂停时 Run 转 paused、item 不动。
    //    因此必须显式要求存在一个非暂停的活跃 Run，否则用户主动按下的暂停会被报成卡死。
    const stalled = db.prepare(
      `SELECT t.id, t.last_activity_at FROM items t
       WHERE t.stage='active'
         AND t.last_activity_at IS NOT NULL
         AND julianday(t.last_activity_at) < julianday(?)
         AND EXISTS (
           SELECT 1 FROM runs a
           WHERE a.item_id = t.id AND a.state IN ('starting','running')
         )`,
    ).all(threshold) as Array<{ id: number; last_activity_at: string }>;

    for (const item of stalled) {
      const child = liveChildren().get(item.id);
      if (!child) continue;
      const prior = (db.prepare(
        `SELECT COUNT(*) AS n FROM activities
         WHERE item_id=? AND kind='notification'
           AND json_extract(payload, '$.kind')='watchdog_stall'
           AND julianday(created_at) > julianday(?)`,
      ).get(item.id, item.last_activity_at) as { n: number }).n;
      const strike = prior + 1;
      addNotificationActivity(db, {
        itemId: item.id,
        runId: db.prepare("SELECT 1 FROM runs WHERE id=?").get(child.runId)
          ? child.runId
          : null,
        payload: { kind: "watchdog_stall", strike },
        now: at,
      });
      addInbox(db, {
        itemId: item.id,
        severity: strike >= 2 ? "blocker" : "attention",
        source: "structural",
        summary: `工单 #${item.id} 疑似卡死：超过 ${Math.round(stallMs / 60_000)} 分钟无任何事件（第 ${strike} 次探测）`,
      });
    }
  };

  const checkCheckpointSilence = (at: Date): void => {
    const active = db.prepare(
      `SELECT a.id AS run_id, a.item_id
       FROM runs a JOIN items t ON t.id=a.item_id
       -- 这里本就只取 starting/running，paused 已被自然排除，只需把 stage 换成新枚举。
       WHERE a.state IN ('starting','running') AND t.stage='active'
       ORDER BY a.id`,
    ).all() as Array<{ run_id: number; item_id: number }>;
    for (const run of active) {
      const child = liveChildren().get(run.item_id);
      if (!child || child.runId !== run.run_id || !child.streaming) continue;
      const state = readCheckpointPolicyState(db, {
        itemId: run.item_id,
        runId: run.run_id,
      });
      if (!checkpointReminderDue(state, checkpointPolicy, at)) continue;
      const send = opts.sendReminder
        ? (message: string) => opts.sendReminder!(run.item_id, run.run_id, message)
        : child.handle?.steer
          ? (message: string) => child.handle!.steer!(message)
          : child.handle?.send
            ? (message: string) => child.handle!.send!(message)
            : undefined;
      if (!send) continue;
      addNotificationActivity(db, {
        itemId: run.item_id,
        runId: run.run_id,
        payload: {
          kind: "checkpoint_reminder",
          completedToolEventsSinceCheckpoint: state.completedToolEventsSinceCheckpoint,
          domainEventsSinceCheckpoint: state.domainEventsSinceCheckpoint,
          childItemsSinceCheckpoint: state.childItemsSinceCheckpoint,
        },
        now: at,
      });
      void Promise.resolve(send(CHECKPOINT_REMINDER)).catch(() => {});
    }
  };

  return {
    check(): void {
      const at = now();
      checkStartStalls(at);
      checkStalls(at);
      checkCheckpointSilence(at);
    },
  };
}
