// 部署后的真实冒烟测试（2026-10-12，run 66）发现两个缺陷：
// 1. 工具桥的 socket 开在工单工作目录的 .plc 里。工作目录很长时，socket 路径超过
//    Unix socket 的长度上限（macOS 104 字节），listen 报 EINVAL，Run 起不来。
// 2. 这个失败发生在内核自己准备 Run 的阶段，runtime 根本没有启动，却被分类成
//    runtime_start_failed（runtime 作用域）。健康账本因此挂起了整个 Claude profile，别的工单也派不出去。
// 3. Run 在 runtime 报告启动之前失败时，内核把工单的工作区标成 failed。failed 的工作区不能再启动 Run，
//    所以故障恢复以后，内核的重试请求一直被 preflight 挂起（工单 79）。
// 这些测试经过真实的编排器 tick、dispatcher claim、runItem 和 SQLite。
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { provisionWorkspace } from "../src/coordinator/workspace.js";
import { createOrchestrator } from "../src/pipeline/orchestrator.js";
import { workspaceLaunchProblem } from "../src/pipeline/preflight.js";
import { ClaudeRuntime } from "@pi-lead-child/runtime";
import { typedFailure } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeEvent, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { resolveRuntimeIncident } from "@pi-lead-child/store";
import { createWorkspace, transitionWorkspace } from "@pi-lead-child/store";

// 一个最小的 agent：通过工具桥交接成果，然后正常结束。它能交接，就说明工具桥在 listen，而且连得上。
// mode 让它在启动前失败：spawn 抛错（找不到可执行文件），或者没有报告启动就报告认证失败。
class HandoffRuntime implements AgentRuntime {
  readonly id = "claude" as const;
  readonly capabilities = { ...new ClaudeRuntime().capabilities };
  readonly toolReplies: unknown[] = [];
  mode: "handoff" | "spawn-error" | "fail-before-start" = "handoff";

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    if (this.mode === "spawn-error") throw new Error("spawn claude ENOENT");
    const event = (seq: number, input: object) => ({
      ...input, runId: request.runId, seq, occurredAt: new Date().toISOString(),
    }) as RuntimeEvent;
    if (this.mode === "fail-before-start") {
      const error = "Failed to authenticate: OAuth session expired and could not be refreshed";
      return this.handle([event(1, {
        type: "run.failed", exitCode: 1, errorCode: "auth", error,
        failure: typedFailure("auth_required", { errorCode: "auth", message: error }),
      })], 1);
    }
    this.toolReplies.push(await this.handoff(request));
    return this.handle([
      event(1, { type: "run.started", runtime: "claude", model: null }),
      event(2, { type: "run.completed", exitCode: 0 }),
    ], 0);
  }

  private handle(events: RuntimeEvent[], exitCode: number): RuntimeHandle {
    return {
      pid: null,
      events: (async function* () { yield* events; })(),
      interrupt: async () => {},
      wait: async () => ({ exitCode, externalSessionId: null }),
    } as unknown as RuntimeHandle;
  }

  private handoff(request: RuntimeStartRequest): Promise<unknown> {
    const socketPath = request.env?.PLC_AGENT_TOOL_SOCKET;
    const token = request.env?.PLC_AGENT_TOOL_TOKEN;
    if (!socketPath || !token) return Promise.resolve({ success: false, error: "no tool bridge" });
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("error", reject);
      attachJsonlReader(socket, (line) => {
        if (!line.trim()) return;
        resolve(JSON.parse(line));
        socket.end();
      });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({
          type: "agent_tool", id: "handoff", token, name: "ticket_update",
          arguments: {
            status: "review",
            reason: "marker written",
            checkpoint: {
              kind: "completed", title: "Marker written", summary: "Wrote marker.txt.", next_step: "Review.",
              outcome: {
                summary: "Wrote marker.txt.",
                changes: [{ kind: "file", ref: "marker.txt", summary: "marker" }],
                deliverables: [{ kind: "path", ref: "marker.txt", label: "marker" }],
                validations: [],
              },
            },
          },
        })}\n`);
      });
    });
  }
}

function harness(runtime: AgentRuntime) {
  const dir = tempDir("plc-run-setup-");
  const dbPath = join(dir, "plc.db");
  const db = openDb(dbPath);
  const orchestrator = createOrchestrator(db, {
    dataDir: dir,
    maxDispatchPerTick: 1,
    onDispatch: async (claim) => {
      await runItem(db, claim.itemId, {
        dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${claim.itemId}`),
        prompt: "write the marker", role: claim.role, purpose: claim.purpose, runId: claim.runId,
        runtime, runtimeId: claim.runtime, lingerMs: 0,
        mcpServer: { command: process.execPath, args: ["plc-mcp-server"] },
      });
    },
  });
  const item = (workdir: string, title = "smoke"): number => {
    const itemId = createItem(db, { title, brief: "b", createdBy: "user", workdir });
    transition(db, { itemId, to: "active", actor: "system", reason: "started" });
    return itemId;
  };
  const dispatch = async (itemId: number): Promise<void> => {
    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "claude",
      trigger: "test", idempotencyKey: `test:${itemId}`,
    });
    await orchestrator.tick();
  };
  return { db, dir, item, dispatch, tick: () => orchestrator.tick() };
}

const runsOf = (db: Db, itemId: number) => db.prepare(
  "SELECT state, failure_scope AS scope, failure_code AS code FROM runs WHERE item_id=? ORDER BY id",
).all(itemId);

const incidents = (db: Db) => db.prepare("SELECT runtime, code FROM runtime_incidents").all();

describe("a ticket whose workdir path is long", () => {
  it("starts its run, and the agent hands off through the tool bridge", async () => {
    const runtime = new HandoffRuntime();
    const { db, dir, item, dispatch } = harness(runtime);
    // run 66 的工作目录是 110 字节。这里更长，在 Linux（108 字节）上同样会超限。
    const workdir = join(dir, "w".repeat(60), "x".repeat(60));
    const itemId = item(workdir);

    await dispatch(itemId);

    expect(runtime.toolReplies).toEqual([expect.objectContaining({ id: "handoff", success: true })]);
    expect(runsOf(db, itemId)).toEqual([{ state: "finished", scope: null, code: null }]);
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(incidents(db)).toEqual([]);
    db.close();
  });
});

describe("a failure while the host prepares a run", () => {
  it("blocks only that ticket, and the runtime profile keeps dispatching", async () => {
    const runtime = new HandoffRuntime();
    const { db, dir, item, dispatch } = harness(runtime);
    // 工作目录的上一级是一个普通文件，内核创建工作目录时失败（ENOTDIR）。runtime 还没有启动。
    writeFileSync(join(dir, "not-a-directory"), "");
    const broken = item(join(dir, "not-a-directory", "work"), "broken workdir");

    await dispatch(broken);

    expect(runsOf(db, broken)).toEqual([{ state: "failed", scope: "host", code: "host_exception" }]);
    expect(getItem(db, broken)?.stage).toBe("blocked");
    expect(incidents(db)).toEqual([]);
    expect(db.prepare("SELECT status FROM runtime_health WHERE status != 'healthy'").all()).toEqual([]);
    expect(db.prepare("SELECT kind FROM notifications WHERE kind='runtime_incident'").all()).toEqual([]);

    // 同一个 runtime 上的下一张工单照常派发，不会因为上一张工单的工作目录被挂起。
    const healthyWorkdir = join(dir, "healthy");
    mkdirSync(healthyWorkdir);
    const healthy = item(healthyWorkdir, "healthy workdir");
    await dispatch(healthy);

    expect(runsOf(db, healthy)).toEqual([{ state: "finished", scope: null, code: null }]);
    expect(getItem(db, healthy)?.stage).toBe("review");
    db.close();
  });
});

describe("a run that fails before its runtime reports a start", () => {
  it.each([
    { mode: "spawn-error" as const, why: "the runtime cannot be spawned" },
    { mode: "fail-before-start" as const, why: "the runtime reports an auth failure before it starts" },
  ])("keeps the ticket's workspace launchable when $why, so the retry runs after recovery", async ({ mode }) => {
    const runtime = new HandoffRuntime();
    runtime.mode = mode;
    const { db, dir, item, dispatch, tick } = harness(runtime);
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const itemId = item(workdir);

    await dispatch(itemId);

    const incident = db.prepare("SELECT id FROM runtime_incidents WHERE closed_at IS NULL").get() as
      { id: number } | undefined;
    expect(incident).toBeDefined();
    // 工作区就是用户自己的目录，没有准备过任何东西。Run 没有启动，工作区还能用。
    expect(db.prepare("SELECT state FROM workspaces WHERE owner_item_id=?").all(itemId))
      .toEqual([{ state: "requested" }]);

    runtime.mode = "handoff";
    expect(resolveRuntimeIncident(db, incident!.id, { reason: "user logged in" })).toBe(true);
    await tick();

    expect(runsOf(db, itemId)).toEqual([
      { state: "failed", scope: expect.any(String), code: expect.any(String) },
      { state: "finished", scope: null, code: null },
    ]);
    expect(getItem(db, itemId)?.stage).toBe("review");
    db.close();
  });
});

// 旧版本留下的数据：启动失败把共享工作区标成了 failed（工单 79 的工作区 #39）。
// preflight 的 blocker 让人"修复或重建这张工单的工作区"，lead 的 provision_workspace 要能做到。
describe("a ticket whose shared workspace an older version marked failed", () => {
  it("launches again after its shared workspace is provisioned", async () => {
    const runtime = new HandoffRuntime();
    const { db, dir, item, dispatch } = harness(runtime);
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const itemId = item(workdir);
    const workspace = createWorkspace(db, {
      ownerItemId: itemId, mode: "shared", kind: "primary", path: workdir, state: "requested",
    });
    transitionWorkspace(db, workspace.id, "failed");
    expect(workspaceLaunchProblem(db, itemId)).toContain("failed");

    expect(provisionWorkspace(db, { itemId, mode: "shared" })).toMatchObject({ id: workspace.id, state: "active" });
    expect(workspaceLaunchProblem(db, itemId)).toBeNull();
    await dispatch(itemId);

    expect(runsOf(db, itemId)).toEqual([{ state: "finished", scope: null, code: null }]);
    expect(getItem(db, itemId)?.stage).toBe("review");
    db.close();
  });
});
