// pi 子进程的沙箱扩展（lead-tools-and-routing spec D2、D15）：真实的 pi 会话加载它，模型是 pi-ai 的假模型。
// 沙箱是真的，只在 macOS 和 Linux 上跑。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSandboxExtension } from "../src/extension/sandbox.js";
import { resetSandboxForTests } from "../src/sandbox/bash.js";

const supported = process.platform === "darwin" || process.platform === "linux";
type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];
const call = (name: string, args: Record<string, unknown>): Step =>
  fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

async function childSession(workdir: string, steps: Step[]) {
  const faux = fauxProvider({ provider: "plc-sandbox-ext-test", api: "plc-sandbox-ext-test-api" });
  faux.setResponses([...steps, fauxAssistantMessage("done")]);
  const agentDir = join(workdir, ".agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: workdir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "test",
    extensionFactories: [
      { name: "provider", factory: (pi) => pi.registerProvider(faux.provider) },
      { name: "plc-sandbox", factory: createSandboxExtension(workdir) },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: workdir, agentDir, model: faux.getModel() as never, thinkingLevel: "off",
    resourceLoader: loader, sessionManager: SessionManager.inMemory(workdir), settingsManager,
    tools: ["read", "bash", "edit", "write"],
  });
  await session.bindExtensions({});
  const results: Array<{ name: string; isError: boolean; text: string }> = [];
  session.subscribe((event: any) => {
    if (event.type !== "tool_execution_end") return;
    const text = (event.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
    results.push({ name: event.toolName, isError: Boolean(event.isError), text });
  });
  await session.prompt("go", { expandPromptTemplates: false });
  session.dispose();
  return results;
}

// 2026-10-28 用户：「Fairy 和执行者的命令能写整个 home……只挡绕出沙箱的路径、私钥和 plc 自己的账本密钥」。
// plc 的数据目录指到这个测试自己的目录，挡不住时也不会碰用户真的配置。
describe.runIf(supported)("the pi child sandbox extension", () => {
  const base = mkdtempSync(join(homedir(), ".plc-sandbox-ext-"));
  const dataDir = join(base, "data");
  mkdirSync(dataDir);
  const previousDataDir = process.env.PLC_DATA_DIR;
  process.env.PLC_DATA_DIR = dataDir;
  afterAll(async () => {
    await resetSandboxForTests();
    if (previousDataDir === undefined) delete process.env.PLC_DATA_DIR;
    else process.env.PLC_DATA_DIR = previousDataDir;
    rmSync(base, { recursive: true, force: true });
  });

  it("runs bash in the sandbox: home is writable, plc's own config is not", async () => {
    const workdir = join(base, "w1");
    mkdirSync(workdir);
    const elsewhere = join(base, "elsewhere.txt");
    const config = join(dataDir, "config.json");
    const results = await childSession(workdir, [
      call("bash", { command: "echo built > out.txt && cat out.txt" }),
      call("bash", { command: `echo yes > ${elsewhere}` }),
      call("bash", { command: `echo no > ${config}` }),
    ]);
    expect(results[0]?.text).toContain("built");
    expect(readFileSync(join(workdir, "out.txt"), "utf8").trim()).toBe("built");
    expect(readFileSync(elsewhere, "utf8").trim()).toBe("yes");
    expect(results[2]?.isError).toBe(true);
    expect(existsSync(config)).toBe(false);
  }, 90_000);

  it("keeps edit and write to the same boundary as bash", async () => {
    const workdir = join(base, "w2");
    mkdirSync(workdir);
    const outside = join(dataDir, "plc.db");
    const results = await childSession(workdir, [
      call("write", { path: "inside.txt", content: "ok" }),
      call("write", { path: outside, content: "no" }),
    ]);
    expect(readFileSync(join(workdir, "inside.txt"), "utf8")).toBe("ok");
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.text).toContain("plc 的账本和配置");
    expect(existsSync(outside)).toBe(false);
  }, 90_000);
});
