// 一个 Run 用哪个模型和 effort（run-choice.ts）。回归：以前每个启动路径都写
// `explicit ?? items.requested_model ?? 写死的默认值`，核查请求会拿到执行者的模型。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { addActivity, createItem, createRun, getItem, getRun, openDb, setReviewerSetting, transition, updateRun } from "@pi-lead-child/store";

import { createDispatcher } from "../src/coordinator/dispatch.js";
import { runEffortFor, runModelFor, runProfileChoice } from "../src/coordinator/run-choice.js";

function setup(prefix: string) {
  const db = openDb(join(tempDir(prefix), "plc.db"));
  const itemId = createItem(db, { title: "code", brief: "b", createdBy: "user" });
  // 执行者是 Claude Code 上的 opus。
  db.prepare("UPDATE items SET requested_runtime='claude', requested_model='opus' WHERE id=?").run(itemId);
  return { db, itemId };
}

function request(db: ReturnType<typeof openDb>, id: number) {
  return db.prepare("SELECT runtime, model, effort FROM dispatch_requests WHERE id=?").get(id);
}

describe("model and effort of a run", () => {
  it("does not give a review on another runtime the executor's model", () => {
    const { db, itemId } = setup("plc-run-choice-review-");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const id = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex", trigger: "test", idempotencyKey: "review",
    });
    // 旧代码：model='opus'，Codex 收到一个它不认识的模型名。
    expect(request(db, id)).toEqual({ runtime: "codex", model: null, effort: null });
  });

  it("gives an execution on the ticket's runtime the ticket's model", () => {
    const { db, itemId } = setup("plc-run-choice-exec-");
    const id = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "claude", effort: "high", trigger: "test", idempotencyKey: "exec",
    });
    expect(request(db, id)).toEqual({ runtime: "claude", model: "opus", effort: "high" });
  });

  it("keeps the effort of the last run of the same kind for a rework", () => {
    const { db, itemId } = setup("plc-run-choice-rework-");
    const first = createRun(db, { itemId, runtime: "claude", model: "opus", effort: "xhigh" });
    updateRun(db, first, { state: "finished", endedAt: true });
    const id = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "claude", trigger: "rework", idempotencyKey: "rework",
    });
    expect(request(db, id)).toEqual({ runtime: "claude", model: "opus", effort: "xhigh" });
  });

  it("keeps the model of a session it resumes on the same runtime", () => {
    const { db, itemId } = setup("plc-run-choice-resume-");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex", model: "gpt-6.1-sol", effort: "high" });
    updateRun(db, reviewer, { state: "failed", endedAt: true });
    const id = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex", resumeFromRunId: reviewer, trigger: "retry", idempotencyKey: "resume",
    });
    expect(request(db, id)).toEqual({ runtime: "codex", model: "gpt-6.1-sol", effort: "high" });
  });
});

// 审查 L7（工单 09 留下的，工单 08 修）：核查员设置里的强度是给设置里的模型选的。以前 runEffortFor 只看 runtime，
// 设置是 opus/max、这次点名 sonnet 时也带上 max。Lead 建单时选的核查员也记一条 execution_profile_selected，
// 它是 effort 的最后一个来源，同样要看模型。
describe("the reviewer's effort follows the reviewer's model (review L7)", () => {
  function reviewTicket(prefix: string) {
    const { db, itemId } = setup(prefix);
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    setReviewerSetting(db, itemId, { runtime: "claude", model: "opus", effort: "max", chosenBy: "lead" });
    addActivity(db, {
      itemId, actor: "lead", kind: "decision",
      payload: { decision: "execution_profile_selected", role: "reviewer", runtime: "claude", model: "opus", effort: "max" },
    });
    return { db, itemId };
  }

  it("does not carry the setting's effort to another model named for this run", () => {
    const { db, itemId } = reviewTicket("plc-run-choice-l7-");
    const id = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "claude", model: "sonnet", trigger: "test", idempotencyKey: "named",
    });
    // 旧代码：effort='max'，sonnet 不认这一档。
    expect(request(db, id)).toEqual({ runtime: "claude", model: "sonnet", effort: null });
  });

  it("keeps the setting's effort for the setting's model", () => {
    const { db, itemId } = reviewTicket("plc-run-choice-l7-same-");
    const id = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "claude", trigger: "test", idempotencyKey: "setting",
    });
    expect(request(db, id)).toEqual({ runtime: "claude", model: "opus", effort: "max" });
  });

  it("decides at runEffortFor: the reviewer's effort only with the reviewer's model", () => {
    const { db, itemId } = reviewTicket("plc-run-choice-l7-unit-");
    const reviewer = { runtime: "claude" as const, model: "opus", effort: "max" };
    const effort = (model: string) => runEffortFor(db, { itemId, role: "reviewer", purpose: "review", runtime: "claude", model, reviewer });
    expect(effort("opus")).toBe("max");
    expect(effort("sonnet")).toBeUndefined();
  });
});

// 工单 08：执行者换了模型和强度以后（set_run_profile 记下 afterRunId），续接更早的会话不再沿用那个会话的模型和强度。
describe("a newer choice of model and effort beats an older session", () => {
  it("does not let a resumed session from before the choice override it", () => {
    const { db, itemId } = setup("plc-run-choice-newer-");
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const old = createRun(db, { itemId, runtime: "claude", model: "opus", effort: "xhigh" });
    updateRun(db, old, { state: "finished", endedAt: true });
    db.prepare("UPDATE items SET requested_model='sonnet' WHERE id=?").run(itemId);
    addActivity(db, {
      itemId, actor: "user", kind: "decision",
      payload: { decision: "execution_profile_selected", role: "executor", runtime: "claude", model: "sonnet", effort: "low", afterRunId: old },
    });
    const resumedFrom = getRun(db, old)!;
    expect(runModelFor({
      role: "executor", runtime: "claude", item: getItem(db, itemId)!, resumedFrom, choice: runProfileChoice(db, itemId, "executor"),
    })).toBe("sonnet");
    expect(runEffortFor(db, { itemId, role: "executor", purpose: "execution", runtime: "claude", model: "sonnet", resumedFrom }))
      .toBe("low");
    // 换了之后又跑过的 Run（例如恢复时又换了模型）是更新的选择，照常沿用。
    const newer = createRun(db, { itemId, runtime: "claude", model: "haiku", effort: "high" });
    const later = getRun(db, newer)!;
    expect(runModelFor({
      role: "executor", runtime: "claude", item: getItem(db, itemId)!, resumedFrom: later, choice: runProfileChoice(db, itemId, "executor"),
    })).toBe("haiku");
    expect(runEffortFor(db, { itemId, role: "executor", purpose: "execution", runtime: "claude", model: "haiku", resumedFrom: later }))
      .toBe("high");
  });
});
