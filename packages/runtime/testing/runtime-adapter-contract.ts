// 共享的 adapter 合约测试（spec D8，工单 13）。
// 每个 runtime 用自己的 fake CLI 跑同一组用例。新增一个 runtime 时，写 adapter、fake CLI 和一份 ContractFake，
// 再把 ContractFake 加进 runtime-adapter-contract.test.ts 的 FAKES。那个文件为每个登记的 adapter 调用一次
// describeAdapterContract。接入说明见 docs/runtime-adapter-guide.md。
// Seam 2：adapter 经启动垫片（工单 14）启动 fake CLI。用例只看三样东西：adapter 发出的事件、wait() 的结果、
// fake CLI 记下的 argv 和环境。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FailureCode } from "../src/typed-failure.js";
import type {
  AgentRuntime, RuntimeAdapter, RuntimeEvent, RuntimeExit, RuntimeHandle, RuntimeStartRequest,
} from "../src/types.js";

// fake CLI 记下的内容，按 CLI 的规则整理过。
export interface Captured {
  argv: string[];
  // CLI 收到的提示词。提示词在 argv 里时，是 CLI 解析出的位置参数。提示词经 stdin 送达时（pi 的 RPC），是它收到的那一条。
  prompt: string | null;
  // FAKE_CAPTURE_ENV 点名的变量的值。fake CLI 只记点名的变量，不记开发者环境里可能存在的凭据。
  values: Record<string, string | null>;
  // CLI 按真实 CLI 的规则加载的配置：用户配置里的条目名，以及 plc 的工具通道有没有加载。
  loaded: { user: string[]; plc: boolean };
}

// D1 映射表里的一类失败的样本。
export interface FailureSample {
  // fake CLI 的场景。null 表示可执行文件不存在（ContractFake.missingExecutable）。
  scenario: string | null;
  code: FailureCode;
  // 类型化失败的证据里必须出现的原生文本。
  evidence: string[];
  // 样本取自哪一次历史失败（packages/runtime/testing/fixtures/runtime-failures.json 的 historicalRunId），以及两边共有的原文。
  // 没有历史证据的样本（例如只在 CLI 的代码里找到的文本）不写这一项。
  historical?: { run: number; text: string };
}

// 一个 adapter 接入合约测试时要提供的东西。Options 是这个 adapter 的 create() 的参数。
export interface ContractFake<Options = unknown> {
  // 用 fake CLI 运行 scenario 的 adapter 选项。env 是 adapter 交给 CLI 的变量，fake CLI 从这里读捕获文件等设置。
  options(scenario: string, env: Record<string, string>, tuning?: { killGraceMs?: number }): Options;
  // 可执行文件不存在时的 adapter 选项。
  missingExecutable(): Options;
  scenarios: {
    // 一个正常完成的回合：有 session、助手消息和用量。
    complete: string;
    // 一个工具调用成功，一个工具调用失败，然后正常完成。
    tools: string;
    // 两行畸形行（不是 JSON 的输出行），然后正常完成。
    malformedTolerated: string;
    // 很多行畸形行，然后一直运行，不退出。
    malformedFlood: string;
    // 进程以 0 退出，但没有给出结果（没有终止事件）。
    missingResult: string;
    // 正常完成，并把收到的 argv 和环境写进捕获文件。
    capture: string;
    // 忽略 SIGTERM，一直运行。就绪时在标记文件里写 ready，收到 SIGTERM 时追加一行 SIGTERM。
    interrupt: string;
  };
  // fake CLI 从这个变量读捕获文件的路径。
  captureVariable: string;
  readCapture(file: string): Captured;
  // interrupt 场景的标记文件交给 fake CLI 的变量。
  markerEnv(file: string): Record<string, string>;
  resume: {
    // resume 之前要准备的东西，例如 CLI 按 session 文件 resume 时，先在 session 目录里放这个文件。
    prepare?(request: RuntimeStartRequest, sessionId: string): void;
    // CLI 的 argv 里必须连续出现的参数。
    args(request: RuntimeStartRequest, sessionId: string): string[];
  };
  userConfig: {
    // CLI 的配置目录变量。合约测试在每个用例之前把它指向一个空目录，fake CLI 因此读不到开发者真实的配置。
    variable: string;
    // 在配置目录里写一份用户配置，里面有一个名为 name 的条目（MCP 服务器、扩展等）。
    write(dir: string, name: string): void;
  };
  failures: FailureSample[];
}

// spec D1 的映射表。期望值从表里抄来，不从实现里读。
type D1Row = "refill" | "login" | "model" | "install" | "transient" | "task" | "unknown";
const D1_TABLE: Record<D1Row, { scope: string; retry: string; needs: string }> = {
  refill: { scope: "account", retry: "never", needs: "refill" },
  login: { scope: "account", retry: "never", needs: "login" },
  model: { scope: "runtime", retry: "other_runtime", needs: "config" },
  install: { scope: "runtime", retry: "never", needs: "config" },
  transient: { scope: "attempt", retry: "backoff", needs: "none" },
  task: { scope: "task", retry: "never", needs: "none" },
  unknown: { scope: "unknown", retry: "never", needs: "none" },
};
const ROW_OF: Partial<Record<FailureCode, D1Row>> = {
  out_of_credits: "refill",
  auth_required: "login",
  account_deactivated: "login",
  model_unsupported: "model",
  executable_missing: "install",
  extension_missing: "install",
  interpreter_mismatch: "install",
  tool_channel_unavailable: "install",
  provider_overloaded: "transient",
  provider_unavailable: "transient",
  network_error: "transient",
  task_failed: "task",
  unknown: "unknown",
};
// 每个 adapter 都要有样本的错误码：D1 表里 adapter 能遇到的每一行，满载和断网各一个。
// task 不在里面：只有能看出"agent 做了但没做完"的 CLI 才有这类样本（例如 Claude 的回合数用完）。
// host 也不在里面：它是宿主代码的失败，不经过 adapter。
const REQUIRED_CODES: readonly FailureCode[] = [
  "out_of_credits", "auth_required", "model_unsupported", "executable_missing",
  "provider_overloaded", "network_error", "unknown",
];

// 历史上失败的 Run 的证据（spec D8：证据文本做成 fixture，放进合约测试）。
const HISTORICAL_RUNS = new Map<number, { events: unknown[] }>(
  (JSON.parse(readFileSync(new URL("./fixtures/runtime-failures.json", import.meta.url), "utf8")) as {
    runs: Array<{ historicalRunId: number; events: unknown[] }>;
  }).runs.map((run) => [run.historicalRunId, run]),
);

const MAX_EVIDENCE_CHARS = 4_100;
const RUN_TIMEOUT_MS = 10_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminalEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  return events.filter((event) => event.type === "run.completed" || event.type === "run.failed");
}

// 一个 Run 恰好有一个终止事件，并且它是最后一个事件。返回这个终止事件。
function onlyTerminal(events: RuntimeEvent[]): RuntimeEvent {
  const terminal = terminalEvents(events);
  expect(terminal, `terminal events in ${events.map((event) => event.type).join(", ")}`).toHaveLength(1);
  expect(events.at(-1)).toBe(terminal[0]);
  return terminal[0]!;
}

// 注册函数：为一个 adapter 登记全部合约用例。每个登记的 adapter 调用一次。
export function describeAdapterContract<Options>(adapter: RuntimeAdapter<Options>, fake: ContractFake<Options>): void {
  describe(`the ${adapter.id} adapter contract`, () => {
    const dirs: string[] = [];
    const handles: RuntimeHandle[] = [];
    let nextRunId = 1300;
    let configDir = "";

    function tempDir(): string {
      const dir = mkdtempSync(join(tmpdir(), `plc-contract-${adapter.id}-`));
      dirs.push(dir);
      return dir;
    }

    // child 继承测试进程的环境。CLI 的配置目录指向空目录，fake CLI 读不到开发者真实的配置。
    beforeEach(() => {
      configDir = tempDir();
      vi.stubEnv(fake.userConfig.variable, configDir);
    });

    // 每个用例结束后，CLI 和垫片都不能留下。interrupt 之后仍然活着的进程组直接 SIGKILL。
    afterEach(async () => {
      for (const handle of handles.splice(0)) {
        await Promise.race([handle.interrupt("contract cleanup").catch(() => {}), delay(3_000)]);
        const cli = handle.process?.pid ?? handle.pid ?? undefined;
        if (cli && alive(cli)) {
          try { process.kill(-cli, "SIGKILL"); } catch { /* 已经退出 */ }
        }
        const shim = handle.process?.launcher?.pid;
        if (shim && alive(shim)) {
          try { process.kill(shim, "SIGKILL"); } catch { /* 已经退出 */ }
        }
        if (shim) await vi.waitFor(() => expect(alive(shim)).toBe(false), { timeout: 5_000 });
      }
      vi.unstubAllEnvs();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function request(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
      return {
        itemId: 13, runId: nextRunId++, role: "executor", purpose: "execution",
        prompt: "contract prompt", workdir: process.cwd(), sessionDir: tempDir(), env: {}, ...overrides,
      };
    }

    // plc 的 MCP 服务器。只有支持 MCP 的 adapter 收到它，和 manager 一样（capabilities.mcp）。
    function plcServer(env: Record<string, string>): Partial<RuntimeStartRequest> {
      return adapter.capabilities.mcp ? { mcpServer: { command: process.execPath, args: ["/opt/plc/mcp-server.mjs"], env } } : {};
    }

    function runtime(scenario: string, env: Record<string, string> = {}, tuning?: { killGraceMs?: number }): AgentRuntime {
      return adapter.create(fake.options(scenario, env, tuning));
    }

    async function start(instance: AgentRuntime, startRequest: RuntimeStartRequest): Promise<RuntimeHandle> {
      const handle = await instance.start(startRequest);
      handles.push(handle);
      return handle;
    }

    // 读完这个 Run 的全部事件，直到事件流结束。用例据此检查终止事件之后没有别的事件。
    // 有的 CLI 在回合结束后不退出（pi 的 RPC 进程）。这时 adapter 在终止事件之后就结束事件流。
    // 超时说明 adapter 没有结束这个 Run，或者没有结束事件流。
    async function readRun(handle: RuntimeHandle): Promise<{ events: RuntimeEvent[]; exit: RuntimeExit }> {
      const events: RuntimeEvent[] = [];
      const reading = (async () => {
        for await (const event of handle.events) events.push(event);
      })();
      const finished = await Promise.race([reading.then(() => true), delay(RUN_TIMEOUT_MS).then(() => false)]);
      if (!finished) {
        throw new Error(`the run did not end within ${RUN_TIMEOUT_MS} ms; events: ${events.map((event) => event.type).join(", ")}`);
      }
      const exit = await Promise.race([handle.wait(), delay(RUN_TIMEOUT_MS).then(() => null)]);
      if (!exit) throw new Error("wait() did not resolve after the terminal event");
      return { events, exit };
    }

    async function run(scenario: string, overrides: Partial<RuntimeStartRequest> = {}, env: Record<string, string> = {}) {
      const sent = request(overrides);
      const handle = await start(runtime(scenario, env), sent);
      return { handle, request: sent, ...await readRun(handle) };
    }

    it("completes a normal turn with one run.started, a session, a message, usage and one run.completed", async () => {
      const { request: sent, events, exit } = await run(fake.scenarios.complete);

      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
      expect(events.every((event) => event.runId === sent.runId && !Number.isNaN(Date.parse(event.occurredAt)))).toBe(true);
      const started = events.filter((event) => event.type === "run.started");
      expect(started).toEqual([expect.objectContaining({ runtime: adapter.id })]);
      // run.started 在第一条消息、工具和用量事件之前。
      const firstWork = events.findIndex((event) => /^(message|tool|usage)\./.test(event.type));
      expect(events.indexOf(started[0]!)).toBeLessThan(firstWork);
      const session = events.find((event) => event.type === "session.updated");
      expect(session).toMatchObject({ externalSessionId: expect.stringMatching(/\S/) });
      expect(events).toContainEqual(expect.objectContaining({
        type: "message.completed", role: "assistant", text: expect.stringMatching(/\S/),
      }));
      expect(events.some((event) => event.type === "usage.updated")).toBe(true);
      expect(onlyTerminal(events)).toMatchObject({ type: "run.completed", exitCode: 0 });
      expect(exit).toMatchObject({
        ok: true, errorCode: null, errorMessage: null,
        externalSessionId: (session as Extract<RuntimeEvent, { type: "session.updated" }>).externalSessionId,
      });
    });

    // 内核读 tool.failed 判断交接工具有没有失败（ingest 的 criticalToolFailure），所以失败的工具调用也要报告。
    it("reports a started, a completed and a failed tool call, each result after its own tool.started", async () => {
      const { events, exit } = await run(fake.scenarios.tools);

      const started = events.filter((event) => event.type === "tool.started");
      const results = events.filter((event) => event.type === "tool.completed" || event.type === "tool.failed");
      expect(results.some((event) => event.type === "tool.completed")).toBe(true);
      expect(results).toContainEqual(expect.objectContaining({ type: "tool.failed", error: expect.stringMatching(/\S/) }));
      for (const result of results) {
        const call = started.find((event) => event.type === "tool.started" && event.callId === (result as { callId: string }).callId);
        expect(call, `tool.started for ${(result as { callId: string }).callId}`).toMatchObject({
          name: (result as { name: string }).name,
        });
        expect(events.indexOf(call!)).toBeLessThan(events.indexOf(result));
      }
      expect(onlyTerminal(events).type).toBe("run.completed");
      expect(exit.ok).toBe(true);
    });

    it("tolerates a few malformed lines", async () => {
      const { events, exit } = await run(fake.scenarios.malformedTolerated);
      expect(onlyTerminal(events).type).toBe("run.completed");
      expect(exit.ok).toBe(true);
    });

    // CLI 一直不退出时，adapter 自己结束这个 Run，并停止 CLI。否则 Run 永远挂着。
    it("fails the run and stops the CLI after too many malformed lines, even when the CLI does not exit", async () => {
      const { handle, events, exit } = await run(fake.scenarios.malformedFlood);
      expect(onlyTerminal(events).type).toBe("run.failed");
      expect(exit.ok).toBe(false);
      const cli = handle.process!.pid!;
      await vi.waitFor(() => expect(alive(cli)).toBe(false), { timeout: 5_000 });
    });

    // 进程以 0 退出，却没有终止事件：没有证据说明发生了什么，所以是 unknown（spec D1）。
    // unknown 不自动重试，并请 lead 判断。把它报成完成，内核会去登记一个不存在的成果。
    it("fails a run whose CLI exits 0 without a result, and types it unknown", async () => {
      const { events, exit } = await run(fake.scenarios.missingResult);
      expect(onlyTerminal(events)).toMatchObject({
        type: "run.failed", failure: expect.objectContaining({ ...D1_TABLE.unknown, code: "unknown" }),
      });
      expect(exit.ok).toBe(false);
    });

    // 暂停、停止和停留到期都经 interrupt 结束 CLI（manager）。CLI 可能忽略 SIGTERM，所以宽限期之后要 SIGKILL。
    it("ends the run and stops the CLI on interrupt, even when the CLI ignores SIGTERM", async () => {
      const marker = join(tempDir(), "marker");
      const handle = await start(runtime(fake.scenarios.interrupt, fake.markerEnv(marker), { killGraceMs: 200 }), request());
      const events: RuntimeEvent[] = [];
      const reading = (async () => { for await (const event of handle.events) events.push(event); })();
      await vi.waitFor(() => expect(readText(marker)).toMatch(/ready/i), { timeout: 5_000 });

      const ended = await Promise.race([
        handle.interrupt("operator stop").then(() => handle.wait()).then(async (exit) => { await reading; return exit; }),
        delay(RUN_TIMEOUT_MS).then(() => null),
      ]);
      if (!ended) throw new Error(`interrupt did not end the run within ${RUN_TIMEOUT_MS} ms`);

      expect(readText(marker)).toContain("SIGTERM");
      expect(onlyTerminal(events).type).toBe("run.failed");
      expect(ended).toMatchObject({ ok: false, signal: "SIGKILL" });
      const cli = handle.process!.pid!;
      const shim = handle.process!.launcher!.pid;
      await vi.waitFor(() => expect([alive(cli), alive(shim)]).toEqual([false, false]), { timeout: 5_000 });
    });

    // 内核在三种情况下 resume 外部 session：瞬时重试、修复回合、恢复以后的重派。CLI 必须收到这个 session。
    // 否则 agent 在一个新 session 里收到"接着做"，前面的上下文全部丢失。
    it("hands a resume request to the CLI as its resume arguments, with the prompt intact", async () => {
      const capture = join(tempDir(), "capture.json");
      const sessionId = "contract-session-7";
      const sent = request({ resumeSessionId: sessionId, prompt: "resume the work\nsecond line" });
      fake.resume.prepare?.(sent, sessionId);
      await readRun(await start(runtime(fake.scenarios.capture, { [fake.captureVariable]: capture }), sent));

      const captured = fake.readCapture(capture);
      const expected = fake.resume.args(sent, sessionId);
      const at = captured.argv.findIndex((_, index) =>
        expected.every((arg, offset) => captured.argv[index + offset] === arg));
      expect(at, `${JSON.stringify(expected)} in ${JSON.stringify(captured.argv)}`).toBeGreaterThanOrEqual(0);
      expect(captured.prompt).toBe(sent.prompt);
    });

    // 用户决定（2026-10-11，spec D6）：child 和用户独立运行 CLI 时看到同样的环境。
    // child 继承 daemon 的全部环境，PATH 由 profile 构造。工具桥 token 不进 argv：本机其他用户用 ps 能看到 argv。
    describe("environment, as when the user runs the CLI standalone", () => {
      const TOKEN = "t13-bridge-token-5c0ffee";
      // manager 给 child 和 plc 的 MCP 服务器的变量（src/children/manager.ts）：两边的取值相同。
      const BRIDGE_ENV = { PLC_AGENT_TOOL_SOCKET: "/tmp/plc-t13.sock", PLC_AGENT_TOOL_TOKEN: TOKEN, PLC_TICKET_ID: "13" };

      async function captureStart(env: Record<string, string>, overrides: Partial<RuntimeStartRequest> = {}) {
        const file = join(tempDir(), "capture.json");
        const instance = runtime(fake.scenarios.capture, { [fake.captureVariable]: file, ...env });
        await readRun(await start(instance, request(overrides)));
        return { captured: fake.readCapture(file), instance };
      }

      it("passes a variable that only the daemon has", async () => {
        vi.stubEnv("T13_DAEMON_SENTINEL", "inherited");
        const { captured } = await captureStart({ FAKE_CAPTURE_ENV: "T13_DAEMON_SENTINEL" });
        expect(captured.values.T13_DAEMON_SENTINEL).toBe("inherited");
      });

      it("passes the adapter's and the request's variables, with the PATH of its profile", async () => {
        const { captured, instance } = await captureStart(
          { FAKE_CAPTURE_ENV: "PATH,T13_ADAPTER,PLC_ATTEMPT_ID", T13_ADAPTER: "adapter" },
          { env: { PLC_TICKET_ID: "13", PLC_ATTEMPT_ID: "7" } },
        );
        expect(instance.profile!.environment.inherit).toBe("all");
        expect(captured.values).toEqual({ T13_ADAPTER: "adapter", PLC_ATTEMPT_ID: "7", PATH: instance.profile!.environment.path });
      });

      it("puts no tool bridge token on argv", async () => {
        const { captured } = await captureStart({}, { env: BRIDGE_ENV, ...plcServer(BRIDGE_ENV) });
        expect(captured.argv.length).toBeGreaterThan(0);
        expect(captured.argv.filter((arg) => arg.includes(TOKEN))).toEqual([]);
      });
    });

    // 用户决定（2026-10-11，spec D6）：executor 照常加载用户的配置（MCP 服务器、扩展等），
    // plc 的工具通道叠加在上面。adapter 不加关闭用户配置的 flag。fake CLI 按真实 CLI 的规则模拟加载。
    it("loads the user's own configuration for an executor, with the plc tool channel on top", async () => {
      fake.userConfig.write(configDir, "user-design");
      const file = join(tempDir(), "capture.json");
      const sent = request({ env: { PLC_TICKET_ID: "13" }, ...plcServer({ PLC_TICKET_ID: "13" }) });
      await readRun(await start(runtime(fake.scenarios.capture, { [fake.captureVariable]: file }), sent));

      const captured = fake.readCapture(file);
      expect(captured.loaded).toEqual({ user: ["user-design"], plc: true });
      expect(captured.prompt).toBe(sent.prompt);
    });

    // spec D1：adapter 把 CLI 的原生失败分类成类型化失败。内核按 scope 决定谁来处理、扣不扣工单的额度。
    describe("typed failures, one sample for each row of the spec D1 table", () => {
      it("has a sample for every failure code the adapter can meet", () => {
        expect(REQUIRED_CODES.filter((code) => !fake.failures.some((sample) => sample.code === code))).toEqual([]);
        expect(fake.failures.filter((sample) => !ROW_OF[sample.code])).toEqual([]);
      });

      it.each(fake.failures.map((sample) => [sample.scenario ?? "missing executable", sample] as const))(
        "types the %s sample",
        async (_name, sample) => {
          const instance = sample.scenario === null ? adapter.create(fake.missingExecutable()) : runtime(sample.scenario);
          const handle = await start(instance, request());
          const { events, exit } = await readRun(handle);

          const terminal = onlyTerminal(events);
          expect(terminal.type).toBe("run.failed");
          expect(exit.ok).toBe(false);
          const { scope, retry, needs, code, evidence } = (terminal as Extract<RuntimeEvent, { type: "run.failed" }>).failure;
          expect({ scope, retry, needs, code }).toEqual({ ...D1_TABLE[ROW_OF[sample.code]!], code: sample.code });
          for (const text of sample.evidence) expect(evidence).toContain(text);
          if (sample.historical) {
            const recorded = HISTORICAL_RUNS.get(sample.historical.run);
            expect(recorded, `fixture run ${sample.historical.run}`).toBeDefined();
            expect(JSON.stringify(recorded!.events)).toContain(JSON.stringify(sample.historical.text).slice(1, -1));
            expect(evidence).toContain(sample.historical.text);
          }
          expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
          // 失败的 Run 不留下 CLI。内核会为同一张工单排重试，而 manager 不给还有活进程的工单启动新的 Run。
          const cli = handle.process?.pid;
          if (cli !== undefined) await vi.waitFor(() => expect(alive(cli)).toBe(false), { timeout: 5_000 });
        },
      );
    });
  });
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function delay(ms: number): Promise<void> {
  // unref：只为等待而设的定时器不让进程多活。
  return new Promise((resolve) => (setTimeout(resolve, ms) as unknown as NodeJS.Timeout).unref());
}

// 给各 adapter 的 ContractFake 用：读 JSON 格式的捕获文件。

// 读 JSON 捕获文件。
export function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

