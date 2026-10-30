// 结构化验收标准的完整流程（工单 05，spec 4.3、5.1、5.11、D5、D6）。Seam：真实 SQLite、真实 child manager（runItem）、
// Lead 的真实工具、网关的真实 HTTP 入口，runtime 是回放。
//   1. Lead 建单时写下验收标准；执行 agent 的提示里逐条编号。
//   2. 交付（成果从输出里恢复），Run 结束时存交付快照（04）。
//   3. 你在页面上确认第一条；Lead 在你这一轮代你确认第二条；Lead 改了第一条，你对它的确认作废，页面和 Lead 都看得出。
//   4. 关掉、重新打开库：都还在。
//   5. 打回返工，第 2 次交付从头开始；第 1 次交付的确认还能切回去看。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationWorkspaceChecksSettled, createOrchestrator, deliverySnapshotsSettled } from "@pi-lead-child/engine";
import { createControlPlaneService, createUserActionService, startPairedServer } from "@pi-lead-child/gateway";
import { createLeadTools, runningChildren, spawnClaimedItem, spawnItemChild, type LeadDeps } from "@pi-lead-child/lead";
import { ClaudeRuntime, RuntimeRegistry } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeCapabilities, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import {
  createLoopbackBinding, createPairing, createTurn, getItem, listAcceptanceCriteria, listDeliverySnapshotHeaders, openDb,
  redeemPairing, type Db,
} from "@pi-lead-child/store";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { tempDir } from "@pi-lead-child/core/testing";
import type { TicketAcceptanceCriteria } from "@pi-lead-child/protocol";

const SESSION = "claude-session-criteria";

// 交接工具调用丢了回执，最后一条消息带着成果信封：Run 结束时由系统登记成果、把工单推进 review。
function deliveryFromOutput(summary: string): RecordedEvent[] {
  const envelope = `PLC_OUTCOME_V1 ${JSON.stringify({
    summary, changes: [], deliverables: [],
    validations: [{ command: "npm test", outcome: "passed", exitCode: 0, summary: "通过", evidenceRef: null }],
  })}`;
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
    { type: "tool.started", callId: "c-1", name: "mcp__plc__ticket_update", args: { status: "review" } },
    { type: "tool.failed", callId: "c-1", name: "mcp__plc__ticket_update", error: "socket closed" },
    { type: "message.completed", messageId: "m-1", role: "assistant", stopReason: "end_turn", text: `做完了。\n\n${envelope}` },
    { type: "run.completed", exitCode: 0 },
  ];
}

class ScriptedRuntime implements AgentRuntime {
  readonly id = "claude" as const;
  readonly capabilities: RuntimeCapabilities = { ...new ClaudeRuntime().capabilities, resume: true };
  readonly prompts: string[] = [];

  constructor(private readonly recordings: RecordedEvent[][]) {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.prompts.push(request.prompt);
    const events = this.recordings.shift();
    if (!events) throw new Error(`no recording left for run #${request.runId}`);
    return new ReplayRuntime({ runtime: "claude", events }).start(request);
  }
}

let db: Db;
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = tempDir("plc-criteria-flow-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(dbPath);
});

async function settled(): Promise<void> {
  while (runningChildren().size > 0) await Promise.allSettled([...runningChildren().values()]);
  await conversationWorkspaceChecksSettled();
  await deliverySnapshotsSettled();
}

// 打开的页面（网关）：先关它们，再关库，免得网关的推送定时器读一个已经关掉的库。
const pages: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await settled();
  for (const opened of pages.splice(0)) await opened.close();
  db.close();
});

function runtimeStatus() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function page(database: Db) {
  const server = await startPairedServer({
    db: database,
    controlPlane: createControlPlaneService(database, { runtime: runtimeStatus, now: () => new Date() }),
    userActions: createUserActionService({ db: database, resumeRun: () => {} }),
    hello: runtimeStatus,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  const token = redeemPairing(database, createPairing(database, {
    name: "web", kind: "companion", scopes: ["tickets:view", "tickets:create"],
  }).code).accessToken;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${server.port}/v1/tickets`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  pages.push({ close });
  return {
    close,
    async read(itemId: number, delivery?: number): Promise<TicketAcceptanceCriteria> {
      const response = await fetch(`${base}/${itemId}/acceptance-criteria${delivery ? `?delivery=${delivery}` : ""}`, { headers });
      expect(response.status).toBe(200);
      return (await response.json() as { acceptanceCriteria: TicketAcceptanceCriteria }).acceptanceCriteria;
    },
    async act(itemId: number, action: string, input: Record<string, unknown> = {}, reason?: string): Promise<number> {
      const response = await fetch(`${base}/${itemId}/actions/${action}`, {
        method: "POST", headers, body: JSON.stringify({ input, ...(reason ? { reason } : {}) }),
      });
      return response.status;
    },
  };
}

const states = (view: TicketAcceptanceCriteria) =>
  view.criteria.map((row) => [row.number, row.changedAfterDelivery, row.confirmation?.state ?? null, row.confirmation?.by ?? null]);

describe("acceptance criteria from creation to the second delivery", () => {
  it("numbers them for the executor, keeps confirmations per delivery and voids an edited one, across a reopen", async () => {
    const runtime = new ScriptedRuntime([deliveryFromOutput("修好了空输入。"), deliveryFromOutput("补上了错误码。")]);
    let turnId: string | null = null;
    const deps = (database: Db): LeadDeps => ({
      db: database, dbPath, dataDir: dir, runtimeRegistry: new RuntimeRegistry([runtime]), currentTurnId: () => turnId,
    });
    const leadCall = async (database: Db, name: string, params: Record<string, unknown>) => {
      const tool = createLeadTools(deps(database)).find((candidate) => candidate.name === name)!;
      const result = await tool.execute("call", params as never, undefined, undefined, undefined as never);
      return (result.content[0] as { text: string }).text;
    };

    // 1. Lead 建单时写下验收标准。
    const created = await leadCall(db, "create_task", {
      title: "修复空输入", brief: "解析器遇到空输入会崩。", runtime: "claude",
      acceptance_criteria: ["空输入返回 400", "错误信息写明字段名", "补回归测试"],
    });
    const itemId = Number(/#(\d+)/.exec(created)![1]);
    const [first, second] = listAcceptanceCriteria(db, itemId);

    // 2. 执行 agent 的提示里逐条编号；交付以后存下快照。
    spawnItemChild(deps(db), itemId, {});
    await settled();
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(runtime.prompts[0]).toContain("## 验收标准（系统记录，逐条编号）");
    expect(runtime.prompts[0]).toContain(`1. （id ${first!.id}）"空输入返回 400"`);
    expect(runtime.prompts[0]).toContain("3. （id ");
    expect(listDeliverySnapshotHeaders(db, itemId).map((row) => [row.sequence, row.reason])).toEqual([[1, "delivered"]]);

    // 3. 你确认第一条；Lead 在你这一轮代你确认第二条；Lead 改了第一条。
    let web = await page(db);
    expect(await web.act(itemId, "confirm_criterion", { criterionId: first!.id, deliverySequence: 1 })).toBe(200);
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    turnId = createTurn(db, { id: "turn-1", originBindingId: binding.id, originKind: "paired:companion", userText: "第二条也看过了", state: "streaming" }).id;
    expect(JSON.parse(await leadCall(db, "ticket_action", {
      ticket_id: itemId, action: "confirm_criterion", input: { criterionId: second!.id }, reason: "用户说第二条也看过了",
    }))).toMatchObject({ authority: "on_behalf", on_behalf_of_turn: "turn-1" });
    turnId = null;
    await leadCall(db, "ticket_action", {
      ticket_id: itemId, action: "edit_acceptance_criteria", reason: "用户补充：还要返回错误码",
      input: { update: [{ id: first!.id, text: "空输入返回 400 和错误码 EMPTY_INPUT" }] },
    });
    const afterEdit = await web.read(itemId);
    expect(states(afterEdit)).toEqual([[1, "edited", "voided", "user"], [2, null, "confirmed", "lead"], [3, null, null, null]]);
    expect(afterEdit.criteria[1]!.confirmation).toMatchObject({ onBehalfOf: "user" });
    const leadView = (await leadCall(db, "get_ticket", { id: itemId })).split("--- 验收标准 ---")[1]!.split("\n---")[0]!;
    expect(leadView).toContain("用户确认了 1/3");
    expect(leadView).toContain(`1. [后来改过：用户的确认已作废]（id ${first!.id}，第 2 版）"空输入返回 400 和错误码 EMPTY_INPUT"`);
    await web.close();

    // 4. 关掉、重新打开库。
    db.close();
    db = openDb(dbPath);
    web = await page(db);
    expect(states(await web.read(itemId))).toEqual(states(afterEdit));

    // 5. 打回返工，第 2 次交付从头开始。执行 agent 看到的是改过的标准。
    expect(await web.act(itemId, "rework", {}, "第一条要返回错误码")).toBe(200);
    const reopened = db;
    await createOrchestrator(reopened, { dataDir: dir, onDispatch: (claim) => { spawnClaimedItem(deps(reopened), claim); } }).tick();
    await settled();
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(runtime.prompts[1]).toContain(`1. （id ${first!.id}）"空输入返回 400 和错误码 EMPTY_INPUT"`);
    const latest = await web.read(itemId);
    expect(latest.delivery).toMatchObject({ sequence: 2, latest: true });
    expect(states(latest)).toEqual([[1, null, null, null], [2, null, null, null], [3, null, null, null]]);
    expect(latest.confirmed).toBe(0);
    const history = await web.read(itemId, 1);
    expect(history.delivery).toMatchObject({ sequence: 1, latest: false });
    expect(states(history)).toEqual(states(afterEdit));
    await web.close();
  });
});
