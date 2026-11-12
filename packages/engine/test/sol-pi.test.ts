import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { packageSource } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  correctThenRunFailure, foldStaleRecallPages, OBSERVATION_THRESHOLD_BYTES, solPiConfig, solPiSettings,
} from "../src/extension/sol-pi.js";
import { SOL_PI_SOURCE, solPiPackage, solPiPinnedCommit, solPiSource } from "../src/extension/sol-pi-package.js";

// 内置的 SoL-Pi（src/extension/sol-pi.ts）：pi 的包管理器安装上游，这里按角色配置。

describe("SoL-Pi settings per role", () => {
  it("defaults the executor to Action Fusion and ObservationPack, and the Lead to ObservationPack", () => {
    expect(solPiSettings("executor", {})).toMatchObject({
      features: ["actionFusion", "observationPack"], tools: ["edit", "write", "obs_recall"],
    });
    expect(solPiSettings("lead", {})).toMatchObject({ features: ["observationPack"], tools: ["obs_recall"] });
  });

  it("turns off, takes an explicit list, and routes the reducer model", () => {
    expect(solPiSettings("executor", { PLC_SOL_PI: "off" }).features).toEqual([]);
    expect(solPiSettings("executor", {
      PLC_SOL_PI: "observationPack, evidencePreservingReducer", PLC_SOL_PI_REDUCER_MODEL: "anthropic/claude-haiku-5-5",
    })).toMatchObject({
      features: ["observationPack", "evidencePreservingReducer"],
      reducer: { provider: "anthropic", model: "claude-haiku-5-5" },
    });
  });

  // Lead 刻意没有写能力：Action Fusion 会注册 edit/write，所以 Lead 不允许开它。
  it("refuses features a role may not use and unknown names", () => {
    expect(() => solPiSettings("lead", { PLC_LEAD_SOL_PI: "actionFusion" })).toThrow(/not allowed for lead/);
    expect(() => solPiSettings("executor", { PLC_SOL_PI: "actionFusoin" })).toThrow(/actionFusion, observationPack/);
    expect(() => solPiSettings("executor", { PLC_SOL_PI: "evidencePreservingReducer", PLC_SOL_PI_REDUCER_MODEL: "haiku" }))
      .toThrow(/provider\/model/);
  });
});

// 上游 41fa7e0 在 pi 1.1.0 上的 then_run 结果：命令失败（pi 1.x 的 bash 返回 isError，不抛错），
// 结果却带着成功标记（上游 issue #94）。
function upstreamThenRunResult(output: string) {
  return {
    toolName: "write" as const, isError: false,
    content: [
      { type: "text" as const, text: "Successfully wrote 8 bytes to kept.txt" },
      { type: "text" as const, text: `[then_run:succeeded]\n${output}` },
    ],
  };
}

describe("correctThenRunFailure (upstream issue #94 on pi 1.x)", () => {
  it("turns a then_run with a non-zero exit into a failed tool result", () => {
    const corrected = correctThenRunFailure(upstreamThenRunResult("validation failed\n\n\nCommand exited with code 7"));
    expect(corrected?.isError).toBe(true);
    expect(corrected?.content?.[0]).toEqual({ type: "text", text: "Successfully wrote 8 bytes to kept.txt" });
    expect(corrected?.content?.[1]).toEqual({
      type: "text", text: "[then_run:failed]\nvalidation failed\n\n\nCommand exited with code 7",
    });
  });

  it("leaves passing commands, other tools, and already failed results alone", () => {
    expect(correctThenRunFailure(upstreamThenRunResult("ok"))).toBeUndefined();
    expect(correctThenRunFailure({ ...upstreamThenRunResult("x\nCommand exited with code 1"), toolName: "bash" }))
      .toBeUndefined();
    expect(correctThenRunFailure({ ...upstreamThenRunResult("x\nCommand exited with code 1"), isError: true }))
      .toBeUndefined();
  });
});

// 假的 SoL-Pi 包：和上游一样没有 node_modules，导出 createSolPiExtension 和 config.ts 的 DEFAULT_CONFIG。
// write 照上游 41fa7e0 的做法跑 pi 的 bash，不看 isError。
function fakeSolPiPackage(): string {
  const dir = join(tempDir("plc-sol-pi-pkg-"), "SoL-Pi");
  mkdirSync(join(dir, "src", "sol-pi"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sol-pi", pi: { extensions: ["./src/sol-pi/index.ts"] } }));
  writeFileSync(join(dir, "src", "sol-pi", "config.ts"), `
export const DEFAULT_CONFIG = Object.freeze({ version: 1, actionFusion: false, observationPack: false,
  evidencePreservingReducer: false, onlineContextCompact: false, cacheWriteReadRatio: 12.5,
  evidencePreservingReducerProvider: "openai-codex", evidencePreservingReducerModel: "gpt-5.6-luna" });
`);
  writeFileSync(join(dir, "src", "sol-pi", "index.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export function createSolPiExtension(load) {
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      const config = load(ctx);
      if (config.observationPack) pi.registerTool({
        name: "obs_recall", label: "Recall", description: "recall", parameters: Type.Object({ id: Type.String() }),
        async execute() { return { content: [{ type: "text", text: "" }], details: undefined }; },
      });
      if (config.actionFusion) pi.registerTool({
        name: "write", label: "Write", description: "write",
        parameters: Type.Object({ path: Type.String(), content: Type.String(),
          then_run: Type.Optional(Type.Object({ command: Type.String() })) }),
        async execute(id, params, signal, _onUpdate, ctx) {
          await writeFile(join(ctx.cwd, params.path), params.content);
          const result = await createBashToolDefinition(ctx.cwd).execute(id + ":then_run", params.then_run, signal, undefined, ctx);
          const output = result.content.filter((b) => b.type === "text").map((b) => b.text).join("\\n");
          return { content: [{ type: "text", text: "Successfully wrote " + params.path },
            { type: "text", text: "[then_run:succeeded]\\n" + output }], details: undefined };
        },
      });
    });
  };
}
`);
  return dir;
}

// A fake SoL-Pi with ObservationPack as upstream 41fa7e0 has it: a pure-text tool result over 10 KB
// is replaced by a placeholder with a new obs_ id after its first 2 provider requests, counted per
// context event, obs_recall returns pages up to 16 KB, and recall results are not exempt. Like upstream, it registers at
// session_start.
function fakeObservationPackPackage(): string {
  const dir = join(tempDir("plc-sol-pi-obs-"), "SoL-Pi");
  mkdirSync(join(dir, "src", "sol-pi"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sol-pi", pi: { extensions: ["./src/sol-pi/index.ts"] } }));
  writeFileSync(join(dir, "src", "sol-pi", "config.ts"), `
export const DEFAULT_CONFIG = Object.freeze({ version: 1, actionFusion: false, observationPack: false,
  evidencePreservingReducer: false, onlineContextCompact: false });
`);
  writeFileSync(join(dir, "src", "sol-pi", "index.ts"), `
import { createHash } from "node:crypto";
import { Type } from "typebox";
const THRESHOLD_BYTES = 10 * 1024;
const FULL_SENDS = 2;
const PAGE_BYTES = 16 * 1024 - 512;
const store = new Map();
const sentCounts = new Map();
export function createSolPiExtension(load) {
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      if (!load(ctx).observationPack) return;
      pi.registerTool({
        name: "obs_recall", label: "Recall", description: "recall",
        parameters: Type.Object({ id: Type.String(), offset: Type.Optional(Type.Integer()) }),
        async execute(_id, params) {
          const text = store.get(params.id);
          if (text === undefined) throw new Error("Unknown observation id: " + params.id);
          const offset = params.offset ?? 0;
          const chunk = text.slice(offset, offset + PAGE_BYTES);
          const nextOffset = offset + chunk.length;
          const eof = nextOffset >= text.length;
          const header = "[obs_recall id=" + params.id + " offset=" + offset + " next_offset=" + nextOffset + " eof=" + eof + "]";
          return { content: [{ type: "text", text: header + "\\n[chunk_bytes=" + chunk.length + "]\\n" + chunk }],
            details: { id: params.id, offset, bytes: chunk.length, nextOffset, eof } };
        },
      });
      pi.on("context", (event) => {
        let after = 0;
        const counts = [];
        for (let i = event.messages.length - 1; i >= 0; i -= 1) {
          counts[i] = after;
          if (event.messages[i].role === "assistant") after += 1;
        }
        const messages = event.messages.map((message, i) => {
          if (message.role !== "toolResult" || message.isError || !message.content.every((b) => b.type === "text")) return message;
          const text = message.content.map((b) => b.text).join("\\n");
          if (Buffer.byteLength(text) <= THRESHOLD_BYTES) return message;
          const id = "obs_" + createHash("sha256").update(message.toolCallId + text).digest("hex").slice(0, 24);
          store.set(id, text);
          // Upstream counts context events per observation, falling back to the assistant messages after it.
          const previous = sentCounts.get(id) ?? counts[i];
          sentCounts.set(id, previous + 1);
          if (previous < FULL_SENDS) return message;
          return { ...message, content: [{ type: "text",
            text: "[large tool result replaced]\\nid: " + id + "\\ntool: " + message.toolName }] };
        });
        return { messages };
      });
    });
  };
}
`);
  return dir;
}

describe("SoL-Pi entries loaded by pi's extension loader", () => {
  const sessions: AgentSession[] = [];
  const savedEntry = process.env.PLC_SOL_PI_ENTRY;
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    if (savedEntry === undefined) delete process.env.PLC_SOL_PI_ENTRY;
    else process.env.PLC_SOL_PI_ENTRY = savedEntry;
  });

  async function sessionWith(
    entryFile: string,
    responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [],
    extraFactories: { name: string; factory: (pi: ExtensionAPI) => void }[] = [],
    retry = false,
  ) {
    const cwd = tempDir("plc-sol-pi-");
    const agentDir = join(cwd, "agent");
    const faux = fauxProvider({ provider: "plc-sol-pi-test", api: "plc-sol-pi-test-api" });
    faux.setResponses(responses);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: retry ? { enabled: true, maxRetries: 2, baseDelayMs: 1 } : { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      additionalExtensionPaths: [packageSource("engine", "extension", entryFile)],
      extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }, ...extraFactories],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "test",
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", resourceLoader: loader, sessionManager, settingsManager,
    });
    sessions.push(session);
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    expect(errors).toEqual([]);
    return { cwd, session, sessionManager };
  }

  // 回归（上游 issue #94）：失败的 then_run 以前被报成成功，模型以为测试通过了。
  it("gives the executor fused write and obs_recall, and reports a failed then_run as a failure", async () => {
    process.env.PLC_SOL_PI_ENTRY = join(fakeSolPiPackage(), "src", "sol-pi", "index.ts");
    const { session, sessionManager } = await sessionWith("sol-pi-executor.ts", [
      fauxAssistantMessage(fauxToolCall("write", {
        path: "kept.txt", content: "keep me\n", then_run: { command: "echo validation failed; exit 7" },
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["write", "obs_recall"]));

    await session.prompt("write and check", { expandPromptTemplates: false });
    const result = sessionManager.getBranch().flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [])[0]!;
    const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    expect(result.isError).toBe(true);
    expect(text).toContain("[then_run:failed]\nvalidation failed");
    expect(text).not.toContain("[then_run:succeeded]");
  });

  // 这个测试会话不限工具，pi 自带的 write 在场。要看的是 SoL-Pi 没有给 Lead 换上带 then_run 的 write。
  it("gives the Lead obs_recall and no fused write", async () => {
    process.env.PLC_SOL_PI_ENTRY = join(fakeSolPiPackage(), "src", "sol-pi", "index.ts");
    const { session } = await sessionWith("sol-pi-lead.ts");
    expect(session.getActiveToolNames()).toContain("obs_recall");
    const write = session.getAllTools().find((tool) => tool.name === "write");
    expect(Object.keys((write?.parameters as { properties?: object } | undefined)?.properties ?? {}))
      .not.toContain("then_run");
  });

  type Seen = { role: string; toolName?: string; text: string };
  type Step = (seen: Seen[]) => ReturnType<typeof fauxAssistantMessage>;
  const callTool = (name: string, args: Parameters<typeof fauxToolCall>[1] = {}): Step =>
    () => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const obsIds = (seen: Seen[]) => new Set(seen.flatMap((m) => [...m.text.matchAll(/obs_[a-f0-9]{24}/g)].map((x) => x[0])));

  // Runs: a large tool result, two more steps (it is packed), obs_recall of it, then `afterRecall`
  // and a final answer. Returns what the provider saw on each request.
  async function recallScenario(afterRecall: Step[]) {
    process.env.PLC_SOL_PI_ENTRY = join(fakeObservationPackPackage(), "src", "sol-pi", "index.ts");
    const big = Array.from({ length: 800 }, (_, i) => `line ${i} of the long ticket brief`).join("\n");
    const tools = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "big", label: "Big", description: "big", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: big }], details: undefined }; },
      });
      pi.registerTool({
        name: "noop", label: "Noop", description: "noop", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "ok" }], details: undefined }; },
      });
    };
    const contexts: Seen[][] = [];
    const step = (call: Step) => (context: { messages: unknown[] }) => {
      contexts.push(context.messages.map((raw) => {
        const message = raw as { role: string; toolName?: string; content: unknown };
        const blocks = Array.isArray(message.content) ? message.content as { type: string; text?: string }[] : [];
        return {
          role: message.role, toolName: message.toolName,
          text: typeof message.content === "string" ? message.content : blocks.map((b) => b.text ?? "").join("\n"),
        };
      }));
      return call(contexts.at(-1)!);
    };
    const { session } = await sessionWith("sol-pi-lead.ts", [
      callTool("big"), callTool("noop"), callTool("noop"),
      (seen: Seen[]) => callTool("obs_recall", { id: [...obsIds(seen)][0], offset: 0 })(seen),
      ...afterRecall,
      () => fauxAssistantMessage("done"),
    ].map(step), [{ name: "tools", factory: tools }], true);
    await session.prompt("read the big result", { expandPromptTemplates: false });
    const originalId = [...obsIds(contexts[3]!)][0]!;
    return { contexts, originalId };
  }

  // Regression: a recalled page over 10 KB was packed again under a new obs_ id two steps later,
  // and recalling that id gave yet another one. The page is now folded into a pointer to the
  // original id and offset, and no new id appears.
  it("folds a stale obs_recall page into a pointer to the original id instead of a new observation", async () => {
    const { contexts, originalId } = await recallScenario([callTool("noop"), callTool("noop")]);
    expect(contexts).toHaveLength(7);
    // The first two requests after the recall still carry the whole page.
    const fresh = contexts[5]!.find((m) => m.toolName === "obs_recall")!;
    expect(Buffer.byteLength(fresh.text)).toBeGreaterThan(OBSERVATION_THRESHOLD_BYTES);
    const recall = contexts[6]!.find((m) => m.toolName === "obs_recall")!;
    expect(recall.text).toContain(`{"id":"${originalId}","offset":0}`);
    expect(recall.text).not.toContain("[large tool result replaced]");
    for (const seen of contexts) expect([...obsIds(seen)].filter((id) => id !== originalId)).toEqual([]);
  });

  // Regression: ObservationPack counts context events, and a failed request that pi retries is
  // dropped from the context but was counted. Counting only the assistant messages after the page
  // folded it one request too late, and the provider saw the page under a new obs_ id.
  it("folds the page in time when a request after the recall fails and pi retries it", async () => {
    const { contexts, originalId } = await recallScenario([
      () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      callTool("noop"),
    ]);
    // Requests: big, noop, noop, recall, the failed one, its retry, and the final answer.
    expect(contexts).toHaveLength(7);
    expect(contexts[5]!.map((m) => m.role)).toEqual(contexts[4]!.map((m) => m.role));
    const recall = contexts[6]!.find((m) => m.toolName === "obs_recall")!;
    expect(recall.text).toContain(`{"id":"${originalId}","offset":0}`);
    expect(recall.text).not.toContain("[large tool result replaced]");
    for (const seen of contexts) expect([...obsIds(seen)].filter((id) => id !== originalId)).toEqual([]);
  });

  // 没装（测试、首次安装完成之前）时入口什么也不做，会话照常起来。
  it("does nothing when the package is not installed", async () => {
    delete process.env.PLC_SOL_PI_ENTRY;
    const { session } = await sessionWith("sol-pi-executor.ts");
    expect(session.getAllTools().map((tool) => tool.name)).not.toContain("obs_recall");
  });
});

describe("SoL-Pi package managed by pi's package manager", () => {
  function fakeManager(installedDir: string | undefined, install: () => Promise<void> = async () => {}) {
    const calls: string[] = [];
    let dir = installedDir;
    return {
      calls,
      setInstalled: (path: string) => { dir = path; },
      manager: {
        getInstalledPath: (source: string) => { calls.push(`path ${source}`); return dir; },
        install: async (source: string) => { calls.push(`install ${source}`); await install(); },
        // pi 的包管理器按 manifest 解析出扩展入口。
        resolveExtensionSources: async (sources: string[]) => {
          calls.push(`resolve ${sources.join(",")}`);
          const path = join(dir!, "src", "sol-pi", "index.ts");
          return {
            extensions: [{ path, enabled: true, metadata: { source: sources[0]!, scope: "user" as const, origin: "package" as const } }],
            skills: [], prompts: [], themes: [],
          };
        },
      },
    };
  }

  const PINNED = solPiPinnedCommit(SOL_PI_SOURCE);
  const atPinned = () => PINNED;

  it("activates an installed copy without the network, then aligns it to the pinned source", async () => {
    const pkg = fakeSolPiPackage();
    const env: Record<string, string | undefined> = {};
    const { manager, calls } = fakeManager(pkg);
    const lines: string[] = [];
    const solPi = solPiPackage({
      agentDir: "/unused", cwd: "/unused", env, packageManager: manager, headOf: atPinned, log: (line) => lines.push(line),
    });

    expect(await solPi.activate()).toBe(true);
    expect(env.PLC_SOL_PI_ENTRY).toBe(join(pkg, "src", "sol-pi", "index.ts"));
    // 部署时据此确认 daemon 用的是哪一个 commit。
    expect(lines).toEqual([`[sol-pi] active at ${PINNED.slice(0, 7)}`]);
    // 已经加载的不算新装好：daemon 不用重载 Lead。
    expect(await solPi.sync()).toBe(false);
    expect(calls).toContain(`install ${SOL_PI_SOURCE}`);
  });

  // 安全评审 M1：pi 第一次安装先 clone 默认分支，再 checkout 固定的 commit。daemon 在两步之间停掉时，
  // checkout 留在默认分支上。以前下次启动会直接加载它，没评审过的代码就在 daemon 进程里运行。
  it("does not load a checkout that is not at the pinned commit, and loads it once sync aligns it", async () => {
    const pkg = fakeSolPiPackage();
    const env: Record<string, string | undefined> = {};
    let head = "0".repeat(40);
    const lines: string[] = [];
    const { manager, calls } = fakeManager(pkg, async () => { head = PINNED; });
    const solPi = solPiPackage({
      agentDir: "/unused", cwd: "/unused", env, packageManager: manager, headOf: () => head, log: (l) => lines.push(l),
    });

    expect(await solPi.activate()).toBe(false);
    expect(env.PLC_SOL_PI_ENTRY).toBeUndefined();
    expect(calls.some((call) => call.startsWith("resolve"))).toBe(false);
    expect(lines[0]).toContain(`not the pinned ${PINNED}`);

    // sync 对齐之后才加载，返回 true：daemon 据此把它加载进正在运行的 Lead。
    expect(await solPi.sync()).toBe(true);
    expect(env.PLC_SOL_PI_ENTRY).toBe(join(pkg, "src", "sol-pi", "index.ts"));
  });

  it("reads HEAD from the real checkout with git", async () => {
    const pkg = fakeSolPiPackage();
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: pkg, stdio: "ignore",
    });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "default branch");
    const env: Record<string, string | undefined> = {};
    const lines: string[] = [];
    const solPi = solPiPackage({ agentDir: "/unused", cwd: "/unused", env, packageManager: fakeManager(pkg).manager, log: (l) => lines.push(l) });
    expect(await solPi.activate()).toBe(false);
    expect(env.PLC_SOL_PI_ENTRY).toBeUndefined();
    expect(lines[0]).toMatch(/is at [0-9a-f]{40}, not the pinned/);
  });

  it("installs in the background when missing, and keeps SoL-Pi off when the install fails", async () => {
    const pkg = fakeSolPiPackage();
    const env: Record<string, string | undefined> = {};
    const fake = fakeManager(undefined, async () => fake.setInstalled(pkg));
    const lines: string[] = [];
    const solPi = solPiPackage({
      agentDir: "/unused", cwd: "/unused", env, packageManager: fake.manager, headOf: atPinned, log: (l) => lines.push(l),
    });
    expect(await solPi.activate()).toBe(false);
    expect(await solPi.sync()).toBe(true);
    expect(env.PLC_SOL_PI_ENTRY).toBe(join(pkg, "src", "sol-pi", "index.ts"));

    const offline: Record<string, string | undefined> = {};
    const failing = fakeManager(undefined, async () => { throw new Error("getaddrinfo ENOTFOUND github.com"); });
    await solPiPackage({ agentDir: "/unused", cwd: "/unused", env: offline, packageManager: failing.manager, log: (l) => lines.push(l) }).sync();
    expect(offline.PLC_SOL_PI_ENTRY).toBeUndefined();
    expect(lines.at(-1)).toMatch(/could not install .*ENOTFOUND.*SoL-Pi is off/);
  });

  it("does not install when both roles turn SoL-Pi off", async () => {
    const env: Record<string, string | undefined> = { PLC_SOL_PI: "off", PLC_LEAD_SOL_PI: "off" };
    const { manager, calls } = fakeManager(undefined);
    const solPi = solPiPackage({ agentDir: "/unused", cwd: "/unused", env, packageManager: manager, log: () => {} });
    expect(await solPi.activate()).toBe(false);
    await solPi.sync();
    expect(calls).toEqual([]);
  });

  it("leaves a preset PLC_SOL_PI_ENTRY alone and validates PLC_SOL_PI_SOURCE", async () => {
    const env: Record<string, string | undefined> = { PLC_SOL_PI_ENTRY: "/checkout/src/sol-pi/index.ts" };
    const { manager, calls } = fakeManager(undefined);
    const solPi = solPiPackage({ agentDir: "/unused", cwd: "/unused", env, packageManager: manager, log: () => {} });
    expect(await solPi.activate()).toBe(true);
    await solPi.sync();
    expect(calls).toEqual([]);
    expect(env.PLC_SOL_PI_ENTRY).toBe("/checkout/src/sol-pi/index.ts");

  });

  // 安全评审 L1：只接受固定到完整 commit 的 git 来源。tag 和分支会移动；npm 安装会跑生命周期脚本。
  it("accepts only git sources pinned to a full commit", () => {
    const pinned = `git:github.com/NVlabs/SoL-Pi@${"a".repeat(40)}`;
    expect(solPiSource({ PLC_SOL_PI_SOURCE: pinned })).toBe(pinned);
    expect(solPiPinnedCommit(pinned)).toBe("a".repeat(40));
    for (const source of [
      "git:github.com/NVlabs/SoL-Pi@v0.2.0", "git:github.com/NVlabs/SoL-Pi@main", "git:github.com/NVlabs/SoL-Pi",
      `npm:sol-pi@0.1.0`, `git:github.com/x/../y@${"a".repeat(40)}`, `git:github.com/x/y; rm -rf ~@${"a".repeat(40)}`,
      "/tmp/sol-pi",
    ]) {
      expect(() => solPiSource({ PLC_SOL_PI_SOURCE: source }), source).toThrow(/40-hex commit/);
    }
  });
});

// 安全评审 L5：没选的机制显式关掉。以后升级 commit 时，上游的缺省值变了，也不会悄悄打开它们。
describe("solPiConfig", () => {
  it("turns off every mechanism that was not selected, whatever upstream defaults say", () => {
    const upstream = { version: 1, actionFusion: true, observationPack: true, evidencePreservingReducer: true, onlineContextCompact: true };
    expect(solPiConfig(upstream, solPiSettings("lead", {}))).toMatchObject({
      actionFusion: false, observationPack: true, evidencePreservingReducer: false, onlineContextCompact: false,
    });
    expect(solPiConfig(upstream, solPiSettings("executor", { PLC_SOL_PI: "off" }))).toMatchObject({
      actionFusion: false, observationPack: false, evidencePreservingReducer: false, onlineContextCompact: false,
    });
  });
});

describe("foldStaleRecallPages", () => {
  const page = (text: string, details?: Record<string, string | number | boolean>) => ({
    role: "toolResult" as const, toolCallId: "call-1", toolName: "obs_recall", isError: false, timestamp: 0,
    content: [{ type: "text" as const, text }], ...(details ? { details } : {}),
  });
  const assistant = { role: "assistant" as const, content: [], timestamp: 0 } as never;
  const id = `obs_${"a".repeat(24)}`;
  const header = `[obs_recall id=${id} offset=15872 next_offset=31744 eof=false]\n`;
  const large = header + "x".repeat(OBSERVATION_THRESHOLD_BYTES);

  it("folds a page over 10 KB once two assistant messages follow it, reading the header when details are missing", () => {
    expect(foldStaleRecallPages([page(large), assistant])).toBeUndefined();
    const folded = foldStaleRecallPages([page(large), assistant, assistant])!;
    const text = (folded[0] as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain(`{"id":"${id}","offset":15872}`);
    expect(text).toContain("next_offset: 31744");
    expect(Buffer.byteLength(text)).toBeLessThan(1024);
  });

  // A retried request adds a context event but no assistant message: the shared count still folds
  // the page on the third context event, as ObservationPack replaces it then.
  it("counts context events with a shared map, so a retried request still counts", () => {
    const sends = new Map<string, number>();
    expect(foldStaleRecallPages([page(large)], sends)).toBeUndefined();
    expect(foldStaleRecallPages([page(large)], sends)).toBeUndefined();
    const folded = foldStaleRecallPages([page(large), assistant], sends)!;
    expect((folded[0] as { content: { text: string }[] }).content[0]!.text).toContain(`{"id":"${id}","offset":15872}`);
    expect(foldStaleRecallPages([page(large), assistant], new Map())).toBeUndefined();
  });

  it("prefers details, and leaves small pages, failed recalls and other tools alone", () => {
    const fromDetails = foldStaleRecallPages([
      page("y".repeat(OBSERVATION_THRESHOLD_BYTES + 1), { id, offset: 0, nextOffset: 15872, eof: false }), assistant, assistant,
    ])!;
    expect((fromDetails[0] as { content: { text: string }[] }).content[0]!.text).toContain(`{"id":"${id}","offset":0}`);
    expect(foldStaleRecallPages([page(header + "small"), assistant, assistant])).toBeUndefined();
    expect(foldStaleRecallPages([{ ...page(large), isError: true }, assistant, assistant])).toBeUndefined();
    expect(foldStaleRecallPages([{ ...page(large), toolName: "read" }, assistant, assistant])).toBeUndefined();
  });
});
