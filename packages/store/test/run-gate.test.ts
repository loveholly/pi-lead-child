import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem, getItem, transition } from "../src/items.js";
import { addActivity } from "../src/activities.js";
import { addInbox } from "../src/inbox.js";
import { createRun, updateRun } from "../src/runs.js";
import { assertRunAllowed, executorRetryBudget } from "../src/run-gate.js";
import { insertOutcomeSnapshot, normalizeOutcomePayload } from "../src/outcomes.js";
import type { FailureScope, TypedFailure } from "@pi-lead-child/core";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
});

// 直接 UPDATE 而不走 transition：本文件测的是闸门本身，不该被状态机的 actor 规则牵连。
function task(stage: string): number {
  const id = createItem(db, { title: "t", brief: "b", createdBy: "system" }); // → ready
  if (stage !== "ready") db.prepare("UPDATE items SET stage=? WHERE id=?").run(stage, id);
  return id;
}

function reminder(): number {
  return createItem(db, {
    title: "r", brief: "b", createdBy: "user", kind: "reminder",
    remindAt: "2026-08-01T00:00:00.000Z",
  });
}

describe("run gate", () => {
  it("refuses any run on a reminder", () => {
    const id = reminder();
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" }))
      .toThrow(/only a task may have a run/);
  });

  it("refuses a run on an item that does not exist", () => {
    expect(() => assertRunAllowed(db, { itemId: 999, role: "executor", purpose: "execution" }))
      .toThrow(/item 999 not found/);
  });

  it("allows an executor run from ready, active and blocked", () => {
    for (const s of ["ready", "active", "blocked"]) {
      const id = task(s);
      expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" }))
        .not.toThrow();
    }
  });

  it("refuses an executor run from review and done", () => {
    for (const s of ["review", "done"]) {
      const id = task(s);
      expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" }))
        .toThrow(/executor run requires stage/);
    }
  });

  it("refuses an executor run from draft", () => {
    // draft 只有 user/lead 显式 hold 才建得出来（C4），所以这里不能复用 task() 的 system 作者。
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user", hold: true });
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" }))
      .toThrow(/executor run requires stage/);
  });

  it("allows a reviewer run only from review", () => {
    const inReview = task("review");
    expect(() => assertRunAllowed(db, { itemId: inReview, role: "reviewer", purpose: "review" }))
      .not.toThrow();
    const active = task("active");
    expect(() => assertRunAllowed(db, { itemId: active, role: "reviewer", purpose: "review" }))
      .toThrow(/reviewer run requires stage 'review'/);
  });

  it("allows an integration run only from active + integrating", () => {
    const id = task("active");
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "integration" }))
      .toThrow(/integration run requires/);
    db.prepare("UPDATE items SET plan_state='integrating' WHERE id=?").run(id);
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "integration" }))
      .not.toThrow();
  });

  it("is enforced by createRun, not only by callers", () => {
    const id = reminder();
    expect(() => createRun(db, { itemId: id, role: "executor" }))
      .toThrow(/only a task may have a run/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(0);
  });

  it("lets createRun derive role and purpose defaults through the gate", () => {
    // createRun 的 role 缺省 executor、purpose 缺省随 role 走；闸门必须看到同一组缺省值，
    // 否则 reviewer 的 run 会被按 executor 的 stage 集合校验。
    const inReview = task("review");
    expect(() => createRun(db, { itemId: inReview, role: "reviewer" })).not.toThrow();
    expect(() => createRun(db, { itemId: inReview, role: "executor" }))
      .toThrow(/executor run requires stage/);
  });
});

// 「建完先别跑」是树的属性，不是行的属性（spec §6.6：确认发生在树根）。
// 闸门原本只看自己那一行的 stage，于是这条路是通的：
//   用户说先别动 → lead hold 住根 → lead 建一批 ready 子任务 → lead spawn_child
// 执行了用户明确拒绝的工作。
describe("run gate reads the tree, not just the row", () => {
  it("refuses an executor run whose root is still draft", () => {
    const root = createItem(db, { title: "根", brief: "b", createdBy: "user", hold: true });
    const child = createItem(db, {
      title: "子", brief: "b", createdBy: "child", parentItemId: root, rootItemId: root,
    });
    expect(getItem(db, root)!.stage).toBe("draft");
    expect(getItem(db, child)!.stage).toBe("ready");
    expect(() => assertRunAllowed(db, { itemId: child, role: "executor", purpose: "execution" }))
      .toThrow(/root item #\d+ is still draft/);
  });

  it("allows it once the user confirms the root", () => {
    const root = createItem(db, { title: "根", brief: "b", createdBy: "user", hold: true });
    const child = createItem(db, {
      title: "子", brief: "b", createdBy: "child", parentItemId: root, rootItemId: root,
    });
    transition(db, { itemId: root, to: "ready", actor: "user", reason: "confirmed" });
    expect(() => assertRunAllowed(db, { itemId: child, role: "executor", purpose: "execution" }))
      .not.toThrow();
  });

  it("refuses another executor run after an invalid outcome envelope until the user authorizes retry", () => {
    const id = task("active");
    const runId = createRun(db, { itemId: id, runtime: "claude" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    db.prepare("UPDATE items SET stage='blocked' WHERE id=?").run(id);
    addInbox(db, {
      itemId: id,
      severity: "blocker",
      source: "structural",
      summary: "成果登记失败",
      lossless: true,
      payload: {
        blockerCode: "invalid_outcome_envelope",
        runId,
        blockerKey: `invalid-outcome-envelope:${runId}`,
      },
    });

    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" }))
      .toThrow(/成果登记失败[\s\S]*同一宿主缺陷/);

    addActivity(db, {
      itemId: id,
      actor: "user",
      kind: "decision",
      payload: { decision: "retry_authorized", sourceTurnId: "user-said-retry" },
    });
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" }))
      .not.toThrow();
  });

  // 决策边界（工单 07，spec D3）：登记待处理和无效信封是同一类宿主缺陷，闸门同样拦住。
  // 只看最近一次执行 Run：更早的 Run 上的登记待处理不拦新的派发。
  it("refuses another executor run while the latest run's registration is pending", () => {
    const id = task("blocked");
    const pending = (runId: number) => addInbox(db, {
      itemId: id,
      severity: "blocker",
      source: "structural",
      summary: "运行结果登记待处理",
      lossless: true,
      payload: { blockerCode: "registration_pending", runId, blockerKey: `registration-pending:${runId}` },
    });
    const older = createRun(db, { itemId: id, runtime: "claude" });
    updateRun(db, older, { state: "finished", endedAt: true, exitCode: 0 });
    const latest = createRun(db, { itemId: id, runtime: "claude" });
    updateRun(db, latest, { state: "finished", endedAt: true, exitCode: 0 });
    pending(older);
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" })).not.toThrow();

    pending(latest);
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" }))
      .toThrow(new RegExp(`Run #${latest}[\\s\\S]*同一宿主缺陷`));

    addActivity(db, {
      itemId: id,
      actor: "user",
      kind: "decision",
      payload: { decision: "retry_authorized", sourceTurnId: "user-said-retry" },
    });
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" })).not.toThrow();
  });

  it("refuses spawn after a legacy unhandled invalid-outcome exception", () => {
    const id = task("blocked");
    const runId = createRun(db, { itemId: id, runtime: "claude" });
    updateRun(db, runId, {
      state: "failed",
      endedAt: true,
      errorCode: "unhandled_run_exception",
      errorMessage: "Error: outcome.validations[3].outcome is invalid\n    at normalizeValidations (src/store/outcomes.ts:211:48)",
    });

    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" }))
      .toThrow(/成果登记失败[\s\S]*不要换模型或换 runtime/);
  });

  it("does not disturb a self-rooted item", () => {
    const solo = createItem(db, { title: "独", brief: "b", createdBy: "system" });
    expect(() => assertRunAllowed(db, { itemId: solo, role: "executor", purpose: "execution" }))
      .not.toThrow();
  });
});

// 决策边界（工单 02，spec D1）：只有 task 和 unknown 扣工单的重试额度。
describe("retry budget by failure scope", () => {
  const failure = (scope: FailureScope): TypedFailure => ({
    scope, retry: "never", needs: "none", code: `${scope}_sample`, evidence: "sample",
  });

  function failedRun(itemId: number, typed: TypedFailure | null, errorMessage = "opaque"): void {
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "failed", endedAt: true, errorCode: "codex_error", errorMessage, failure: typed });
  }

  it.each([
    ["attempt", 0], ["runtime", 0], ["account", 0], ["host", 0], ["task", 1], ["unknown", 1],
  ] as const)("a %s failure charges %i", (scope, charged) => {
    const id = task("blocked");
    failedRun(id, failure(scope));
    expect(executorRetryBudget(db, id).failures).toBe(charged);
  });

  it("classifies an untyped legacy failure with the same mapping table", () => {
    const id = task("blocked");
    failedRun(id, null, "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.");
    failedRun(id, null, "something nobody recognised");
    expect(executorRetryBudget(db, id).failures).toBe(1);
  });

  it("keeps a ticket dispatchable after repeated account failures", () => {
    const id = task("blocked");
    for (let attempt = 0; attempt < 3; attempt += 1) failedRun(id, failure("account"));
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" })).not.toThrow();
  });
});

// 决策边界（工单 09，spec D4）：修复回合的闸门分支。
// 来源 Run 是工单最新的执行 Run，必须已经 finished，成果还没有登记。
// 工单必须停在这个 Run 的登记相关 blocked 上，或者停在 active。其他情况一律拒绝。
describe("run gate: outcome repair branch", () => {
  const repair = (itemId: number, role: "executor" | "reviewer" = "executor") =>
    () => assertRunAllowed(db, { itemId, role, purpose: "outcome_repair" });

  function sourceRun(itemId: number, state: "finished" | "running" | "failed" = "finished"): number {
    const runId = createRun(db, { itemId, runtime: "claude" });
    updateRun(db, runId, { state, ...(state === "running" ? {} : { endedAt: true, exitCode: 0 }) });
    return runId;
  }

  function blocker(itemId: number, runId: number, blockerCode: string): void {
    addInbox(db, {
      itemId, severity: "blocker", source: "structural", summary: blockerCode, lossless: true,
      payload: { blockerCode, runId, blockerKey: `${blockerCode}:${runId}`, title: blockerCode },
    });
  }

  it.each([
    "terminal_handoff_failed", "outcome_registration_missing", "invalid_outcome_envelope", "registration_pending",
  ])("allows a repair while the item is blocked by %s of the finished source run", (code) => {
    const id = task("blocked");
    blocker(id, sourceRun(id), code);
    expect(repair(id)).not.toThrow();
  });

  it("allows a repair while the item is active", () => {
    const id = task("active");
    sourceRun(id);
    expect(repair(id)).not.toThrow();
  });

  it("refuses a repair while the item is blocked for another reason", () => {
    const id = task("blocked");
    blocker(id, sourceRun(id), "llm_error");
    expect(repair(id)).toThrow(/outcome repair requires item #\d+ to be blocked by the registration of run #\d+/);
  });

  it("refuses a repair when the registration blocker belongs to an older execution run", () => {
    const id = task("blocked");
    const older = sourceRun(id);
    sourceRun(id);
    blocker(id, older, "terminal_handoff_failed");
    expect(repair(id)).toThrow(/blocked by the registration of run/);
  });

  it.each(["running", "failed"] as const)("refuses a repair while the source run is %s", (state) => {
    const id = task("blocked");
    blocker(id, sourceRun(id, state), "terminal_handoff_failed");
    expect(repair(id)).toThrow(/requires a finished source run/);
  });

  it("refuses a repair without any execution run", () => {
    expect(repair(task("active"))).toThrow(/requires a finished execution run/);
  });

  it.each(["ready", "review", "done", "cancelled"])("refuses a repair while the item is %s", (stage) => {
    const id = task("active");
    blocker(id, sourceRun(id), "terminal_handoff_failed");
    db.prepare("UPDATE items SET stage=? WHERE id=?").run(stage, id);
    expect(repair(id)).toThrow(/outcome repair requires item/);
  });

  // 额度在闸门里：额度用完以后，任何一条路径都建不出新的修复 Run。
  // 正在进行的修复回合不算进它自己的额度。
  it("refuses a repair once the source run's repair budget is used up", () => {
    const id = task("blocked");
    const runId = sourceRun(id);
    blocker(id, runId, "terminal_handoff_failed");
    const repairRunId = createRun(db, { itemId: id, runtime: "claude", purpose: "outcome_repair", resumedFromRunId: runId });
    expect(repair(id)).not.toThrow();
    updateRun(db, repairRunId, { state: "failed", endedAt: true });
    expect(repair(id)).toThrow(/outcome repair budget of run #\d+ is used up/);
  });

  // 没启动成的执行 Run 不是「最新的执行 Run」：修复的来源仍是之前那个 finished 的 Run（发布评审 reliability-backlog 复核）。
  it("does not take an execution run whose start was refused as the latest execution run", () => {
    const id = task("blocked");
    const runId = sourceRun(id);
    blocker(id, runId, "terminal_handoff_failed");
    const refused = createRun(db, { itemId: id, runtime: "claude" });
    updateRun(db, refused, { state: "stopped", endedAt: true, errorCode: "run_start_refused", errorMessage: "live runtime" });
    expect(repair(id)).not.toThrow();
  });

  // 没启动成的修复回合（run_start_refused）没有开始，不用掉额度（发布评审 reliability-backlog）。
  it("does not count a repair run whose start was refused against the budget", () => {
    const id = task("blocked");
    const runId = sourceRun(id);
    blocker(id, runId, "terminal_handoff_failed");
    const refused = createRun(db, { itemId: id, runtime: "claude", purpose: "outcome_repair", resumedFromRunId: runId });
    updateRun(db, refused, { state: "stopped", endedAt: true, errorCode: "run_start_refused", errorMessage: "live runtime" });
    expect(repair(id)).not.toThrow();
  });

  it("refuses a reviewer repair run", () => {
    const id = task("blocked");
    blocker(id, sourceRun(id), "terminal_handoff_failed");
    expect(repair(id, "reviewer")).toThrow(/must be an executor run/);
  });

  it("refuses a repair once the source run's outcome is registered", () => {
    const id = task("blocked");
    const runId = sourceRun(id);
    blocker(id, runId, "terminal_handoff_failed");
    insertOutcomeSnapshot(db, {
      itemId: id, executorRunId: runId, source: "system_recovered", sourceOutputSha256: "hash",
      outcome: normalizeOutcomePayload({ summary: "done" }, { allowPartial: true }),
    });
    expect(repair(id)).toThrow(/already has a registered outcome/);
  });

  // 修复额度和执行重试额度分开。宿主缺陷闸门拦的是重新执行，不拦修复回合。
  it("ignores the exhausted execution retry budget and the host-defect halt", () => {
    const id = task("blocked");
    const failed = createRun(db, { itemId: id, runtime: "claude" });
    updateRun(db, failed, {
      state: "failed", endedAt: true, errorCode: "error_max_turns", errorMessage: "max turns",
      failure: { scope: "task", retry: "never", needs: "none", code: "max_turns", evidence: "max turns" },
    });
    blocker(id, sourceRun(id), "invalid_outcome_envelope");
    // 两个 Run 都建好以后再收紧额度：一次 task 失败就用完了执行重试额度。
    db.prepare("UPDATE items SET retry_limit=0 WHERE id=?").run(id);
    expect(executorRetryBudget(db, id).exhausted).toBe(true);
    expect(() => assertRunAllowed(db, { itemId: id, role: "executor", purpose: "execution" })).toThrow();
    expect(repair(id)).not.toThrow();
  });
});
