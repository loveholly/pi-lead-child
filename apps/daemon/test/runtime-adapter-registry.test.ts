// 工单 12（spec D8）：一个只存在于这个测试里的 runtime「echo」。
// 它只写了 adapter，然后登记到 registry。内核模块一行都不改，它就能被派发、分类和展示。
// Seam 1：编排器派发，经 daemon 的真实入口 spawnClaimedItem 跑 runItem，真实 SQLite。
// 用户看到的通知从 gateway 的 HTTP 接口读回来。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import { recoverTicketRun } from "@pi-lead-child/engine";
import { runItem } from "@pi-lead-child/engine";
import { spawnClaimedItem, runningChildren, type LeadDeps } from "@pi-lead-child/lead";
import { createOrchestrator } from "@pi-lead-child/engine";
import {
  matchProviderFailure, residualFailureCode, runtimeDisplayName, typedFailure,
} from "@pi-lead-child/runtime";
import type { RuntimeProfile } from "@pi-lead-child/runtime";
import { classifyFailure, registerRuntimeAdapter } from "@pi-lead-child/runtime";
import type {
  AgentRuntime, RuntimeAdapter, RuntimeCapabilities, RuntimeExit, RuntimeHandle, RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import { grantDelegationPolicy } from "@pi-lead-child/store";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import type { RuntimeId } from "@pi-lead-child/core";
import { readGatewayNotifications } from "@pi-lead-child/gateway/testing";
import type { RecordedEvent } from "@pi-lead-child/runtime/testing";
import { tempDir } from "@pi-lead-child/core/testing";

// RuntimeId 和线上契约的 KernelRuntimeId 一样，是封闭的联合类型。真实的新 runtime 要同时扩展这两个类型。
// 只存在于测试里的 runtime 用类型断言。
const ECHO = "echo" as RuntimeId;

// echo 不支持 MCP。它和 pi 一样，用自己的方式接入 plc 工具通道。
const ECHO_CAPABILITIES: RuntimeCapabilities = {
  streaming: true, steering: false, resume: true, interrupt: true,
  approvals: false, mcp: false, executableReadOnlyReview: false,
};

// 一次启动要做的事：按顺序发出这些事件，然后以 exit 结束。
// live 为 true 时，回合结束后进程还活着，和 pi 的 RPC 进程一样，由内核决定什么时候结束它。
interface EchoScript {
  events: RecordedEvent[];
  exit: Omit<RuntimeExit, "externalSessionId" | "signal">;
  live?: boolean;
}

class EchoRuntime implements AgentRuntime {
  readonly id = ECHO;
  readonly requests: RuntimeStartRequest[] = [];
  readonly scripts: EchoScript[] = [];
  // 内核结束进程时给的原因。
  readonly interrupts: string[] = [];

  constructor(readonly profile: RuntimeProfile, readonly capabilities: RuntimeCapabilities = ECHO_CAPABILITIES) {}

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) throw new Error(`echo has no script for run #${request.runId}`);
    const events = script.events.map((event, index) => ({
      ...event, runId: request.runId, seq: index + 1, occurredAt: new Date().toISOString(),
    }));
    const exit: RuntimeExit = { ...script.exit, signal: null, externalSessionId: "echo-session-1" };
    const child = script.live ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]) : undefined;
    return {
      pid: child?.pid ?? null,
      process: child,
      events: (async function* () { yield* events as never[]; })(),
      interrupt: async (reason) => { this.interrupts.push(reason); child?.kill(); },
      wait: async () => exit,
    };
  }
}

// echo 的模型名带 provider 前缀 echo/，CLI 只认前缀后面的部分。别家的模型不属于它。
function resolveEchoModel(model: string): string {
  const [provider, name] = model.includes("/") ? model.split("/", 2) : ["echo", model];
  if (provider !== "echo" || !name) throw new Error(`runtime 'echo' cannot use model '${model}'`);
  return name;
}

// echo 自己的失败文本：它说配额用完了，就是账号余额不足。
function classifyEchoFailure(evidence: { errorCode: string | null; message: string | null }) {
  if (/echo quota exhausted/i.test(evidence.message ?? "")) return typedFailure("out_of_credits", evidence);
  return typedFailure(matchProviderFailure(evidence.message) ?? residualFailureCode(evidence), evidence);
}

function echoAdapter(runtime: EchoRuntime): RuntimeAdapter {
  return {
    id: ECHO,
    displayName: "Echo Agent",
    capabilities: ECHO_CAPABILITIES,
    models: {
      defaultModel: (env = process.env) => env.PLC_ECHO_MODEL?.trim() || "echo/standard",
      resolve: resolveEchoModel,
    },
    reportsCost: true,
    classifyFailure: classifyEchoFailure,
    locateExecutable: () => runtime.profile.executable,
    create: () => runtime,
  };
}

// 正常结束的一轮：agent 交接了成果，并留下成果信封。
const finished: RecordedEvent[] = [
  { type: "run.started", runtime: ECHO, model: "standard" },
  { type: "session.updated", externalSessionId: "echo-session-1" },
  { type: "tool.started", callId: "tu-1", name: "ticket_update", args: { status: "review" } },
  { type: "tool.completed", callId: "tu-1", name: "ticket_update", result: {} },
  {
    type: "message.completed", messageId: "m-done", role: "assistant",
    text: `PLC_OUTCOME_V1 ${JSON.stringify({ summary: "echoed", changes: [], deliverables: [], validations: [] })}`,
  },
  { type: "run.completed", exitCode: 0 },
];

let db: Db;
let dir: string;
let echo: EchoRuntime;
let unregister: () => void;

beforeEach(() => {
  dir = tempDir("plc-runtime-registry-");
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_CHILD_LINGER_MS", "0");
  db = openDb(join(dir, "plc.db"));
  echo = new EchoRuntime({
    runtime: ECHO, executable: join(dir, "bin", "echo-agent"), configDir: join(dir, "echo-config"),
    interpreter: null, extensions: [], models: { defaultModel: "echo/standard", providers: ["echo"] },
    environment: { path: join(dir, "bin"), inherit: "all", adapterVariables: [] }, allowedTools: [],
  });
  unregister = registerRuntimeAdapter(echoAdapter(echo));
});

afterEach(() => {
  unregister();
  db.close();
  vi.unstubAllEnvs();
});

// 派发环境和 daemon 一样：deps 里没有注入 registry，spawnClaimedItem 用默认 registry 找 adapter。
function harness() {
  const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir };
  const orchestrator = createOrchestrator(db, { dataDir: dir, onDispatch: (claim) => { spawnClaimedItem(deps, claim); } });
  const tick = async (): Promise<void> => {
    await orchestrator.tick();
    await vi.waitFor(() => expect(runningChildren().size).toBe(0));
  };
  const dispatch = (itemId: number, key: string): number => orchestrator.dispatcher.request({
    itemId, role: "executor", purpose: "execution", trigger: "test", idempotencyKey: key,
  });
  return { tick, dispatch };
}

const runsOf = (itemId: number) => db.prepare(
  `SELECT runtime, model, state, failure_scope AS scope, failure_code AS code
   FROM runs WHERE item_id=? ORDER BY id`,
).all(itemId);

describe("a runtime that only this test registers", () => {
  it("is dispatched with the model and the tool channel its adapter declares", async () => {
    const { tick, dispatch } = harness();
    const itemId = createItem(db, { title: "echo ticket", brief: "echo the brief", createdBy: "user", runtime: ECHO });
    echo.scripts.push({ events: finished, exit: { ok: true, exitCode: 0, errorCode: null, errorMessage: null } });

    const requestId = dispatch(itemId, "echo-dispatch");
    // 默认模型和模型名的转换都来自 echo 的 adapter。
    expect(db.prepare("SELECT runtime, model FROM dispatch_requests WHERE id=?").get(requestId))
      .toEqual({ runtime: "echo", model: "standard" });

    await tick();

    expect(runsOf(itemId)).toEqual([{ runtime: "echo", model: "standard", state: "finished", scope: null, code: null }]);
    // 内核按 adapter 的能力决定要不要给 MCP 服务器。echo 不支持 MCP，所以没有收到。
    // 以前只有名字是 pi 的 runtime 不收 MCP 服务器。
    expect(echo.requests).toHaveLength(1);
    expect(echo.requests[0]!.mcpServer).toBeUndefined();
    expect(getItem(db, itemId)!.stage).toBe("review");
  });

  it("may take a ticket with a USD budget, because its adapter reports cost", () => {
    const itemId = createItem(db, { title: "budgeted", brief: "b", createdBy: "user", runtime: ECHO });
    db.prepare("UPDATE items SET cost_budget_usd=2 WHERE id=?").run(itemId);
    const dispatcher = createDispatcher(db);
    dispatcher.request({ itemId, role: "executor", purpose: "execution", trigger: "test", idempotencyKey: "echo-budget" });
    expect(dispatcher.claimNext()).toMatchObject({ itemId, runtime: "echo" });
    expect(getItem(db, itemId)!.stage).not.toBe("blocked");
  });

  it("refuses a model that belongs to another provider before any Run exists", () => {
    const { dispatch } = harness();
    const itemId = createItem(db, {
      title: "wrong model", brief: "b", createdBy: "user", runtime: ECHO, model: "openai/gpt-5.5",
    });
    expect(() => dispatch(itemId, "echo-wrong-model")).toThrow("runtime 'echo' cannot use model 'openai/gpt-5.5'");
    expect(runsOf(itemId)).toEqual([]);
  });

  it("classifies a failure the kernel observed with the adapter's classifier, and names the adapter to the user", async () => {
    const { tick, dispatch } = harness();
    const itemId = createItem(db, { title: "echo ticket", brief: "b", createdBy: "user", runtime: ECHO });
    // 进程退出，但没有终止事件。这时没有 adapter 给出的类型，由内核的兜底分类器分类。
    echo.scripts.push({
      events: [{ type: "run.started", runtime: ECHO, model: "standard" }],
      exit: { ok: false, exitCode: 3, errorCode: "echo_exit", errorMessage: "echo quota exhausted for this account" },
    });

    dispatch(itemId, "echo-failure");
    await tick();

    expect(runsOf(itemId)).toEqual([
      { runtime: "echo", model: "standard", state: "failed", scope: "account", code: "out_of_credits" },
    ]);
    const checkpoint = db.prepare(
      "SELECT title, key_facts FROM checkpoints WHERE item_id=? AND kind='blocked' ORDER BY id DESC LIMIT 1",
    ).get(itemId) as { title: string; key_facts: string };
    expect(checkpoint.title).toBe("Echo Agent 账号余额不足");
    expect(JSON.parse(checkpoint.key_facts)).toEqual(expect.arrayContaining([{ label: "Agent", value: "Echo Agent" }]));

    // 账号故障记在 echo 的 profile 上。用户收到一条通知，说的是 echo 的名字和它的重检命令。
    const notifications = (await readGatewayNotifications(db)).filter((notice) => notice.kind === "runtime_incident");
    expect(notifications).toEqual([expect.objectContaining({ title: "Echo Agent 账号余额不足：派发已挂起" })]);
    expect(notifications[0]!.body).toContain("需要给 Echo Agent 的账号充值");
    expect(notifications[0]!.body).toContain("plc recheck echo");
  });
});

// fallback 的 runtime 顺序来自配置和 registry（工单 12），不再写死在恢复模块里。
describe("the runtime fallback order", () => {
  function failedCodexRun(): { itemId: number; runId: number } {
    const itemId = createItem(db, { title: "codex outage", brief: "b", createdBy: "system", runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    const runId = createRun(db, { itemId, runtime: "codex", model: "gpt-5.5" });
    updateRun(db, runId, {
      state: "failed", endedAt: true, errorCode: "codex_error",
      errorMessage: "Your refresh token was revoked. Please log out and sign in again.",
    });
    transition(db, { itemId, to: "blocked", actor: "system", reason: "runtime failed", runId });
    grantDelegationPolicy(db, { itemId, createdVia: "test", maxReworkCycles: 1 });
    return { itemId, runId };
  }

  it("follows the registry order when nothing is configured", () => {
    const { itemId, runId } = failedCodexRun();
    expect(recoverTicketRun(db, { itemId, failedRunId: runId, action: "auto", authorityRef: "test" }))
      .toMatchObject({ status: "queued", runtime: "claude" });
  });

  it("puts the configured runtimes first and skips names the registry does not know", () => {
    vi.stubEnv("PLC_RUNTIME_FALLBACKS", "nope,echo");
    const { itemId, runId } = failedCodexRun();
    expect(recoverTicketRun(db, { itemId, failedRunId: runId, action: "auto", authorityRef: "test" }))
      .toMatchObject({ status: "queued", runtime: "echo", model: null });
    expect(db.prepare("SELECT runtime, model FROM dispatch_requests WHERE item_id=?").get(itemId))
      .toEqual({ runtime: "echo", model: "standard" });
  });
});

// 回合结束后，进程要不要停留，看 adapter 的能力，不看名字（工单 12）。
// 能 steer 的 runtime 停留到 linger 到期，lead 可以在这段时间里 steer 它。不能 steer 的 runtime 马上结束。
describe("whether a finished turn keeps its process", () => {
  it.each([
    [true, "linger timeout"],
    [false, "runtime turn complete"],
  ])("steering=%s ends the process with %s", async (steering, reason) => {
    const runtime = new EchoRuntime(echo.profile, { ...ECHO_CAPABILITIES, steering });
    runtime.scripts.push({ events: finished, exit: { ok: true, exitCode: 0, errorCode: null, errorMessage: null }, live: true });
    const itemId = createItem(db, { title: "echo ticket", brief: "b", createdBy: "user", runtime: ECHO });

    await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`),
      prompt: "echo", runtime, lingerMs: 200,
    });

    expect(runtime.interrupts).toEqual([reason]);
  });
});

// 旧数据里可能有已经不再登记的 runtime。内核照样能展示和分类它的失败。
describe("a runtime that is no longer registered", () => {
  it("shows its id, and the kernel classifies its failures without the adapter", () => {
    unregister();
    expect(runtimeDisplayName(ECHO)).toBe("echo");
    // 通用的 provider 诊断仍然有效。
    expect(classifyFailure(ECHO, { errorCode: "echo_exit", message: "Failed to authenticate: OAuth token has expired" }))
      .toMatchObject({ scope: "account", code: "auth_required" });
    // echo 自己的规则不在了：它的配额文字不再是账号余额不足。
    expect(classifyFailure(ECHO, { errorCode: "echo_exit", message: "echo quota exhausted for this account" }))
      .toMatchObject({ scope: "unknown", code: "unknown" });
  });
});
