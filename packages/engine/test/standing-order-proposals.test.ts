// Lead 提议的常设指令修改是一条没有工单的审批（工单 10）。coordinator 的 resolveApproval 同时接 Lead 的 resolve_approval
// 和 Slack 按钮，它不能批这类审批：只有网关的 /v1/standing-order-proposals 路由（用户）能决定。过期时告诉 Lead。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  getApproval, getStandingOrder, listInbox, openDb, proposeStandingOrderChange, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator, InterventionConflictError } from "../src/index.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-standing-order-proposals-"), "plc.db"));
});

function proposePermissive(): number {
  const result = proposeStandingOrderChange(db, { op: "disable", id: "notification.immediate", reason: "我自己会看" });
  if (result.outcome !== "pending_approval") throw new Error(result.outcome);
  return result.proposal.approvalId;
}

describe("standing order proposals in the coordinator", () => {
  it("refuses to resolve a proposal, whoever claims to be the user", () => {
    const approvalId = proposePermissive();
    const coordinator = createCoordinator({ db });
    for (const resolvedBy of ["user via companion", "user via slack:U123"]) {
      expect(() => coordinator.resolveApproval({ approvalId, decision: "approve", actor: { kind: "user", resolvedBy } }))
        .toThrow(InterventionConflictError);
    }
    expect(getApproval(db, approvalId)?.status).toBe("pending");
    expect(getStandingOrder(db, "notification.immediate")).toMatchObject({ version: 1, status: "active" });
  });

  it("expires a proposal with the other approvals and tells Lead it did not take effect", () => {
    const approvalId = proposePermissive();
    const coordinator = createCoordinator({ db });
    const { approvalIds } = coordinator.expireInterventions(new Date(Date.now() + 25 * 3_600_000));
    expect(approvalIds).toEqual([approvalId]);
    expect(getApproval(db, approvalId)?.status).toBe("expired");
    const note = listInbox(db, { state: ["pending"] }).find((row) => row.dedup_scope === `standing-order-proposal:${approvalId}`);
    expect(note?.summary).toContain("没有生效");
    expect(getStandingOrder(db, "notification.immediate")?.version).toBe(1);
  });
});
