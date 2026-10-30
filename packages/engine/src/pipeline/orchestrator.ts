import type { Db } from "@pi-lead-child/store";
import { runUpdatedEvent } from "@pi-lead-child/store";
import { addInbox } from "@pi-lead-child/store";
import { getRun, updateRun } from "@pi-lead-child/store";
import { getItem, transition, updateOrchestrationState } from "@pi-lead-child/store";
import { createDispatcher, type DispatchClaim, type Dispatcher } from "../coordinator/dispatch.js";
import { liveChildren } from "../children/manager.js";
import type { RuntimeDisabledBy, RuntimeId } from "@pi-lead-child/core";
import { createLearningService } from "../coordinator/learning.js";
import { createCoordinator } from "../coordinator/service.js";
import { processContinuations } from "../coordinator/continuation-runner.js";
import { classifyFailure, isRuntimeId, runFailure } from "@pi-lead-child/runtime";
import { healthLevel, kernelHandlesFailure } from "@pi-lead-child/runtime";
import type { RuntimeProfile, RuntimeProfileIdentity } from "@pi-lead-child/runtime";
import type { RuntimePreflight } from "./preflight.js";
import { latestDeliveryRunId } from "./delivery-run.js";
import { automaticReviewNeeded, automaticReviewRequest, automaticReviewRuntime } from "./automatic-review.js";
import { reviewerUnavailableReason } from "../coordinator/reviewer-choice.js";
import type { Run } from "@pi-lead-child/core";

export interface Orchestrator {
  readonly dispatcher: Dispatcher;
  tick(): Promise<{ dispatched: number }>;
}

export function createOrchestrator(
  db: Db,
  options: {
    onDispatch: (claim: DispatchClaim) => Promise<void> | void;
    reviewerRuntime?: RuntimeId;
    maxDispatchPerTick?: number;
    now?: () => Date;
    dataDir?: string;
    runtimeProfile?: (runtime: RuntimeId) => RuntimeProfile;
    // 停用的执行器是谁停用的（D11，工单 11）：交给派发器，核查挂起时的通知按它判断 Lead 能不能凭证据验收。
    runtimeDisabledBy?: (runtime: RuntimeId) => RuntimeDisabledBy | null;
    // 这张工单是不是还被一个 Run 占着。缺省看 manager 的 live 表；daemon 另外加上 Lead 工具看管的 Run（它们收尾得更晚）。
    itemBusy?: (itemId: number) => boolean;
    // claim 之前的 preflight（工单 05）。tick 先跑过期的安装检查，claim 再读缓存。
    preflight?: RuntimePreflight;
    log?: (line: string) => void;
  },
): Orchestrator {
  const dispatcher = createDispatcher(db, {
    now: options.now, runtimeProfile: options.runtimeProfile, preflight: options.preflight,
    ...(options.runtimeDisabledBy ? { runtimeDisabledBy: options.runtimeDisabledBy } : {}),
    itemBusy: options.itemBusy ?? ((itemId) => liveChildren().has(itemId)),
    log: options.log,
  });
  // 核查员按 reviewer-choice.ts 选：工单选好的核查员；没选时跳过停用的和有故障的 runtime（2026-10-20），避开执行者的
  // runtime（工单 09）。健康账本按派发 gate 的同一个 profile 查。
  // 每次用时现算：用户在设置里停用一个 runtime 后，下一次排核查就跳过它，不用重启 daemon。
  const reviewerRuntime = (itemId: number): RuntimeId => automaticReviewRuntime(db, itemId, options.reviewerRuntime, {
    ...(options.runtimeProfile ? { profile: options.runtimeProfile } : {}),
  });
  const maxDispatch = options.maxDispatchPerTick ?? 32;
  const learning = options.dataDir ? createLearningService(db, { dataDir: options.dataDir }) : null;
  // 账号和配置故障记在健康账本上（工单 03），不算 reviewer 自己的失败。
  // 瞬时失败由内核退避后重试（工单 06），也不算：失败路径已经排了重试，或者在上限时升起了 blocker。
  const kernelHandled = (run: Run): boolean => run.state === "failed" && kernelHandlesFailure(runFailure(run), run.purpose);
  const coordinator = createCoordinator({ db, now: options.now });

  const finishTerminalClaims = () => {
    const claims = db.prepare(
      `SELECT c.run_id, r.* FROM dispatch_claims c
       JOIN runs a ON a.id=c.run_id
       JOIN dispatch_requests r ON r.id=c.request_id
       WHERE a.state IN ('finished','failed','stopped') ORDER BY r.id`,
    ).all() as Array<any>;
    for (const row of claims) {
      const run = getRun(db, row.run_id)!;
      const item = getItem(db, row.item_id);
      // runItem 拒绝了这次启动（例如同一张工单上还有 Run 在收尾）：Run 没有真正开始，这件事还没做。
      // 请求退避后回到队列，不算一次失败（发布评审 run-resume F1：以前请求记成 failed，这件事就丢了）。
      if (run.state === "stopped" && run.error_code === "run_start_refused") {
        dispatcher.requeueRefusedStart(run.id);
        continue;
      }
      dispatcher.completeRun(run.id);
      if (!item) continue;
      if (row.role === "reviewer" && run.state !== "finished") {
        // 失败路径已经为账本上的故障排了一个挂起的重试请求，恢复后再走。瞬时失败排的是退避重试。
        // 所以这里不立即重试，也不把它计入 reviewer 的次数上限。
        if (kernelHandled(run)) continue;
        // 额度只算这份交付之后的失败：上一份交付的核查失败不该让新交付的第一次核查失败就耗尽（发布评审）。
        const delivery = latestDeliveryRunId(db, item.id);
        const failures = (db.prepare(
          `SELECT * FROM runs
           WHERE item_id=? AND role='reviewer' AND state IN ('failed','stopped') AND id > ?`,
        ).all(item.id, delivery ?? 0) as Run[])
          // 没启动成的 Run（run_start_refused）不是 reviewer 的失败。
          .filter((failed) => !kernelHandled(failed) && failed.error_code !== "run_start_refused").length;
        learning?.captureFailure({
          projectId: item.project_id ?? undefined,
          itemId: item.id,
          runId: run.id,
          kind: "reviewer",
          errorCode: run.error_code ?? "reviewer_failed",
          summary: run.error_message ?? `reviewer run #${run.id} failed`,
          // 按根因去重（learning.ts 的 failureFingerprint）：同一个根因措辞不同的失败只沉淀一次。
          rootCause: runFailure(run).code,
        });
        // retry_limit 可空（reminder 恒为 NULL）；task 的建单缺省是 1，用同一个数兜底。
        const retryLimit = item.retry_limit ?? 1;
        if (failures <= retryLimit) {
          // 上一次的核查员还能用（没停用，profile 上没有故障）就沿用它：它可能是用户或 Lead 指定的，核查崩溃或超时
          // 不是换人的理由（2026-10-21 审查 M5）。不能用了才重新选（2026-10-20）。
          // 选到同一个 runtime 时沿用它的模型；换了 runtime，模型属于原来的 runtime，不带过去。
          const previous: RuntimeId | null = isRuntimeId(row.runtime) ? row.runtime : null;
          const runtime = previous && reviewerUnavailableReason(db, previous, {
            ...(options.runtimeProfile ? { profile: options.runtimeProfile } : {}),
            model: row.model ?? null,
          }) === null ? previous : reviewerRuntime(item.id);
          dispatcher.request({
            itemId: item.id,
            role: "reviewer",
            purpose: "review",
            runtime,
            model: runtime === row.runtime ? row.model ?? undefined : undefined,
            trigger: "reviewer-retry",
            idempotencyKey: `reviewer-retry:${item.id}:delivery-${delivery ?? 0}:${failures}`,
          });
        } else {
          // 父/根都为空即"自己就是那棵树"，通知落回自己而不是丢掉。
          const ownerId = item.parent_item_id ?? item.root_item_id ?? item.id;
          updateOrchestrationState(db, ownerId, "failed");
          addInbox(db, {
            itemId: ownerId, severity: "blocker", source: "structural",
            summary: `工单 #${item.id} reviewer 重试已耗尽（${failures - 1}/${retryLimit}）`,
          });
        }
        continue;
      }
      if (run.state !== "finished") continue;
      // 条件与幂等键和 child manager 共用（automatic-review.ts）：直接启动的 Run 由 manager 请求，
      // 认领来的 Run 两边都会请求，同一个键只建一条请求。
      if (automaticReviewNeeded(db, item, { role: row.role, purpose: row.purpose, state: run.state })) {
        dispatcher.request(automaticReviewRequest(item.id, run.id, reviewerRuntime(item.id)));
      }
    }
  };

  const resumeReadyParents = () => {
    const parents = db.prepare(
      `SELECT * FROM items
       WHERE plan_state='waiting' AND active_plan_revision IS NOT NULL
       ORDER BY id`,
    ).all() as Array<any>;
    for (const parent of parents) {
      const members = db.prepare(
        `SELECT t.id, t.stage FROM item_plan_memberships m
         JOIN items t ON t.id=m.child_item_id
         WHERE m.parent_item_id=? AND m.revision=? AND m.required=1`,
      ).all(parent.id, parent.active_plan_revision) as Array<{ id: number; stage: string }>;
      if (!members.length) continue;
      for (const member of members) {
        if (member.stage !== "done") continue;
        const completedRun = db.prepare(
          `SELECT id FROM runs
           WHERE item_id=? AND role='executor' AND state='finished'
           ORDER BY id DESC LIMIT 1`,
        ).get(member.id) as { id: number } | undefined;
        if (completedRun) {
          coordinator.recordSubitemCompleted({
            parentItemId: parent.id,
            childItemId: member.id,
            runId: completedRun.id,
          });
        }
      }
      if (members.some((member) => member.stage === "cancelled")) {
        updateOrchestrationState(db, parent.id, "failed");
        addInbox(db, {
          itemId: parent.id, severity: "blocker", source: "structural",
          summary: `工单 #${parent.id} 的必需子工单已取消，无法继续集成`,
        });
        continue;
      }
      if (!members.every((member) => member.stage === "done")) continue;
      updateOrchestrationState(db, parent.id, "integrating");
      dispatcher.request({
        itemId: parent.id,
        role: "executor",
        purpose: "integration",
        ...(parent.requested_runtime ? { runtime: parent.requested_runtime } : {}),
        model: parent.requested_model ?? undefined,
        trigger: "system-integration",
        idempotencyKey: `integration:${parent.id}:revision:${parent.active_plan_revision}`,
      });
    }
  };

  return {
    dispatcher,
    async tick(): Promise<{ dispatched: number }> {
      dispatcher.reclaimExpired();
      finishTerminalClaims();
      processContinuations(db, {
        now: options.now,
        requestDispatch: (request) => { dispatcher.request(request); },
      });
      resumeReadyParents();
      await options.preflight?.refresh();
      let dispatched = 0;
      while (dispatched < maxDispatch) {
        const claim = dispatcher.claimNext();
        if (!claim) break;
        dispatcher.markStarted(claim);
        try {
          await options.onDispatch(claim);
          dispatched++;
        } catch (error) {
          db.transaction(() => {
            // 派发阶段的失败没有经过 adapter，由内核按同一张映射表分类。
            updateRun(db, claim.runId, {
              state: "failed", endedAt: true, errorCode: "dispatch_start_failed",
              errorMessage: String(error),
              failure: classifyFailure(claim.runtime, { errorCode: "dispatch_start_failed", message: String(error) }),
            });
            const item = getItem(db, claim.itemId);
            if (claim.role === "executor" && claim.purpose === "execution" && item?.stage === "active") {
              transition(db, {
                itemId: claim.itemId,
                to: "blocked",
                actor: "system",
                reason: `runtime dispatch failed: ${String(error).slice(0, 1_600)}`,
                runId: claim.runId,
              });
            }
            coordinator.recordSystemCheckpoint({
              itemId: claim.itemId,
              runId: claim.runId,
              kind: "blocked",
              title: "Run dispatch failed",
              summary: `Run #${claim.runId} could not start: ${String(error).slice(0, 1_600)}`,
              nextStep: "Fix the runtime dispatch failure and retry the run.",
              idempotencyKey: `run-crash:${claim.runId}`,
              leadVisible: true,
              precedingEvents: [runUpdatedEvent(claim.itemId, claim.runId)],
            });
            dispatcher.completeRun(claim.runId);
            // 先交给 Lead：它可以换 runtime 或模型再跑（recover_ticket_run），处理不了时 daemon 升级给用户。
            addInbox(db, {
              itemId: claim.itemId, severity: "blocker", source: "structural",
              summary: `工单 #${claim.itemId} runtime 启动失败：${String(error).slice(0, 180)}`,
              payload: { kind: "dispatch_start_failed", runId: claim.runId, needsUser: false },
            });
          }).immediate();
        }
      }
      return { dispatched };
    },
  };
}
