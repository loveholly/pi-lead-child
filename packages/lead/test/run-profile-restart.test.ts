// 工单 08 的验收：Claude Code 和 Codex 有 Run 在跑时换模型和推理强度。它们用 -p 启动，运行中没有输入通道（spec D4），
// 所以停在当前这一步，用同一个会话 id 和新的参数重新拉起，新 Run 的 resumed_from_run_id 指向旧 Run。
// 这里走完整的持久化流程：工单操作停下旧 Run、排续接的请求 → 派发认领建出新 Run → Lead 的 spawnClaimedItem 用真的 adapter
// 拉起假的 CLI，读 CLI 实际收到的参数。
// 换执行 agent（change_executor_runtime）也走这条路，只是新 runtime 接不上旧会话：开新会话，提示里写明换了执行 agent。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createDispatcher, liveChildren, runTicketAction } from "@pi-lead-child/engine";
import { ClaudeRuntime, CodexRuntime, RuntimeRegistry, type AgentRuntime, type RuntimeHandle } from "@pi-lead-child/runtime";
import { createItem, createRun, getRun, listRuns, openDb, transition, updateRun, type Db } from "@pi-lead-child/store";
import { runningChildren, spawnClaimedItem, type LeadDeps } from "../src/tools.js";

const TSX = resolve("node_modules/.bin/tsx");
const FAKE_CLAUDE = resolve("packages/runtime/testing/fake-claude.ts");
const FAKE_CODEX = resolve("packages/runtime/testing/fake-codex.ts");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-run-profile-restart-");
  db = openDb(join(dir, "plc.db"));
  liveChildren().clear();
  // child 继承测试进程的环境。假的 CLI 不读开发者真实的配置。
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
  vi.stubEnv("CODEX_HOME", dir);
});

afterEach(() => {
  liveChildren().clear();
  vi.unstubAllEnvs();
  db.close();
});

// 旧 Run 在跑：库里是 running，有会话 id，live 表里是它的进程（假的：停下时记下原因）。
function runningRun(runtime: "claude" | "codex", session: string, profile: { model: string; effort: string }) {
  const itemId = createItem(db, { title: "修复登录", brief: "修好登录。", createdBy: "lead" });
  db.prepare("UPDATE items SET requested_runtime=?, requested_model=? WHERE id=?").run(runtime, profile.model, itemId);
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId, runtime, model: profile.model, effort: profile.effort });
  updateRun(db, runId, { state: "running", sessionId: session });
  db.prepare("UPDATE runs SET external_session_id=? WHERE id=?").run(session, runId);
  const interrupted: string[] = [];
  const handle: RuntimeHandle = {
    pid: null,
    events: (async function* () {})(),
    interrupt: async (reason) => { interrupted.push(reason); },
    wait: async () => ({ ok: false, exitCode: null, signal: "SIGTERM", externalSessionId: session, errorCode: null, errorMessage: null }),
  };
  liveChildren().set(itemId, { runId, handle, streaming: true });
  return { itemId, runId, interrupted };
}

// 认领续接的请求，用 Lead 的 spawnClaimedItem 拉起，等它跑完。
async function claimAndSpawn(itemId: number, runtime: AgentRuntime) {
  const claim = createDispatcher(db).claimNext();
  expect(claim).not.toBeNull();
  const deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, runtimeRegistry: new RuntimeRegistry([runtime]) } as LeadDeps;
  spawnClaimedItem(deps, claim!);
  await runningChildren().get(itemId);
  return claim!;
}

const CASES = [
  {
    runtime: "claude" as const, session: "claude-session-old",
    adapter: (capture: string) => new ClaudeRuntime({
      bin: TSX, prefixArgs: [FAKE_CLAUDE], env: { FAKE_CLAUDE_SCENARIO: "inspect", FAKE_CLAUDE_CAPTURE: capture },
    }),
    argv: (capture: string) => (JSON.parse(readFileSync(capture, "utf8")) as { argv: string[] }).argv,
    from: { model: "opus", effort: "high" }, to: { model: "sonnet", effort: "low" },
    flags: [["--resume", "claude-session-old"], ["--model", "sonnet"], ["--effort", "low"]],
  },
  {
    runtime: "codex" as const, session: "codex-thread-old",
    adapter: (capture: string) => new CodexRuntime({
      bin: TSX, prefixArgs: [FAKE_CODEX], env: { FAKE_CODEX_SCENARIO: "happy", FAKE_CODEX_CAPTURE: capture },
    }),
    argv: (capture: string) => (JSON.parse(readFileSync(capture, "utf8")) as { args: string[] }).args,
    from: { model: "gpt-5.5", effort: "medium" }, to: { model: "gpt-5.6", effort: "high" },
    flags: [["resume", "codex-thread-old"], ["--model", "gpt-5.6"], ["-c", 'model_reasoning_effort="high"']],
  },
];

// argv 里 flag 后面紧跟着它的值。
function hasFlag(argv: string[], [flag, value]: string[]): boolean {
  return argv.some((arg, index) => arg === flag && argv[index + 1] === value);
}

describe.each(CASES)("switching the model of a running $runtime run", (test) => {
  it("stops at the current step and resumes the same session with the new model in a new run", async () => {
    const { itemId, runId, interrupted } = runningRun(test.runtime, test.session, test.from);
    const { result } = await runTicketAction(db, {
      itemId, action: "set_run_profile", input: { role: "executor", ...test.to }, caller: { kind: "user" }, reason: "这一步用不着大模型",
    });
    expect(result).toMatchObject({ applied: "restarted", runId, from: test.from, to: test.to });
    // 旧 Run 停在这一步（停下，不是失败），进程被停掉。
    expect(getRun(db, runId)!.state).toBe("stopped");
    expect(interrupted).toHaveLength(1);

    const capture = join(dir, `${test.runtime}-capture.json`);
    const claim = await claimAndSpawn(itemId, test.adapter(capture));
    // 新 Run 指向旧 Run；运行记录里是两行，各记各的模型。
    expect(getRun(db, claim.runId)).toMatchObject({
      resumed_from_run_id: runId, runtime: test.runtime, model: test.to.model, effort: test.to.effort,
    });
    expect(listRuns(db, itemId).map((run) => [run.id, run.model])).toEqual([[runId, test.from.model], [claim.runId, test.to.model]]);
    // 新进程用的是同一个会话 id 和新的模型参数。
    const argv = test.argv(capture);
    for (const flag of test.flags) expect(hasFlag(argv, flag), `${flag.join(" ")} in ${argv.join(" ")}`).toBe(true);
    expect(argv.join("\n")).toContain("换了模型和推理强度以后接着刚才的工作继续");
  }, 30_000);
});

describe("changing the executor's runtime while it runs", () => {
  it("stops the run and starts the new runtime in a new session that is told about the switch", async () => {
    const { itemId, runId } = runningRun("claude", "claude-session-old", { model: "opus", effort: "high" });
    const { result } = await runTicketAction(db, {
      itemId, action: "change_executor_runtime", input: { runtime: "codex", model: "gpt-5.6" }, caller: { kind: "user" },
    });
    expect(result).toMatchObject({ applied: "restarted", runId, from: { runtime: "claude" }, to: { runtime: "codex", model: "gpt-5.6" } });
    expect(getRun(db, runId)!.state).toBe("stopped");

    const capture = join(dir, "codex-capture.json");
    const claim = await claimAndSpawn(itemId, CASES[1]!.adapter(capture));
    expect(getRun(db, claim.runId)).toMatchObject({ resumed_from_run_id: runId, runtime: "codex", model: "gpt-5.6" });
    const argv = CASES[1]!.argv(capture);
    // 另一个 CLI 的会话接不上：不带 resume，开新会话，提示里写明换了执行 agent，并带上工单的上下文。
    expect(argv).not.toContain("resume");
    const prompt = argv.at(-1)!;
    expect(prompt).toContain("## 换了执行 agent");
    expect(prompt).not.toContain("CLI 按保留期删除了它的记录");
    expect(prompt).toContain("执行 agent 从 Claude Code 换成了 Codex");
  }, 30_000);
});
