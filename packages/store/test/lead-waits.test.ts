// Lead 的等待（2026-10-19，store 的 lead-waits.ts）：Lead 在等用户的下一步，用户做了，系统写一条 tell 级事件叫醒它。
// 审查时的两次漏叫醒：
//   · 工单 #98：Lead 等用户重新授权 GitHub。17:05 授权完成（connection_events 写了 connected），事件日志里什么都没有，Lead 没醒。
//   · 工单 #85：Lead 等用户点确认卡，用户改点「验收」「委托给 Lead」。主人操作对 Lead 一律跳过，Lead 没醒。
// 用户的意见：没有人在等时，主人操作只记日志；Lead 在等时，那个操作必须叫醒它。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { userActionRequest, type OwnerActionId, type OwnerActionSource } from "@pi-lead-child/protocol";
import {
  addInbox, appendEvent, createCliBinding, expireLeadWaits, getConnection, getLeadWait, insertConnection, listEvents, listOpenLeadWaits,
  openDb, purgeLeadWaits, recordOwnerAction, registerLeadWait, updateConnection, type Db,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-waits-"), "plc.db"));
});

afterEach(() => {
  vi.useRealTimers();
});

// 固定时钟（只换 Date）：事件的 received_at 和等待的登记时间都取它，两次写入落在哪一毫秒由测试决定。
function clockAt(iso: string): (ms: number) => void {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse(iso);
  vi.setSystemTime(start);
  return (ms) => vi.setSystemTime(start + ms);
}

const fromWeb: OwnerActionSource = { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true };

function ownerAction(action: OwnerActionId, target: { key: string; label: string; ticketId: number | null }) {
  const { binding } = createCliBinding(db, { name: "plc" });
  return recordOwnerAction(db, { action, target, summary: `${action} ${target.label}`, credential: binding, source: fromWeb });
}

const waitEvents = (kind: "lead.wait_satisfied" | "lead.wait_expired") => listEvents(db, { kind, limit: 100 });

describe("a wait on a connection (ticket #98)", () => {
  it("ends when the user re-authorizes, and hands Lead its note and what happened", () => {
    const row = insertConnection(db, { provider: "github", label: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/", tokenSource: "gh_cli" });
    updateConnection(db, row.id, { status: "needs_reauth", failure_detail: "invalid_grant" });
    const action = userActionRequest({ kind: "reauthorize", target: "connection:github", title: "重新授权 GitHub", reason: "授权失效了" });
    const { wait } = registerLeadWait(db, {
      entityKey: "connection:github", note: "授权完成后发 PR #101 的行内评论", origin: "tool:call_connection_tool", userAction: action,
    });

    // 用户在设置页完成授权：hub 把状态改成 connected（hub.ts 的 #saveConnected 也走 updateConnection）。
    updateConnection(db, row.id, { status: "connected" });

    const [changed] = listEvents(db, { kind: "connection.status_changed", order: "desc", limit: 1 });
    expect(changed).toMatchObject({ entityKey: "connection:github", level: "record", payload: { from: "needs_reauth", to: "connected" } });
    const [woke] = waitEvents("lead.wait_satisfied");
    expect(woke).toMatchObject({
      level: "tell",
      entityKey: "connection:github",
      payload: {
        waitId: wait.id, note: "授权完成后发 PR #101 的行内评论", userAction: action, mustTell: false,
        trigger: { seq: changed!.seq, kind: "connection.status_changed", summary: expect.stringContaining("已连接") },
      },
    });
    expect(getLeadWait(db, wait.id)).toMatchObject({ state: "satisfied", resolvedBySeq: changed!.seq });
    expect(listOpenLeadWaits(db)).toEqual([]);
  });

  // 2026-10-19 审查：状态变化的事件写不成时，不能连带回滚连接状态的写入（以前用的是严格模式的 appendEvent）。
  it("still saves the connection's status when its event cannot be written", () => {
    // provider 为空：对象键写成 connection:，不合格，事件校验不过。
    const row = insertConnection(db, { provider: "", label: "坏数据", serverUrl: "https://example.test/broken", tokenSource: "pat" });
    expect(() => updateConnection(db, row.id, { status: "connected" })).not.toThrow();
    expect(getConnection(db, row.id)?.status).toBe("connected");
    expect(listEvents(db, { kind: "system.event_rejected" })).toMatchObject([{ payload: { rejectedKind: "connection.status_changed" } }]);
  });

  it("does not wake anyone for a status change nobody waits for", () => {
    const row = insertConnection(db, { provider: "github", label: "GitHub", serverUrl: "https://example.test/mcp", tokenSource: "gh_cli" });
    updateConnection(db, row.id, { status: "connected" });
    expect(listEvents(db, { kind: "connection.status_changed" })).toHaveLength(1);
    expect(waitEvents("lead.wait_satisfied")).toEqual([]);
  });
});

describe("a wait on a ticket (ticket #85)", () => {
  it("is not needed for an owner action to stay a log line", () => {
    ownerAction("ticket.complete", { key: "ticket:85", label: "工单 #85", ticketId: 85 });
    expect(waitEvents("lead.wait_satisfied")).toEqual([]);
  });

  it("ends when the user accepts or delegates the ticket, or handles an approval on it", () => {
    const first = registerLeadWait(db, { entityKey: "ticket:85", note: "等用户点确认卡", origin: "lead" }).wait;
    ownerAction("lead.delegation", { key: "ticket:85", label: "工单 #85", ticketId: 85 });
    expect(waitEvents("lead.wait_satisfied").map((event) => event.payload.waitId)).toEqual([first.id]);

    // 对这张工单的一条审批做了处理：对象键是 approval:3，但它挂在工单 #85 上，等工单的等待也了结。
    const second = registerLeadWait(db, { entityKey: "ticket:85", note: "等用户处理审批", origin: "lead" }).wait;
    ownerAction("approval.resolve", { key: "approval:3", label: "审批 #3", ticketId: 85 });
    expect(waitEvents("lead.wait_satisfied").map((event) => event.payload.waitId)).toEqual([first.id, second.id]);
  });

  // 只有系统叫醒 Lead 的 inbox 说明才算「已经告诉过 Lead」。主人操作也是 interrupt 级，但 Lead 收不到它：
  // 用户刚点过一次以后 Lead 才登记等待，下一次点击照样叫醒 Lead。
  it("still wakes Lead for the user's next click shortly after an earlier owner action", () => {
    ownerAction("ticket.complete", { key: "ticket:85", label: "工单 #85", ticketId: 85 });
    const { wait } = registerLeadWait(db, { entityKey: "ticket:85", note: "等用户委托", origin: "lead" });
    ownerAction("lead.delegation", { key: "ticket:85", label: "工单 #85", ticketId: 85 });
    expect(waitEvents("lead.wait_satisfied")).toMatchObject([{ level: "tell", payload: { waitId: wait.id, coveredBySeq: null } }]);
  });

  it("is not ended by a stage change Lead made itself", () => {
    const { wait } = registerLeadWait(db, { entityKey: "ticket:85", note: "等用户验收", origin: "lead" });
    const stage = (actor: string) => db.transaction(() => appendEvent(db, {
      source: "ticket", kind: "stage.changed", entityKey: "ticket:85",
      payload: { itemId: 85, itemKind: "task", from: "active", to: "review", actor, reason: "test" },
    }))();
    stage("lead");
    expect(getLeadWait(db, wait.id)?.state).toBe("waiting");
    stage("user");
    expect(getLeadWait(db, wait.id)?.state).toBe("satisfied");
  });
});

describe("registering, expiring and cleaning up waits", () => {
  it("merges a second wait on the same object into the open one", () => {
    const now = new Date("2026-10-19T09:00:00Z");
    const first = registerLeadWait(db, { entityKey: "ticket:9", note: "旧备注", origin: "lead", timeoutMs: 60 * 60_000, now });
    const second = registerLeadWait(db, {
      entityKey: "ticket:9", note: "新备注", origin: "tool:x", mustTell: true, timeoutMs: 10 * 60_000, now,
    });
    expect(second).toMatchObject({ created: false, wait: { id: first.wait.id, note: "新备注", mustTell: true } });
    // 超时取更晚的那个。
    expect(second.wait.expiresAt).toBe(first.wait.expiresAt);
    expect(listOpenLeadWaits(db)).toHaveLength(1);
  });

  it("hands Lead an expired wait once, and purges resolved rows after a week", () => {
    const start = new Date("2026-10-19T09:00:00Z");
    const { wait } = registerLeadWait(db, { entityKey: "daemon:main", note: "重启完成后告诉用户", origin: "tool:request_runtime_maintenance", mustTell: true, timeoutMs: 5 * 60_000, now: start });
    expect(expireLeadWaits(db, new Date(start.getTime() + 4 * 60_000))).toBe(0);
    expect(expireLeadWaits(db, new Date(start.getTime() + 5 * 60_000))).toBe(1);
    expect(expireLeadWaits(db, new Date(start.getTime() + 6 * 60_000))).toBe(0);
    expect(waitEvents("lead.wait_expired")).toEqual([
      expect.objectContaining({ level: "tell", source: "timer", payload: expect.objectContaining({ waitId: wait.id, mustTell: true }) }),
    ]);
    expect(purgeLeadWaits(db, new Date(start.getTime() + 6 * 24 * 3_600_000))).toBe(0);
    expect(purgeLeadWaits(db, new Date(start.getTime() + 8 * 24 * 3_600_000))).toBe(1);
    expect(getLeadWait(db, wait.id)).toBeUndefined();
  });

  it("only records the end of a wait when a system event about the same thing already reaches Lead", () => {
    // 写入确认有了结果：daemon 写一条带结果的 inbox（叫醒 Lead），网关随后记主人操作。等待照样了结，但不再叫醒一次。
    // 用户点确认总在登记以后过一会儿；时钟固定，说明不会和登记落在同一毫秒（那样算作登记以前，见下面）。
    const at = clockAt("2026-10-20T08:00:00.000Z");
    const { wait } = registerLeadWait(db, { entityKey: "connection_confirmation:cfm_abcdefgh12", note: "等用户确认写入", origin: "tool:call_connection_tool" });
    at(20_000);
    addInbox(db, {
      dedupScope: "connection_confirmation:cfm_abcdefgh12", severity: "attention", source: "structural", lossless: true,
      summary: "用户允许了写入，已经执行", payload: { kind: "connection_confirmation", wakeLead: true, needsUser: false },
    });
    const [inbox] = listEvents(db, { kind: "inbox.attention", order: "desc", limit: 1 });
    expect(inbox?.level).toBe("tell");
    ownerAction("connection.confirm", { key: "connection_confirmation:cfm_abcdefgh12", label: "写入确认", ticketId: null });
    const [ended] = waitEvents("lead.wait_satisfied");
    expect(ended).toMatchObject({ level: "record", payload: { waitId: wait.id, coveredBySeq: inbox!.seq } });
  });
});

// 2026-10-20 verify 里 connection-attention 的用例时过时不过：期望 tell，有时是 record。
// 授权失效时 daemon 先写一条 inbox 说明（叫醒 Lead），紧接着登记等待（connection-attention.ts）。
// 两次写入落在同一毫秒时，以前的规则（received_at >= 登记时间）把这条说明算成「已经告诉过 Lead」，
// 用户重新授权只记一笔，Lead 没被叫醒。这条说明讲的是出了问题，不是问题解决了，不能覆盖等待的了结。
describe("which note already tells Lead that a wait ended", () => {
  function reauthNeeded() {
    const row = insertConnection(db, { provider: "github", label: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/", tokenSource: "gh_cli" });
    updateConnection(db, row.id, { status: "needs_reauth", failure_detail: "invalid_grant" });
    return row;
  }
  const causeNote = () => addInbox(db, {
    dedupScope: "connection:github", severity: "attention", source: "structural", summary: "GitHub 的授权失效了",
    payload: { kind: "connection_attention", connection: "github", attention: "needs_reauth", wakeLead: true, needsUser: false },
  });

  it.each([0, 1])("does not count the note that asked for the wait (%i ms between them)", (gapMs) => {
    const at = clockAt("2026-10-20T08:00:00.000Z");
    const row = reauthNeeded();
    causeNote();
    at(gapMs);
    const { wait } = registerLeadWait(db, { entityKey: "connection:github", note: "等用户重新授权", origin: "system:connection_attention" });
    // 半分钟后用户在设置页重新授权，Lead 还没处理那条说明。
    at(30_000);
    updateConnection(db, row.id, { status: "connected" });
    expect(waitEvents("lead.wait_satisfied")).toMatchObject([{ level: "tell", payload: { waitId: wait.id, coveredBySeq: null } }]);
  });

  // 时间只精确到毫秒，分不清先后时宁可多叫醒一次：和登记落在同一毫秒的说明算作登记以前。
  it("counts a note in the same millisecond as the registration as written before it", () => {
    const at = clockAt("2026-10-20T08:00:00.000Z");
    const { wait } = registerLeadWait(db, { entityKey: "connection_confirmation:cfm_abcdefgh12", note: "等用户确认写入", origin: "tool:call_connection_tool" });
    addInbox(db, {
      dedupScope: "connection_confirmation:cfm_abcdefgh12", severity: "attention", source: "structural", lossless: true,
      summary: "用户允许了写入，已经执行", payload: { kind: "connection_confirmation", wakeLead: true, needsUser: false },
    });
    at(20_000);
    ownerAction("connection.confirm", { key: "connection_confirmation:cfm_abcdefgh12", label: "写入确认", ticketId: null });
    expect(waitEvents("lead.wait_satisfied")).toMatchObject([{ level: "tell", payload: { waitId: wait.id, coveredBySeq: null } }]);
  });

  // 界线是最近一次登记：系统登记等待以后又写了一条授权失效的说明，并把等待再登记一次（合并）。
  // 这条说明还是引起等待的那件事，不能覆盖了结；合并以后写的说明才算。
  it("moves the line to the latest registration when a wait is registered again", () => {
    const at = clockAt("2026-10-20T08:00:00.000Z");
    const row = reauthNeeded();
    const { wait } = registerLeadWait(db, { entityKey: "connection:github", note: "等用户重新授权", origin: "tool:call_connection_tool" });
    at(5_000);
    causeNote();
    at(6_000);
    registerLeadWait(db, { entityKey: "connection:github", note: "等用户重新授权（系统）", origin: "system:connection_attention" });
    at(30_000);
    updateConnection(db, row.id, { status: "connected" });
    expect(waitEvents("lead.wait_satisfied")).toMatchObject([{ level: "tell", payload: { waitId: wait.id, coveredBySeq: null } }]);

    // 对照：再登记以后才写的说明（Lead 还没处理）讲的是这次了结，只记一笔。
    updateConnection(db, row.id, { status: "needs_reauth", failure_detail: "invalid_grant" });
    at(60_000);
    const second = registerLeadWait(db, { entityKey: "connection:github", note: "又要重新授权", origin: "system:connection_attention" }).wait;
    at(90_000);
    addInbox(db, {
      dedupScope: "connection:github", severity: "attention", source: "structural", lossless: true,
      summary: "GitHub 重新授权好了", payload: { kind: "connection_attention", wakeLead: true, needsUser: false },
    });
    const [after] = listEvents(db, { kind: "inbox.attention", order: "desc", limit: 1 });
    updateConnection(db, row.id, { status: "connected" });
    expect(waitEvents("lead.wait_satisfied")[1]).toMatchObject({ level: "record", payload: { waitId: second.id, coveredBySeq: after!.seq } });
  });
});

