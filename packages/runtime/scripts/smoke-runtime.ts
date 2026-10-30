import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../src/codex.js";
import { ClaudeRuntime } from "../src/claude.js";
import type { AgentRuntime, RuntimeEvent } from "../src/types.js";

const runtimeId = process.argv[2];
if (runtimeId !== "codex" && runtimeId !== "claude") {
  throw new Error("usage: npm run smoke:runtime -- codex|claude");
}

const runtime: AgentRuntime = runtimeId === "codex" ? new CodexRuntime() : new ClaudeRuntime();
const workdir = mkdtempSync(join(tmpdir(), `plc-${runtimeId}-smoke-`));
execFileSync("git", ["init", "-q", workdir]);
const marker = `runtime-${runtimeId}-verified`;
const markerPath = join(workdir, "marker.txt");
const handle = await runtime.start({
  itemId: 1,
  runId: 1,
  role: "executor",
  purpose: "execution",
  prompt: `Create marker.txt in the current repository with exactly this one line and no other content: ${marker}. Do not explain; perform the edit and finish.`,
  workdir,
  sessionDir: join(workdir, ".sessions"),
  env: {},
});

const events: RuntimeEvent[] = [];
const consume = (async () => {
  for await (const event of handle.events) events.push(event);
})();
const timeoutMs = Number(process.env.PLC_RUNTIME_SMOKE_TIMEOUT_MS ?? 120_000);
// 用 ReturnType 而非 NodeJS.Timeout：本项目 tsconfig 未指定 lib，ES2022 默认带进 DOM，
// setTimeout 会解析成返回 number 的 DOM 版本。ReturnType 在两种 lib 下都成立。
let timer: ReturnType<typeof setTimeout> | undefined;
const timeout = new Promise<never>((_, reject) => {
  timer = setTimeout(() => reject(new Error(`${runtimeId} smoke timed out after ${timeoutMs}ms`)), timeoutMs);
});

try {
  const exit = await Promise.race([handle.wait(), timeout]);
  await consume;
  if (!exit.ok) throw new Error(`${runtimeId} failed: ${exit.errorCode}: ${exit.errorMessage}`);
  const content = readFileSync(markerPath, "utf8").trim();
  if (content !== marker) throw new Error(`unexpected marker content: ${JSON.stringify(content)}`);
  console.log(JSON.stringify({
    runtime: runtimeId,
    ok: true,
    workdir,
    externalSessionId: exit.externalSessionId,
    eventTypes: events.map((event) => event.type),
  }));
  // CLI 已经退出，可以删除工作目录。失败时留下工作目录，方便查看 CLI 做了什么。
  rmSync(workdir, { recursive: true, force: true });
} catch (error) {
  await handle.interrupt(error instanceof Error ? error.message : String(error)).catch(() => {});
  throw error;
} finally {
  if (timer) clearTimeout(timer);
}
