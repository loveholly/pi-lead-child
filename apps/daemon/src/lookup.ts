// purpose 为 lookup 的工单和 Run 的收尾：进程内的受限 Run（2026-10-22 起是通道派的子 agent 工单，agent-tasks.ts），
// 结果交给发起方，不是交付，不经过 onChildDone，不叫醒 Lead（run-finished.ts 也排除了 lookup）。
//   - closeLookupItem：工单跟着结局进 done 或 cancelled（store 的 transition，不直接改 stage）；
//   - reclaimLookupRun、recoverLookupsAfterRestart：daemon 重启时被打断的记成失败，工单不进 blocked，不重新派发。
// 旧的代查启动器（代查剧本的进程内 runtime）随代查退役了（落地计划 D1）。
import type { Item, Run } from "@pi-lead-child/core";
import type { LookupOutcome } from "@pi-lead-child/protocol";
import { typedFailure } from "@pi-lead-child/runtime";
import { addActivity, getItem, getRun, transition, transitionRunState, type Db } from "@pi-lead-child/store";

const LOOKUP_STARTED = "lookup_started";
const LOOKUP_FINISHED = "lookup_finished";

/** 这个 Run 属于哪一次代查（建 Run 的那笔事务里记的 lookup_started）。 */
export function lookupIdOfRun(db: Db, runId: number): number | null {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.lookupId') AS lookup_id FROM activities
     WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')=? ORDER BY id LIMIT 1`,
  ).get(runId, LOOKUP_STARTED) as { lookup_id: number | null } | undefined;
  return typeof row?.lookup_id === "number" ? row.lookup_id : null;
}

/**
 * 代查工单跟着代查进终态（spec D14 的不变量 3）。finished：active → review → done（代查工单不等人验收）；
 * failed、cancelled：→ cancelled。工单已经是终态时不动。调用方负责事务。返回工单最后的 stage。
 */
export function closeLookupItem(
  db: Db,
  input: { itemId: number; runId?: number; status: LookupOutcome["status"]; reason: string; now?: Date },
): Item["stage"] | null {
  const item = getItem(db, input.itemId);
  if (!item) return null;
  if (item.purpose !== "lookup") throw new Error(`item #${input.itemId} is not a lookup item`);
  const step = (to: Item["stage"]) => transition(db, {
    itemId: input.itemId, to, actor: "system", reason: input.reason.slice(0, 300),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  if (input.status === "finished") {
    if (item.stage === "ready") step("active");
    if (getItem(db, input.itemId)!.stage === "active") step("review");
    if (getItem(db, input.itemId)!.stage === "review") step("done");
  } else if (item.stage === "ready" || item.stage === "active") {
    step("cancelled");
  }
  return getItem(db, input.itemId)!.stage;
}

function recordFinished(
  db: Db,
  input: { itemId: number; runId?: number; lookupId: number | null; outcome: LookupOutcome; stage: Item["stage"] | null },
): void {
  const result = input.outcome.result;
  addActivity(db, {
    itemId: input.itemId, ...(input.runId !== undefined ? { runId: input.runId } : {}), actor: "system", kind: "decision",
    payload: {
      decision: LOOKUP_FINISHED,
      lookupId: input.lookupId,
      status: input.outcome.status,
      error: input.outcome.error?.slice(0, 500) ?? null,
      found: result?.found ?? null,
      sources: result?.sources.length ?? 0,
      verifiedSources: result?.sources.filter((source) => source.verified).length ?? 0,
      reads: input.outcome.reads.length,
      refusedReads: input.outcome.reads.filter((read) => read.refused !== undefined).length,
      stage: input.stage,
    },
  });
}

export interface ReclaimedLookup {
  lookupId: number;
  itemId: number;
  runId: number | null;
  outcome: LookupOutcome;
}

const RESTART_MESSAGE = "daemon 重启，代查被打断";

/**
 * daemon 重启时被打断的一次代查：Run 记成失败（run_interrupted，不扣任何额度），工单进 cancelled，不重新派发，
 * 不写 blocked 检查点，不升 blocker，不叫醒 Lead。返回交回 hub 的结果；Run 不是活的代查时返回 null。
 */
export function reclaimLookupRun(db: Db, runId: number, now: Date = new Date()): ReclaimedLookup | null {
  return db.transaction((): ReclaimedLookup | null => {
    const run = getRun(db, runId);
    if (!run || run.purpose !== "lookup" || (run.state !== "starting" && run.state !== "running")) return null;
    transitionRunState(db, runId, "failed", {
      endedAt: true, errorCode: "daemon_restart", errorMessage: RESTART_MESSAGE,
      failure: typedFailure("run_interrupted", { errorCode: "daemon_restart", message: RESTART_MESSAGE }),
    });
    const lookupId = lookupIdOfRun(db, runId);
    const outcome: LookupOutcome = { status: "failed", result: null, reads: [], error: RESTART_MESSAGE };
    const stage = closeLookupItem(db, { itemId: run.item_id, runId, status: "failed", reason: RESTART_MESSAGE, now });
    recordFinished(db, { itemId: run.item_id, runId, lookupId, outcome, stage });
    return lookupId === null ? null : { lookupId, itemId: run.item_id, runId, outcome };
  }).immediate();
}

/**
 * daemon 启动时调用一次（在接管和孤儿回收之前）：
 *   - 还在 starting、running 的代查 Run 都是上一个 daemon 的进程内会话，已经不在了：记成失败（reclaimLookupRun）；
 *   - 代查工单不是终态、却没有活的 Run（上一个 daemon 在 Run 结束和收尾之间退出）：收进 cancelled。
 * 只看 purpose=lookup 的工单和 Run，修过的不再匹配，所以有界、幂等。
 */
export function recoverLookupsAfterRestart(db: Db, now: Date = new Date()): ReclaimedLookup[] {
  const reclaimed: ReclaimedLookup[] = [];
  const runs = db.prepare(
    "SELECT id FROM runs WHERE purpose='lookup' AND state IN ('starting','running') ORDER BY id",
  ).all() as Array<{ id: number }>;
  for (const run of runs) {
    const result = reclaimLookupRun(db, run.id, now);
    if (result) reclaimed.push(result);
  }
  const items = db.prepare(
    `SELECT i.id FROM items i
     WHERE i.kind='task' AND i.purpose='lookup' AND i.stage IN ('ready','active')
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.item_id=i.id AND r.state IN ('starting','running'))
     ORDER BY i.id`,
  ).all() as Array<{ id: number }>;
  for (const item of items) {
    const done = db.transaction((): ReclaimedLookup | null => {
      const current = getItem(db, item.id);
      if (!current || (current.stage !== "ready" && current.stage !== "active")) return null;
      const run = db.prepare("SELECT * FROM runs WHERE item_id=? ORDER BY id DESC LIMIT 1").get(item.id) as Run | undefined;
      const lookupId = run ? lookupIdOfRun(db, run.id) : null;
      if (run?.state === "paused") transitionRunState(db, run.id, "stopped", { endedAt: true, errorCode: "daemon_restart", errorMessage: RESTART_MESSAGE });
      // 结果只在上一个 daemon 的内存里，已经没有了：Run 正常结束的也按失败交回。被停止的按取消交回。
      const status: LookupOutcome["status"] = run?.state === "stopped" ? "cancelled" : "failed";
      const outcome: LookupOutcome = {
        status, result: null, reads: [],
        error: run?.state === "finished" ? "代查结束以后 daemon 重启，结果没有留下" : RESTART_MESSAGE,
      };
      const runId = run?.id;
      const stage = closeLookupItem(db, { itemId: item.id, ...(runId !== undefined ? { runId } : {}), status, reason: RESTART_MESSAGE, now });
      recordFinished(db, { itemId: item.id, ...(runId !== undefined ? { runId } : {}), lookupId, outcome, stage });
      return lookupId === null ? null : { lookupId, itemId: item.id, runId: runId ?? null, outcome };
    }).immediate();
    if (done) reclaimed.push(done);
  }
  return reclaimed;
}
