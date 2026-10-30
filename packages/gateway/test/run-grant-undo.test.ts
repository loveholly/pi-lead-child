// 撤销「放宽子 agent 的权限」（主人操作 run.grant）：只删掉这一次加上的规则，之后又放宽的不动；撤销记成账本里的
// 一条 reverted；撤销过的再点一次不再改。子 agent 的写操作（connection.agent_write）撤不回：给出链接，不作废任何凭证。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runTicketAction } from "@pi-lead-child/engine";
import { checkGrantCall, computeRunGrant, DEFAULT_INTENT_GRANT_BOUNDS } from "@pi-lead-child/protocol";
import {
  createCliBinding, createItem, createPairing, createRun, getRunGrant, insertRunGrant, listRunGrantChanges, openDb, recordOwnerAction,
  redeemPairingById, updateRun,
  type Db, type EventRecord,
} from "@pi-lead-child/store";
import { disownOwnerAction, revertOwnerAction } from "../src/owner-actions.js";

const PR = { owner: "Acme", repo: "x", number: 101 };
let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-run-grant-undo-"), "plc.db"));
});

function channelTicket(): { itemId: number; runId: number } {
  const itemId = createItem(db, { title: "通道派的工单", brief: "b", createdBy: "system", purpose: "lookup" });
  const runId = createRun(db, { itemId, purpose: "lookup" });
  updateRun(db, runId, { state: "running" });
  const { grant } = computeRunGrant({ intent: "code_review", scope: { pullRequest: PR }, resolveLocalRepo: () => null });
  insertRunGrant(db, { itemId, runId, grant, bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review, scope: { pullRequest: PR } });
  return { itemId, runId };
}

async function widen(itemId: number, scope: Record<string, unknown>): Promise<EventRecord> {
  const outcome = await runTicketAction(db, { itemId, action: "widen_grant", input: { scope }, caller: { kind: "user" } });
  const result = outcome.result as { runId: number; changeId: number; added: string[] };
  const { binding } = createCliBinding(db, { name: "plc" });
  return recordOwnerAction(db, {
    action: "run.grant", target: { key: `run:${result.runId}`, label: `Run #${result.runId}`, ticketId: itemId },
    summary: `放宽了 Run #${result.runId} 的权限：${result.added.join("；")}`,
    undo: { kind: "run_grant", runId: result.runId, changeId: result.changeId },
    credential: binding, source: { client: "cli", deviceName: "plc", loopback: true, fromThisMachine: true },
  }).event;
}

const deps = () => ({ db, publish: () => {}, log: () => {} });
const approve = { connection: "github", tool: "pull_request_review_write", readOnly: false,
  facts: { owner: "Acme", repo: "x", pullNumber: 101, method: "submit_pending", event: "APPROVE" } };

describe("undoing a widened grant", () => {
  it("removes only the rules that widening added, and records the revert", async () => {
    const { itemId, runId } = channelTicket();
    const first = await widen(itemId, { pullRequest: PR, reviewEvents: ["APPROVE"] });
    await widen(itemId, { connections: ["cdp"] });
    expect(checkGrantCall(getRunGrant(db, runId)!.grant, approve).ok).toBe(true);

    const result = await revertOwnerAction(deps(), first, "测试");
    expect(result).toEqual({ status: "reverted", message: expect.stringContaining("只在 Acme/x#101 上可以 APPROVE") });
    const grant = getRunGrant(db, runId)!.grant;
    expect(checkGrantCall(grant, approve).ok).toBe(false);
    expect(grant.rules.map((rule) => rule.label)).toContain("只读 cdp");
    expect(listRunGrantChanges(db, runId).map((change) => change.change)).toEqual(["created", "widened", "widened", "reverted"]);

    expect(await revertOwnerAction(deps(), first, "测试")).toMatchObject({ status: "unchanged" });
  });

  it("explains that a sub-agent's write has already reached GitHub, links it, and revokes no credential", async () => {
    const url = "https://github.com/Acme/x/pull/101";
    const event = recordOwnerAction(db, {
      action: "connection.agent_write", target: { key: "run:1", label: "Run #1" },
      summary: "Lead 派的子 agent 代你在 Acme/x#101 上提交了 review（COMMENT）",
      undo: { kind: "connection_write", runId: 1, callId: 3, connection: "github", tool: "pull_request_review_write", url },
      credential: { id: 0, kind: "agent", display_name: "工单 #1", origin: "unknown" },
      source: { client: "agent", deviceName: "工单 #1", loopback: false, fromThisMachine: true },
    }).event;
    expect(await revertOwnerAction(deps(), event, "测试")).toEqual({ status: "executed", message: expect.stringContaining(url) });
    const { pairingId } = createPairing(db, { name: "我的手机", kind: "companion", origin: "web_invitation" });
    const phone = redeemPairingById(db, pairingId, { peerIsThisMachine: false }).binding;
    const view = await disownOwnerAction(deps(), event.eventId, phone);
    expect(view.disowned).toMatchObject({ revert: { status: "executed" }, credential: { bindingId: 0, revoked: false } });
  });
});
