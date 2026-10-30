// 现在能不能派出独立核查（2026-10-19，委托验收卡死的工单 #88、#89、#92、#93、#98）。
// 2026-10-20 起核查员不能用时换下一个（reviewer-choice.ts），所以只有所有 runtime 都不能用时才派不出去。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { defaultRuntimeProfile, typedFailure } from "@pi-lead-child/runtime";
import type { RuntimeId } from "@pi-lead-child/core";
import { createItem, createRun, openDb, recordProbeResult, recordRuntimeHealthFailure, type Db } from "@pi-lead-child/store";
import { reviewerAvailability } from "../src/pipeline/automatic-review.js";

// 测试按缺省的 reviewer 判断：去掉开发者环境里可能配置的 PLC_REVIEW_RUNTIME。
const configuredReviewer = process.env.PLC_REVIEW_RUNTIME;
beforeEach(() => {
  delete process.env.PLC_REVIEW_RUNTIME;
});
afterEach(() => {
  if (configuredReviewer === undefined) delete process.env.PLC_REVIEW_RUNTIME;
  else process.env.PLC_REVIEW_RUNTIME = configuredReviewer;
});

function accountDown(db: Db, runtime: RuntimeId = "codex"): number {
  const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
  const runId = createRun(db, { itemId, runtime });
  recordRuntimeHealthFailure(db, {
    profile: defaultRuntimeProfile(runtime), model: null, itemId, runId,
    failure: typedFailure("auth_required", { errorCode: "codex_error", message: "402 deactivated_workspace" }),
  });
  return (db.prepare("SELECT id FROM runtime_incidents ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
}

describe("reviewerAvailability", () => {
  it("names the reviewer runtime when it is healthy", () => {
    const db = openDb(join(tempDir("plc-reviewer-availability-"), "plc.db"));
    expect(reviewerAvailability(db)).toEqual({ available: true, runtime: "codex" });
    db.close();
  });

  // 2026-10-20：codex 的账号坏了，核查换给下一个能用的核查员，委托照样能闭环。
  it("names the next reviewer while codex's account is down", () => {
    const db = openDb(join(tempDir("plc-reviewer-availability-"), "plc.db"));
    accountDown(db);
    expect(reviewerAvailability(db)).toEqual({ available: true, runtime: "claude" });
    db.close();
  });

  it("says why no review can be dispatched when no runtime can review", () => {
    const db = openDb(join(tempDir("plc-reviewer-availability-"), "plc.db"));
    const incidentId = accountDown(db);
    accountDown(db, "claude");
    accountDown(db, "pi");
    const availability = reviewerAvailability(db);
    expect(availability).toMatchObject({ available: false, runtime: "codex" });
    expect(availability.available ? "" : availability.reason).toContain(`故障 #${incidentId}`);
    db.close();
  });

  // 探针通过就关闭故障（2026-10-20 去掉了金丝雀），核查员马上回到 codex。
  it("counts codex as available again once its probe passes", () => {
    const db = openDb(join(tempDir("plc-reviewer-availability-"), "plc.db"));
    const incidentId = accountDown(db);
    recordProbeResult(db, incidentId, { ok: true, detail: null, at: new Date() });
    expect(reviewerAvailability(db)).toEqual({ available: true, runtime: "codex" });
    db.close();
  });
});
