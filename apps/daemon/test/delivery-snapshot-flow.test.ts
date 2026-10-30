// 交付快照的完整流程（工单 04，spec 5.5、D8）。Seam 1：真实 SQLite、真实 child manager（runItem）、Lead 的真实启动入口，
// runtime 是回放。执行 agent 在隔离 worktree 里提交、交付（成果从输出里恢复，Run 结束时存快照）；用户在工单对话里让 agent
// 顺手改了一处并提交（对话 Run 结束时再存一份）；之后 worktree 和分支都清掉，交付视图和 Lead 照样能读到交付了什么。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conversationWorkspaceChecksSettled, deliverySnapshotsSettled, ticketDeliveries, ticketDelivery, ticketDeliverySnapshot,
} from "@pi-lead-child/engine";
import { createLeadTools, routeTicketMessageToAgentRun, runningChildren, spawnItemChild, type LeadDeps } from "@pi-lead-child/lead";
import { ClaudeRuntime, RuntimeRegistry } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeCapabilities, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { createItem, getItem, listDeliverySnapshotHeaders, listWorkspaces, openDb, type Db } from "@pi-lead-child/store";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { tempDir } from "@pi-lead-child/core/testing";

const SESSION = "claude-session-delivery";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function commitIn(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=a@b.test", "-c", "user.name=agent", "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

// 交接工具调用丢了回执，最后一条消息带着成果信封：Run 结束时由系统登记成果、把工单推进 review。
function deliveryRecoveredFromOutput(): RecordedEvent[] {
  const envelope = `PLC_OUTCOME_V1 ${JSON.stringify({
    summary: "写了方案。",
    changes: [{ kind: "file", ref: "docs/plan.md", summary: "新增方案文档" }],
    deliverables: [],
    validations: [{ command: "人工核对", outcome: "passed", exitCode: null, summary: "通过", evidenceRef: null }],
  })}`;
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
    { type: "tool.started", callId: "c-1", name: "mcp__plc__ticket_update", args: { status: "review" } },
    { type: "tool.failed", callId: "c-1", name: "mcp__plc__ticket_update", error: "socket closed" },
    { type: "message.completed", messageId: "m-1", role: "assistant", stopReason: "end_turn", text: `写完了。\n\n${envelope}` },
    { type: "run.completed", exitCode: 0 },
  ];
}

function conversationAnswer(text: string): RecordedEvent[] {
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
    { type: "message.completed", messageId: "m-c", role: "assistant", stopReason: "end_turn", text },
    { type: "run.completed", exitCode: 0 },
  ];
}

class ScriptedRuntime implements AgentRuntime {
  readonly id = "claude" as const;
  readonly capabilities: RuntimeCapabilities = { ...new ClaudeRuntime().capabilities, resume: true };
  // 回放之前在 Run 的工作目录里做的事：agent 改文件、提交。
  onStart?: (request: RuntimeStartRequest) => void;

  constructor(private readonly recordings: RecordedEvent[][]) {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.onStart?.(request);
    const events = this.recordings.shift();
    if (!events) throw new Error(`no recording left for run #${request.runId}`);
    return new ReplayRuntime({ runtime: "claude", events }).start(request);
  }
}

let db: Db;
let dir: string;

beforeEach(() => {
  dir = tempDir("plc-delivery-flow-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(join(dir, "plc.db"));
});

async function settled(): Promise<void> {
  while (runningChildren().size > 0) await Promise.allSettled([...runningChildren().values()]);
  await conversationWorkspaceChecksSettled();
  await deliverySnapshotsSettled();
}

afterEach(async () => {
  await settled();
  db.close();
});

describe("the delivery snapshot through the child manager", () => {
  it("stores the delivery when the run ends, another snapshot after a chat commits, and keeps both after cleanup", async () => {
    // 仓库在 PLC 数据目录之外。worktree 建在仓库旁边（<repo>.plc-workspaces），所以仓库放在临时目录的下一层。
    const repo = join(tempDir("plc-delivery-flow-repo-"), "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "readme\n");
    commitIn(repo, "base");
    const runtime = new ScriptedRuntime([deliveryRecoveredFromOutput(), conversationAnswer("改好了，提交了。")]);
    const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeRegistry: new RuntimeRegistry([runtime]) };
    const itemId = createItem(db, { title: "写方案", brief: "写一份方案", createdBy: "user", runtime: "claude", workdir: repo });

    // 执行 agent 在自己的 worktree 里写方案、提交，然后交付。
    const workdirs: string[] = [];
    runtime.onStart = (request) => {
      workdirs.push(request.workdir);
      mkdirSync(join(request.workdir, "docs"), { recursive: true });
      writeFileSync(join(request.workdir, "docs", "plan.md"), "# 方案\n\n第一行\n");
      commitIn(request.workdir, "docs: plan");
    };
    spawnItemChild(deps, itemId, {});
    await settled();
    expect(getItem(db, itemId)?.stage).toBe("review");
    const [workspace] = listWorkspaces(db, { ownerItemId: itemId }).filter((row) => row.kind === "isolated_child");
    expect(workspace?.path).toBe(workdirs[0]);
    const executor = db.prepare("SELECT id FROM runs WHERE item_id=? AND purpose='execution'").get(itemId) as { id: number };
    expect(listDeliverySnapshotHeaders(db, itemId).map((row) => [row.sequence, row.revision, row.reason, row.backfilled, row.executorRunId]))
      .toEqual([[1, 1, "delivered", false, executor.id]]);

    // 用户在工单对话里说「顺手加一行」：对话 Run 在同一个 worktree 里改了并提交。
    runtime.onStart = (request) => {
      writeFileSync(join(request.workdir, "docs", "plan.md"), "# 方案\n\n第一行\n第二行\n");
      commitIn(request.workdir, "docs: one more line");
    };
    const chat = routeTicketMessageToAgentRun(deps, { itemId, message: "顺手在方案里加一行" });
    expect(chat.purpose).toBe("conversation");
    await settled();
    expect(listDeliverySnapshotHeaders(db, itemId).map((row) => [row.sequence, row.revision, row.reason, row.triggerRunId, row.triggerKind]))
      .toEqual([[1, 1, "delivered", null, null], [1, 2, "workspace_changed", chat.runId, "conversation"]]);

    // 工作区清理：worktree 和分支都删掉。
    git(repo, "worktree", "remove", "--force", workspace!.path);
    git(repo, "branch", "-D", workspace!.branch!);
    db.prepare("UPDATE workspaces SET state='archived' WHERE id=?").run(workspace!.id);

    const view = await ticketDelivery(db, itemId);
    expect(view.files.map((file) => [file.path, file.status, file.additions, file.note])).toEqual([
      ["docs/plan.md", "added", 4, "新增方案文档"],
    ]);
    expect(await ticketDeliveries(db, itemId)).toMatchObject([{ sequence: 1, attemptId: executor.id, revisions: 2 }]);
    expect((await ticketDeliverySnapshot(db, itemId, 1, 1)).files.map((file) => file.additions)).toEqual([3]);
    const lead = createLeadTools(deps).find((tool) => tool.name === "get_ticket")!;
    const text = (await lead.execute("t", { id: itemId } as never, undefined, undefined, undefined as never)).content[0];
    expect(text).toMatchObject({ type: "text", text: expect.stringContaining("- docs/plan.md（新增，+4 −0）：新增方案文档") });
  });
});
