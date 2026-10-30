# M9 部署硬化 + 生命周期技术债 + 记忆层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** launchd 常驻不丢凭证（build/launchd/doctor/config.json 凭证）+ daemon 重启不丢工作（自动重派/通知目标持久化）+ Hermes 式双层记忆（kind 分类 + 常驻核心记忆 + FTS5 检索，无 embedding）。

**Architecture:** 沿既有分层——store/（DAO+schema 迁移）、lead/（工具+提示词+沉淀）、daemon/（生命周期）、新增 deploy/（launchd+doctor）。spec 见 `docs/superpowers/specs/2026-07-22-m9-hardening-memory-design.md`。

**Tech Stack:** TypeScript（**全部源码必须 TS，含测试与脚本**，spec §0.1）、better-sqlite3（FTS5 trigram）、esbuild（external: better-sqlite3）、launchd plist、vitest + fake-pi。

**测试基线：** 开工前 `npx vitest run` 应为 120 passed。每个任务结束全量测试必须绿。

---

### Task 1: TS-only 存量迁移（spec §0.1）

**Files:**
- Create: `test/fake-pi.ts`（内容来自 `test/fake-pi.mjs`）
- Create: `scripts/e2e-m4.ts`、`scripts/e2e-m5.ts`（内容来自同名 .mjs）
- Delete: `test/fake-pi.mjs`、`scripts/e2e-m4.mjs`、`scripts/e2e-m5.mjs`
- Modify: 所有引用处（`grep -rn "fake-pi.mjs\|e2e-m4.mjs\|e2e-m5.mjs" test/ src/ scripts/ docs/ package.json` 的全部命中，已知：`test/fake-pi.test.ts`、`test/lead-tools.test.ts`、`test/linger.test.ts` 等 7 文件）

- [ ] **Step 1: 迁移 fake-pi**

`git mv test/fake-pi.mjs test/fake-pi.ts`，然后加最小类型标注（逻辑零改动）：

```ts
// 模拟 pi --mode rpc 的最小协议实现（仅测试用）。
// 协议依据 @mariozechner/pi-coding-agent@0.73.1 docs/rpc.md。
import { StringDecoder } from "node:string_decoder";

const scenario = process.env.FAKE_SCENARIO ?? "happy";
const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(cmd: any): void {
  // …（其余逻辑与原 .mjs 逐行相同，仅 handle/finish 参数标 any）
}

function finish(cmd: any): void { /* 同原文件 */ }
```

- [ ] **Step 2: 更新所有引用**

TS 版 fake-pi 需经 tsx 运行——`process.execPath` 换成 tsx bin：

```ts
// test/fake-pi.test.ts（原 spawn(process.execPath, ["test/fake-pi.mjs"])）
const proc = spawn(resolve("node_modules/.bin/tsx"), [resolve("test/fake-pi.ts")]);

// test/lead-tools.test.ts / test/linger.test.ts 等所有 childPi 注入处
childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("test/fake-pi.ts")] },
```

- [ ] **Step 3: 迁移 e2e 脚本**

`git mv scripts/e2e-m4.mjs scripts/e2e-m4.ts`（m5 同理），加最小类型标注；脚本内部若引用 fake-pi.mjs 同步改。运行方式：`npx tsx scripts/e2e-m4.ts`。

- [ ] **Step 4: 全量测试**

Run: `npx vitest run`
Expected: 120 passed（迁移零行为变化）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: migrate all JS sources to TS (fake-pi, e2e scripts) - TS-only policy"
```

---

### Task 2: 凭证配置 loadEnvConfig（spec §B2）

**Files:**
- Modify: `src/config.ts`
- Modify: `src/daemon/main.ts`、`src/cli.ts`（入口调用）
- Test: `test/env-config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/env-config.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvConfig } from "../src/config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "plc-")); });

describe("loadEnvConfig", () => {
  it("config value 优先于已有环境变量", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { AM_API_KEY: { value: "from-config" } } }));
    const env: Record<string, string | undefined> = { AM_API_KEY: "from-env" };
    expect(loadEnvConfig(dir, env)).toEqual(["AM_API_KEY"]);
    expect(env.AM_API_KEY).toBe("from-config");
  });

  it("fromEnv 从指定环境变量间接取值", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { TAVILY_API_KEY: { fromEnv: "MY_TAVILY" } } }));
    const env: Record<string, string | undefined> = { MY_TAVILY: "indirect" };
    loadEnvConfig(dir, env);
    expect(env.TAVILY_API_KEY).toBe("indirect");
  });

  it("config 未覆盖的 key 回退环境变量原值；fromEnv 源缺失不清空已有值", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { A: { fromEnv: "MISSING" } } }));
    const env: Record<string, string | undefined> = { A: "keep", B: "untouched" };
    expect(loadEnvConfig(dir, env)).toEqual([]);
    expect(env.A).toBe("keep");
    expect(env.B).toBe("untouched");
  });

  it("无 config.json 静默返回空", () => {
    expect(loadEnvConfig(dir, {})).toEqual([]);
  });

  it("config.json 损坏时抛出带路径的错误", () => {
    writeFileSync(join(dir, "config.json"), "{broken");
    expect(() => loadEnvConfig(dir, {})).toThrow(/config\.json/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/env-config.test.ts`
Expected: FAIL（loadEnvConfig 不存在）

- [ ] **Step 3: 实现**

`src/config.ts` 追加（`readFileSync`/`existsSync` 从 node:fs 引入）：

```ts
// 凭证与环境配置（spec §B2）：config.json 的 env 段。value 直接给值，fromEnv 间接引用环境变量名。
// 优先级：config.json > 进程环境变量；config 未覆盖的 key 保持 env 原值。密钥不进 plc.db / plist。
export interface EnvSpec { value?: string; fromEnv?: string }

export function envConfigPath(dir: string = dataDir()): string {
  return join(dir, "config.json");
}

export function loadEnvConfig(
  dir: string = dataDir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const path = envConfigPath(dir);
  if (!existsSync(path)) return [];
  let conf: { env?: Record<string, EnvSpec> };
  try {
    conf = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    throw new Error(`config.json 解析失败（${path}）: ${e.message}`);
  }
  const applied: string[] = [];
  for (const [key, spec] of Object.entries(conf.env ?? {})) {
    const val = spec.value ?? (spec.fromEnv ? env[spec.fromEnv] : undefined);
    if (val !== undefined) { env[key] = val; applied.push(key); }
  }
  return applied;
}
```

入口接线——`src/daemon/main.ts` 第一个 import 后：

```ts
import { dataDir, dbPath, loadEnvConfig } from "../config.js";
import { startDaemon } from "./server.js";

const applied = loadEnvConfig();
if (applied.length) console.log(`[config] env keys applied: ${applied.join(", ")}`);
```

`src/cli.ts`：`program.parse()` 之前加 `loadEnvConfig();`（import 处加 loadEnvConfig）。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npx vitest run`
Expected: 全绿（125 passed）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: config.json env credentials (value/fromEnv, config > env fallback)"
```

---

### Task 3: esbuild 构建 + projectRoot 打包安全（spec §B1）

**Files:**
- Create: `scripts/build.ts`
- Modify: `package.json`（build script + esbuild devDep）、`bin/plc`、`src/cli.ts`（daemonCommand）、`src/config.ts`（projectRoot）、`src/children/manager.ts`（改用 projectRoot）
- Test: `test/project-root.test.ts`

**背景（打包踩坑预防）：** `manager.ts` 的 `PROJECT_ROOT = new URL("../..", import.meta.url)` 在 src/children/ 下是仓库根，打包进 `dist/coordinatord.mjs`（深度 1）后变成**仓库父目录**——pi bin/extension 路径全错。必须先改为向上找 package.json 的动态解析。

- [ ] **Step 1: 写 projectRoot 失败测试**

```ts
// test/project-root.test.ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../src/config.js";

describe("projectRoot", () => {
  it("从任意源码深度解析到含 package.json 的仓库根", () => {
    const root = projectRoot();
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "src", "cli.ts"))).toBe(true);
  });
});
```

Run: `npx vitest run test/project-root.test.ts` → FAIL

- [ ] **Step 2: 实现 projectRoot 并替换两处硬编码**

`src/config.ts`（`dirname` 从 node:path、`fileURLToPath` 从 node:url 引入）：

```ts
// 仓库根定位：向上找 package.json。不能用固定 "../.."——打包到 dist/ 后文件深度会变（实坑预防）。
let cachedRoot: string | undefined;
export function projectRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("projectRoot: package.json not found upward");
    dir = parent;
  }
  return (cachedRoot = dir);
}
```

`src/children/manager.ts`：删除 `const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));`，改：

```ts
import { projectRoot } from "../config.js";
export const DEFAULT_PI_BIN = join(projectRoot(), "node_modules", ".bin", "pi");
export const TICKET_TOOLS_EXT = join(projectRoot(), "src", "extension", "ticket-tools.ts");
export const WEB_TOOLS_EXT = join(projectRoot(), "src", "extension", "web-tools.ts");
```

`src/cli.ts`：`const PROJECT_ROOT = fileURLToPath(...)` 改为 `import { projectRoot } from "./config.js"` 后 `const PROJECT_ROOT = projectRoot();`（用法不变）。

Run: `npx vitest run` → 全绿

- [ ] **Step 3: 构建脚本**

`npm i -D esbuild`，然后：

```ts
// scripts/build.ts — esbuild 打包（spec §B1）。better-sqlite3 是 native addon 必须 external；
// 运行时靠仓库 node_modules 解析。目标：launchd 跑 node dist/，不依赖 tsx。
import { build } from "esbuild";

const external = [
  "better-sqlite3",
  // pi SDK 若打包失败（动态 require/资源文件），按 spec §B1 决策规则加入 external：
  // "@mariozechner/pi-coding-agent",
];

await build({
  entryPoints: { coordinatord: "src/daemon/main.ts", cli: "src/cli.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external,
  // ESM bundle 里 CJS 依赖需要 require/__dirname 垫片
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  logLevel: "info",
});
console.log("build ok: dist/coordinatord.mjs, dist/cli.mjs");
```

`package.json` scripts 加：`"build": "tsx scripts/build.ts"`。

- [ ] **Step 4: 构建并冒烟验证**

Run: `npm run build && node dist/cli.mjs --help && PLC_DATA_DIR=$(mktemp -d) node dist/cli.mjs list`
Expected: help 输出正常；list 空表不报错（验证 better-sqlite3 external 解析 + db 打开）。
若 build 或运行报 pi SDK 相关错误 → 把 `"@mariozechner/pi-coding-agent"` 加进 external 重试（决策规则见 spec §B1）。

- [ ] **Step 5: bin/plc 与 daemon 拉起优先 dist**

`bin/plc`：

```sh
#!/bin/sh
# pi-lead-child CLI wrapper — 构建产物优先（launchd/生产），PLC_DEV=1 或无 dist 时回退 tsx 源码
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
if [ -f "$DIR/dist/cli.mjs" ] && [ -z "$PLC_DEV" ]; then
  exec node "$DIR/dist/cli.mjs" "$@"
fi
exec "$DIR/node_modules/.bin/tsx" "$DIR/src/cli.ts" "$@"
```

`src/cli.ts` 的 `spawnDaemonDetached` 改为：

```ts
// daemon 启动命令：dist 构建产物优先（与 launchd 同一入口），PLC_DEV=1 或未构建时回退 tsx 源码
export function daemonCommand(): { bin: string; args: string[] } {
  const dist = join(PROJECT_ROOT, "dist", "coordinatord.mjs");
  if (existsSync(dist) && !process.env.PLC_DEV) return { bin: process.execPath, args: [dist] };
  return {
    bin: join(PROJECT_ROOT, "node_modules", ".bin", "tsx"),
    args: [join(PROJECT_ROOT, "src", "daemon", "main.ts")],
  };
}

function spawnDaemonDetached(): void {
  const logFd = openSync(join(dataDir(), "daemon.log"), "a");
  const { bin, args } = daemonCommand();
  const proc = spawn(bin, args, { detached: true, stdio: ["ignore", logFd, logFd], env: process.env });
  proc.unref();
}
```

- [ ] **Step 6: 全量测试 + Commit**

Run: `npx vitest run` → 全绿；`.gitignore` 加 `dist/`。

```bash
git add -A && git commit -m "feat: esbuild bundle (external native deps) + bundle-safe projectRoot + dist-first launcher"
```

---

### Task 4: launchd 集成（spec §B3）

**Files:**
- Create: `src/deploy/launchd.ts`
- Modify: `src/cli.ts`（daemon install/uninstall/status）
- Test: `test/launchd.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/launchd.test.ts
import { describe, it, expect } from "vitest";
import { plistContent, LAUNCHD_LABEL } from "../src/deploy/launchd.js";

describe("plistContent", () => {
  const xml = plistContent({
    nodeBin: "/usr/local/bin/node",
    entry: "/repo/dist/coordinatord.mjs",
    cwd: "/repo",
    logDir: "/home/.pi-lead-child/logs",
  });
  it("包含 label、入口、工作目录与日志路径", () => {
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/repo/dist/coordinatord.mjs</string>");
    expect(xml).toContain("<string>/repo</string>");
    expect(xml).toContain("coordinatord.out.log");
    expect(xml).toContain("coordinatord.err.log");
  });
  it("KeepAlive 仅在非正常退出时拉起（plc daemon stop 后不复活），带 Throttle", () => {
    expect(xml).toContain("<key>SuccessfulExit</key>");
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    expect(xml).toContain("<key>RunAtLoad</key>");
  });
});
```

Run: `npx vitest run test/launchd.test.ts` → FAIL

- [ ] **Step 2: 实现**

```ts
// src/deploy/launchd.ts — 本机 launchd 集成（spec §B3）。plist 不含密钥（凭证走 config.json）。
// KeepAlive={SuccessfulExit:false}：崩溃(非零退出)拉起；plc daemon stop 正常退出后不复活。
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

export const LAUNCHD_LABEL = "com.pi-lead-child.coordinatord";

export interface PlistOpts { nodeBin: string; entry: string; cwd: string; logDir: string }

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function plistContent(o: PlistOpts): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${o.nodeBin}</string>
    <string>${o.entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${o.cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${join(o.logDir, "coordinatord.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(o.logDir, "coordinatord.err.log")}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("launchctl", args, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout + stderr).trim() }));
  });
}

export async function installAgent(plist: string, content: string): Promise<string> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, content);
  await launchctl(["bootout", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]); // 已装则先卸（幂等）
  const r = await launchctl(["bootstrap", `gui/${process.getuid!()}`, plist]);
  if (!r.ok) throw new Error(`launchctl bootstrap 失败: ${r.out}`);
  return plist;
}

export async function uninstallAgent(plist: string): Promise<void> {
  await launchctl(["bootout", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
  const { rmSync } = await import("node:fs");
  rmSync(plist, { force: true });
}

export async function agentStatus(): Promise<string | null> {
  const r = await launchctl(["print", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
  return r.ok ? r.out : null; // null = 未加载
}
```

- [ ] **Step 3: CLI 接线**

`src/cli.ts` daemonCmd 追加（import 放文件顶部区）：

```ts
daemonCmd.command("install").description("安装 launchd 常驻（开机自启+崩溃拉起）").action(async () => {
  const { installAgent, plistContent, plistPath } = await import("./deploy/launchd.js");
  const { mkdirSync } = await import("node:fs");
  const entry = join(PROJECT_ROOT, "dist", "coordinatord.mjs");
  if (!existsSync(entry)) { console.error("先构建: npm run build"); process.exit(1); }
  const logDir = join(dataDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const p = await installAgent(plistPath(), plistContent({
    nodeBin: process.execPath, entry, cwd: PROJECT_ROOT, logDir,
  }));
  console.log(`已安装并启动: ${p}\n日志: ${logDir}/coordinatord.{out,err}.log`);
});
daemonCmd.command("uninstall").description("卸载 launchd 常驻").action(async () => {
  const { uninstallAgent, plistPath } = await import("./deploy/launchd.js");
  await uninstallAgent(plistPath());
  console.log("已卸载（daemon 进程随 bootout 停止）");
});
```

`daemon status` 增补 launchd 态：在现有输出前加：

```ts
const { agentStatus } = await import("./deploy/launchd.js");
console.log(`launchd: ${(await agentStatus()) !== null ? "loaded" : "not loaded"}`);
```

注意：daemon 单实例探测会让 launchd 拉起的第二实例退出——`src/daemon/main.ts` 捕获该错误时 `process.exit(0)`（正常退出→KeepAlive 不循环重试）：

```ts
try {
  const d = await startDaemon({ dataDir: dataDir(), dbPath: dbPath() });
  const stop = () => { void d.close().then(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (e: any) {
  if (/already running/.test(e.message)) { console.log(e.message); process.exit(0); }
  throw e;
}
```

- [ ] **Step 4: 测试 + Commit**

Run: `npx vitest run` → 全绿

```bash
git add -A && git commit -m "feat: launchd install/uninstall/status (KeepAlive on crash only, no secrets in plist)"
```

---

### Task 5: plc doctor（spec §B4）

**Files:**
- Create: `src/deploy/doctor.ts`
- Modify: `src/cli.ts`
- Test: `test/doctor.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/doctor.test.ts — probes 全部注入，纯逻辑测试
import { describe, it, expect } from "vitest";
import { runDoctor, type DoctorProbes } from "../src/deploy/doctor.js";

const okProbes: DoctorProbes = {
  daemonAlive: async () => true,
  dbOpens: () => true,
  resolveKey: (k) => (k === "AM_API_KEY" ? "config" : k === "TAVILY_API_KEY" ? "env" : null),
  configPerms: () => "600",
  aishConfigured: () => true,
  launchdLoaded: async () => true,
  distFresh: () => true,
  fts5Available: () => true,
  nodeVersion: () => "v22.1.0",
};

describe("runDoctor", () => {
  it("全部健康时无 fail 项", async () => {
    const checks = await runDoctor(okProbes);
    expect(checks.every((c) => c.ok !== false)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(8);
  });
  it("AM_API_KEY 缺失是 fail 并给修复提示；TAVILY 缺失只是 warn(–)", async () => {
    const checks = await runDoctor({ ...okProbes, resolveKey: () => null });
    const am = checks.find((c) => c.name.includes("AM_API_KEY"))!;
    expect(am.ok).toBe(false);
    expect(am.fix).toMatch(/config\.json/);
    const tavily = checks.find((c) => c.name.includes("TAVILY"))!;
    expect(tavily.ok).toBeNull(); // 可选项缺失 = "–" 不是 "✗"
  });
  it("config 权限过宽是 fail", async () => {
    const checks = await runDoctor({ ...okProbes, configPerms: () => "644" });
    expect(checks.find((c) => c.name.includes("权限"))!.ok).toBe(false);
  });
  it("daemon 不在线时 aish 实连检查降级为 –（不误报）", async () => {
    const checks = await runDoctor({ ...okProbes, daemonAlive: async () => false });
    expect(checks.find((c) => c.name.includes("daemon"))!.ok).toBe(false);
  });
});
```

Run: `npx vitest run test/doctor.test.ts` → FAIL

- [ ] **Step 2: 实现**

```ts
// src/deploy/doctor.ts — 只读诊断（spec §B4）。probes 可注入以便单测；真实 probes 由 CLI 组装。
export interface DoctorCheck { name: string; ok: boolean | null; detail: string; fix?: string }
export interface DoctorProbes {
  daemonAlive(): Promise<boolean>;
  dbOpens(): boolean;
  resolveKey(key: string): "config" | "env" | null; // 凭证来源探测——只报来源不报值
  configPerms(): string | null;                     // "600" 等八进制串；null=无 config.json
  aishConfigured(): boolean;
  launchdLoaded(): Promise<boolean>;
  distFresh(): boolean | null;                      // null=未构建
  fts5Available(): boolean;
  nodeVersion(): string;
}

export async function runDoctor(p: DoctorProbes): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const alive = await p.daemonAlive();
  checks.push({
    name: "daemon 活性", ok: alive, detail: alive ? "sock 可达" : "无响应",
    fix: alive ? undefined : "plc daemon start（或 plc daemon install 走 launchd）",
  });
  checks.push({ name: "账本 db", ok: p.dbOpens(), detail: "openDb + schema", fix: "检查 ~/.pi-lead-child/plc.db 是否损坏" });
  const am = p.resolveKey("AM_API_KEY");
  checks.push({
    name: "凭证 AM_API_KEY", ok: am !== null, detail: am ? `来源: ${am}` : "未配置",
    fix: am ? undefined : "写入 ~/.pi-lead-child/config.json 的 env 段（launchd 环境不含 shell 变量）",
  });
  const tv = p.resolveKey("TAVILY_API_KEY");
  checks.push({ name: "凭证 TAVILY_API_KEY（可选）", ok: tv !== null ? true : null, detail: tv ? `来源: ${tv}` : "未配置，web_search 不可用" });
  const perms = p.configPerms();
  checks.push({
    name: "config.json 权限", ok: perms === null ? null : perms === "600",
    detail: perms === null ? "无 config.json" : `mode ${perms}`,
    fix: perms !== null && perms !== "600" ? "chmod 600 ~/.pi-lead-child/config.json" : undefined,
  });
  checks.push({ name: "aish 网关", ok: p.aishConfigured() ? true : null, detail: p.aishConfigured() ? "凭证已持久化" : "未接 Slack（可选）" });
  const ld = await p.launchdLoaded();
  checks.push({ name: "launchd job", ok: ld ? true : null, detail: ld ? "loaded" : "未安装（手动模式）", fix: ld ? undefined : "plc daemon install" });
  const fresh = p.distFresh();
  checks.push({
    name: "构建产物", ok: fresh, detail: fresh === null ? "未构建" : fresh ? "dist 新于 src" : "dist 旧于 src",
    fix: fresh !== true ? "npm run build（launchd 跑的是 dist）" : undefined,
  });
  checks.push({ name: "FTS5 检索", ok: p.fts5Available(), detail: p.fts5Available() ? "可用" : "不可用，notes 检索降级 LIKE" });
  checks.push({ name: "node", ok: true, detail: p.nodeVersion() });
  return checks;
}

export function formatChecks(checks: DoctorCheck[]): string {
  return checks.map((c) => {
    const mark = c.ok === true ? "✓" : c.ok === false ? "✗" : "–";
    return `${mark} ${c.name}: ${c.detail}${c.ok === false && c.fix ? `\n  ↳ 修复: ${c.fix}` : ""}`;
  }).join("\n");
}
```

- [ ] **Step 3: CLI 真实 probes 组装**

`src/cli.ts` 加命令（真实 probes 就地组装，全部 try/catch 包裹为 false/null）：

```ts
program.command("doctor").description("只读诊断：daemon/db/凭证/aish/launchd/构建/FTS5").action(async () => {
  const { runDoctor, formatChecks } = await import("./deploy/doctor.js");
  const { statSync, readdirSync } = await import("node:fs");
  const { loadEnvConfig, envConfigPath } = await import("./config.js");
  const srcMtime = (dir: string): number => readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .reduce((m, e) => Math.max(m, statSync(join((e as any).parentPath ?? (e as any).path, e.name)).mtimeMs), 0);
  const checks = await runDoctor({
    daemonAlive: async () => !!(await tryConnect().then((s) => { s?.end(); return s; })),
    dbOpens: () => { try { openDb(dbPath()).close(); return true; } catch { return false; } },
    resolveKey: (key) => {
      try {
        const env: Record<string, string | undefined> = { ...process.env };
        const applied = loadEnvConfig(dataDir(), env);
        if (applied.includes(key)) return "config";
        return env[key] ? "env" : null;
      } catch { return null; }
    },
    configPerms: () => {
      try { return (statSync(envConfigPath()).mode & 0o777).toString(8); } catch { return null; }
    },
    aishConfigured: () => { try { return !!loadAishConnForDoctor(); } catch { return false; } },
    launchdLoaded: async () => {
      const { agentStatus } = await import("./deploy/launchd.js");
      return (await agentStatus()) !== null;
    },
    distFresh: () => {
      const dist = join(PROJECT_ROOT, "dist", "coordinatord.mjs");
      if (!existsSync(dist)) return null;
      try { return statSync(dist).mtimeMs >= srcMtime(join(PROJECT_ROOT, "src")); } catch { return false; }
    },
    fts5Available: () => { try { const db = openDb(dbPath()); const r = ftsEnabled(db); db.close(); return r; } catch { return false; } },
    nodeVersion: () => process.version,
  });
  console.log(formatChecks(checks));
  process.exit(checks.some((c) => c.ok === false) ? 1 : 0);
});

function loadAishConnForDoctor() {
  const { loadAishConn } = require("./store/gateway.js"); // 同步语境用动态 import 亦可
  return loadAishConn(openDb(dbPath()));
}
```

> 注：`ftsEnabled` 在 Task 10 实现；本 task 先写 `() => true` 占位并加 `// Task 10 接真实现` 标记，Task 10 完成后回填（executor 注意）。`loadAishConnForDoctor` 用 `await import` 改写为 async 风格更贴 ESM——以能编译运行为准。

- [ ] **Step 4: 测试 + Commit**

Run: `npx vitest run` → 全绿；手动 `npx tsx src/cli.ts doctor` 看真实输出格式。

```bash
git add -A && git commit -m "feat: plc doctor - readonly diagnostics with injectable probes"
```

---

### Task 6: kv 表 + lastAishOrigin 持久化（spec §C2）

**Files:**
- Modify: `src/store/schema.ts`（kv 表）、`src/store/gateway.ts`（origin 存取）、`src/daemon/server.ts`（接线）
- Test: `test/gateway-store.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

`test/gateway-store.test.ts` 追加：

```ts
import { saveLastAishOrigin, loadLastAishOrigin } from "../src/store/gateway.js";

describe("lastAishOrigin 持久化", () => {
  it("往返一致，daemon 重启后可恢复投递目标", () => {
    expect(loadLastAishOrigin(db)).toBeNull();
    saveLastAishOrigin(db, { channelId: "D09XXX", threadTs: "1721.001" });
    expect(loadLastAishOrigin(db)).toEqual({ channelId: "D09XXX", threadTs: "1721.001" });
    saveLastAishOrigin(db, { channelId: "C08YYY" }); // 覆盖 + 可无 threadTs
    expect(loadLastAishOrigin(db)).toEqual({ channelId: "C08YYY" });
  });
});
```

Run: `npx vitest run test/gateway-store.test.ts` → FAIL

- [ ] **Step 2: 实现**

`src/store/schema.ts` SCHEMA 尾部加（新表走 CREATE IF NOT EXISTS，老库无需 migrate）：

```sql
CREATE TABLE IF NOT EXISTS kv (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`src/store/gateway.ts` 追加：

```ts
// 通知回程目标（spec §C2）：daemon 重启后 child 完成通知不丢投递目标（连接恢复靠 conn 凭证，目标靠这里）
const LAST_ORIGIN_KEY = "last_aish_origin";
export interface AishOrigin { channelId: string; threadTs?: string }

export function saveLastAishOrigin(db: Db, origin: AishOrigin): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LAST_ORIGIN_KEY, JSON.stringify(origin));
}

export function loadLastAishOrigin(db: Db): AishOrigin | null {
  const r = db.prepare("SELECT value FROM kv WHERE key = ?").get(LAST_ORIGIN_KEY) as { value: string } | undefined;
  if (!r) return null;
  try { return JSON.parse(r.value) as AishOrigin; } catch { return null; }
}
```

`src/daemon/server.ts` 接线（import 补 saveLastAishOrigin/loadLastAishOrigin）：

```ts
// 原: let lastAishOrigin: {...} | null = null;
let lastAishOrigin = loadLastAishOrigin(db);   // 重启恢复投递目标

// onEvent 内 原: lastAishOrigin = origin;
lastAishOrigin = origin;
saveLastAishOrigin(db, origin);
```

- [ ] **Step 3: 测试 + Commit**

Run: `npx vitest run` → 全绿

```bash
git add -A && git commit -m "feat: persist lastAishOrigin in kv store - notify target survives daemon restart"
```

---

### Task 7: recoverOrphans 有限次自动重派（spec §C1）

**Files:**
- Modify: `src/daemon/server.ts`（recoverOrphans + 接线重排）
- Test: `test/daemon.test.ts`（recoverOrphans describe 块追加）

- [ ] **Step 1: 写失败测试**

`test/daemon.test.ts` 的 recoverOrphans describe 追加（import 补 `listActivities` from activities、`appendBody` 不需要）：

```ts
it("首个孤儿自动重派：redispatch 回调收到 ticketId，通知降级 attention，账本留 auto_redispatch 决策", () => {
  const ticketId = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
  transition(db, { ticketId, to: "assigned", actor: "lead", reason: "" });
  transition(db, { ticketId, to: "in_progress", actor: "system", reason: "" });
  const attemptId = createAttempt(db, { ticketId });
  updateAttempt(db, attemptId, { state: "running", pid: 999_999_999 });
  const redispatched: number[] = [];
  recoverOrphans(db, { redispatch: (id) => { redispatched.push(id); return true; } });
  expect(redispatched).toEqual([ticketId]);
  expect(getAttempt(db, attemptId)!.state).toBe("crashed"); // 诚实语义不变
  expect(listInbox(db, { severity: "blocker" }).length).toBe(0);
  expect(listInbox(db, { severity: "attention" }).some((r) => r.summary.includes("自动重派"))).toBe(true);
  const acts = listActivities(db, ticketId, 1000);
  expect(acts.some((a) => a.kind === "decision" && a.payload.includes("auto_redispatch"))).toBe(true);
  expect(getTicket(db, ticketId)!.body).toContain("daemon 重启");
});

it("同工单第二次孤儿不再重派（防崩溃循环 spawn 风暴），回落 blocked+blocker", () => {
  const ticketId = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
  transition(db, { ticketId, to: "assigned", actor: "lead", reason: "" });
  transition(db, { ticketId, to: "in_progress", actor: "system", reason: "" });
  const a1 = createAttempt(db, { ticketId });
  updateAttempt(db, a1, { state: "running", pid: 999_999_999 });
  recoverOrphans(db, { redispatch: () => true });          // 第一次：重派
  transition(db, { ticketId, to: "in_progress", actor: "system", reason: "redispatch attempt" });
  const a2 = createAttempt(db, { ticketId });
  updateAttempt(db, a2, { state: "running", pid: 999_999_999 });
  const redispatched: number[] = [];
  recoverOrphans(db, { redispatch: (id) => { redispatched.push(id); return true; } }); // 第二次
  expect(redispatched).toEqual([]);
  expect(getTicket(db, ticketId)!.status).toBe("blocked");
  expect(listInbox(db, { severity: "blocker" }).length).toBeGreaterThan(0);
});

it("redispatch 返回 false（spawn 失败）时优雅降级到 blocked+blocker", () => {
  const ticketId = createTicket(db, { title: "t", brief: "b", createdBy: "user" });
  transition(db, { ticketId, to: "assigned", actor: "lead", reason: "" });
  transition(db, { ticketId, to: "in_progress", actor: "system", reason: "" });
  const attemptId = createAttempt(db, { ticketId });
  updateAttempt(db, attemptId, { state: "running", pid: 999_999_999 });
  recoverOrphans(db, { redispatch: () => false });
  expect(getTicket(db, ticketId)!.status).toBe("blocked");
  expect(listInbox(db, { severity: "blocker" }).length).toBeGreaterThan(0);
});
```

Run: `npx vitest run test/daemon.test.ts` → 新 3 例 FAIL，旧 2 例（无 opts 调用=现行为）PASS

- [ ] **Step 2: 实现 recoverOrphans**

`src/daemon/server.ts`（import 补 `appendBody` from tickets）：

```ts
// daemon 重启恢复（DESIGN §9 + spec §C1）：孤儿 child 的 stdio 无法重挂——杀掉如实标 crash。
// 自动重派限每工单 1 次（判据持久化在 auto_redispatch 决策 activity，崩溃循环第二次重启必然收敛到 blocked）。
function autoRedispatchCount(db: Db, ticketId: number): number {
  const r = db.prepare(
    `SELECT COUNT(*) AS c FROM activities
     WHERE ticket_id = ? AND kind = 'decision' AND json_extract(payload, '$.decision') = 'auto_redispatch'`,
  ).get(ticketId) as { c: number };
  return r.c;
}

export function recoverOrphans(
  db: Db,
  opts?: { redispatch?: (ticketId: number) => boolean },
): number {
  const orphans = db.prepare(
    "SELECT id, ticket_id, pid FROM attempts WHERE state IN ('starting','running')",
  ).all() as Array<{ id: number; ticket_id: number; pid: number | null }>;
  for (const o of orphans) {
    if (o.pid) {
      try { process.kill(o.pid); } catch { /* 已死 */ }
    }
    updateAttempt(db, o.id, { state: "crashed", endedAt: true });
    addActivity(db, {
      ticketId: o.ticket_id, attemptId: o.id, actor: "system", kind: "crash",
      payload: { reason: "daemon restart: orphaned attempt reclaimed", pid: o.pid },
    });
    const status = getTicket(db, o.ticket_id)?.status;
    if (status === "in_progress" || status === "assigned") {
      transition(db, {
        ticketId: o.ticket_id, to: "blocked", actor: "system",
        reason: "daemon restart reclaimed orphaned attempt", attemptId: o.id,
      });
    }
    // 有限次自动重派：非终态 + 未派过 + 有派发能力。计数决策先落账（spawn 挂死也能收敛）。
    const after = getTicket(db, o.ticket_id)?.status;
    const terminal = after === "done" || after === "cancelled";
    if (!terminal && opts?.redispatch && autoRedispatchCount(db, o.ticket_id) === 0) {
      addActivity(db, {
        ticketId: o.ticket_id, attemptId: o.id, actor: "system", kind: "decision",
        payload: { decision: "auto_redispatch", fromAttempt: o.id },
      });
      appendBody(db, o.ticket_id,
        `【系统】attempt #${o.id} 因 daemon 重启中断，已自动重派新 attempt 续做（前次进展见上文与 activities）。`);
      if (opts.redispatch(o.ticket_id)) {
        addInbox(db, {
          ticketId: o.ticket_id, severity: "attention", source: "structural",
          summary: `工单 #${o.ticket_id} 的 attempt #${o.id} 因 daemon 重启中断，已自动重派续做`,
        });
        continue;
      }
    }
    addInbox(db, {
      ticketId: o.ticket_id, severity: "blocker", source: "structural",
      summary: `工单 #${o.ticket_id} 的 attempt #${o.id} 因 daemon 重启被回收（标记 crash）`,
    });
  }
  return orphans.length;
}
```

- [ ] **Step 3: daemon 接线重排**

`startDaemon` 中：删除原 `const reclaimed = recoverOrphans(db);`（第 76 行），把 `schedDeps` 定义上移到 `onChildDone` 定义之后（原 291 行的对象原样上移，scheduler 处复用同一变量），紧跟其后：

```ts
const schedDeps = {
  db, dbPath: opts.dbPath, dataDir: opts.dataDir,
  childPi: opts.childPi, onChildDone,
};
const reclaimed = recoverOrphans(db, {
  redispatch: (ticketId) => {
    try { spawnTicketChild(schedDeps, ticketId, {}); return true; }
    catch (e: any) { log(`[recover] redispatch #${ticketId} failed: ${e.message}`); return false; }
  },
});
if (reclaimed) log(`recovered ${reclaimed} orphaned attempt(s)`);
```

> 边界说明：review 态工单的孤儿（reviewer 死了）不满足 executor 的 RUNNABLE 校验，redispatch 抛错→返回 false→blocker 现行为，lead 心跳裁决。可接受，不专门处理。

- [ ] **Step 4: 测试 + Commit**

Run: `npx vitest run` → 全绿

```bash
git add -A && git commit -m "feat: limited auto-redispatch on orphan recovery (max 1 per ticket, ledger-persisted guard)"
```

---

### Task 8: cron 本地时区（spec §C3）

**Files:**
- Modify: `src/store/schedules.ts`、`src/util.ts`（localTz）、`src/lead/tools.ts`（create_schedule 描述）、`src/lead/prompt.ts`（纪律 11）
- Test: `test/schedules.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

`test/schedules.test.ts` 追加：

```ts
it("nextRun 按指定时区解析：上海周一 09:00 = UTC 01:00", () => {
  const from = new Date("2026-07-22T00:00:00Z"); // 周三
  const next = nextRun("0 9 * * 1", from, "Asia/Shanghai");
  expect(next).toBe("2026-07-27T01:00:00.000Z"); // 下周一 09:00+08:00
});

it("nextRun 缺省用本机时区（与显式传本机时区结果一致）", () => {
  const from = new Date("2026-07-22T00:00:00Z");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(nextRun("0 9 * * 1", from)).toBe(nextRun("0 9 * * 1", from, tz));
});
```

Run: `npx vitest run test/schedules.test.ts` → 第一例 FAIL（现在按 UTC 算出 09:00Z）

- [ ] **Step 2: 实现**

`src/util.ts` 追加：

```ts
export function localTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
```

`src/store/schedules.ts`：

```ts
import { localTz } from "../util.js";

// 从给定时刻起算 cron 的下一次触发。cron 按 tz（缺省本机时区）解析，存储仍是 ISO UTC。
// 行为切换（spec §C3）：此前按 UTC 解析，现存 schedule 的语义随之变为本地时区，直接切不迁移。
export function nextRun(cron: string, from: Date, tz: string = localTz()): string {
  const iso = CronExpressionParser.parse(cron, { currentDate: from, tz }).next().toISOString();
  if (!iso) throw new Error(`cron has no next occurrence: ${cron}`);
  return iso;
}
```

`createSchedule`/`advanceSchedule` 调 `nextRun(args.cron, now)` 不变（吃缺省 tz）。

`src/lead/tools.ts` create_schedule 的 description 与 cron 参数描述：把两处 “UTC” 表述改为本地时区语义：

```ts
description:
  "创建例行任务（cron 定时）。cron 为 5 段标准表达式（分 时 日 月 周，按本机时区解析）。" +
  "spawn=true 到点自动建单并派 child 执行（如'每周一汇总工单'）；spawn=false 仅到点建单提醒" +
  "（如'每月1号提醒体检'）。用户说'每周一早上9点'直接写 '0 9 * * 1'，无需时区换算。",
// cron 参数：
cron: Type.String({ description: "5 段 cron（本机时区），如 '0 9 * * 1' = 每周一早上 9 点" }),
```

`src/lead/prompt.ts` 纪律 11 的第三条 “按 UTC 换算成 cron” 改为：

```
- "每周一 / 每天早上 / 每月1号" → create_schedule（cron 按本机时区直接表达，无需换算）；需要 child 干活的（如"每周汇总"）spawn=true，纯提醒的 spawn=false。
```

- [ ] **Step 3: 测试 + Commit**

Run: `npx vitest run` → 全绿

```bash
git add -A && git commit -m "feat: cron schedules resolve in local timezone (was UTC)"
```

---

### Task 9: notes.kind 分类 + 迁移（spec §A1）

**Files:**
- Modify: `src/store/schema.ts`、`src/store/db.ts`（migrate）、`src/store/notes.ts`
- Test: `test/notes.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

`test/notes.test.ts` 追加：

```ts
import { NOTE_KINDS, type NoteKind } from "../src/store/notes.js";

describe("notes kind", () => {
  it("保存时可指定 kind，缺省 note", () => {
    const id1 = saveNote(db, { title: "画像", content: "后端工程师", tags: [], kind: "profile" });
    const id2 = saveNote(db, { title: "结论", content: "选 SQLite", tags: [] });
    expect(searchNotes(db, "后端工程师")[0].kind).toBe("profile");
    expect(searchNotes(db, "SQLite")[0].kind).toBe("note");
    expect(id2).toBeGreaterThan(id1);
  });
  it("searchNotes 可按 kind 过滤", () => {
    saveNote(db, { title: "偏好", content: "回复用中文", tags: [], kind: "preference" });
    saveNote(db, { title: "杂记", content: "回复格式讨论", tags: [] });
    expect(searchNotes(db, "回复", { kind: "preference" }).length).toBe(1);
  });
  it("updateNote 可改 kind", () => {
    const id = saveNote(db, { title: "t", content: "内容甲", tags: [] });
    updateNote(db, id, { kind: "fact" });
    expect(searchNotes(db, "内容甲")[0].kind).toBe("fact");
  });
  it("老库就地迁移：缺 kind 列的库打开后自动补列，存量行 kind=note", () => {
    const raw = new (require("better-sqlite3"))(join(mkdtempSync(join(tmpdir(), "plc-")), "old.db"));
    raw.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.prepare("INSERT INTO notes (title, content) VALUES ('旧', '旧数据')").run();
    const p = raw.name; raw.close();
    const migrated = openDb(p);
    expect(searchNotes(migrated, "旧数据")[0].kind).toBe("note");
  });
});
```

> 注：老库迁移测试若 `require` 在 ESM 测试里不可用，用 `import Database from "better-sqlite3"` 顶部引入。

Run: `npx vitest run test/notes.test.ts` → FAIL

- [ ] **Step 2: 实现**

`src/store/schema.ts` notes 表定义加一列（新库路径）：

```sql
CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  kind          TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('profile','preference','fact','note')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`src/store/db.ts` migrate() 追加（老库路径，同 priority 迁移法）：

```ts
const ncols = new Set(
  (db.pragma("table_info(notes)") as Array<{ name: string }>).map((c) => c.name),
);
if (ncols.size > 0 && !ncols.has("kind")) {
  db.exec(`ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'
           CHECK (kind IN ('profile','preference','fact','note'))`);
}
```

`src/store/notes.ts`：

```ts
export const NOTE_KINDS = ["profile", "preference", "fact", "note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface Note {
  id: number; title: string; content: string; tags: string; kind: NoteKind;
  created_at: string; updated_at: string;
}

export function saveNote(
  db: Db,
  args: { title: string; content: string; tags: string[]; kind?: NoteKind },
): number {
  const r = db.prepare("INSERT INTO notes (title, content, tags, kind) VALUES (?, ?, ?, ?)")
    .run(args.title, args.content, JSON.stringify(args.tags), args.kind ?? "note");
  return Number(r.lastInsertRowid);
}
```

`updateNote` patch 加 `kind?: NoteKind` 分支（`if (patch.kind) { sets.push("kind = ?"); vals.push(patch.kind); }`）。`searchNotes` 加 `opts?: { limit?: number; kind?: NoteKind }` 第三参（LIKE 版）：

```ts
export function searchNotes(
  db: Db, query: string, opts?: { limit?: number; kind?: NoteKind },
): Note[] {
  const q = `%${query}%`;
  const kindSql = opts?.kind ? " AND kind = ?" : "";
  const params: unknown[] = [q, q, q, ...(opts?.kind ? [opts.kind] : []), opts?.limit ?? 20];
  return db.prepare(
    `SELECT * FROM notes WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)${kindSql}
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(...params) as Note[];
}
```

- [ ] **Step 3: 测试 + Commit**

Run: `npx vitest run` → 全绿

```bash
git add -A && git commit -m "feat: notes.kind classification (profile/preference/fact/note) with in-place migration"
```

---

### Task 10: FTS5 trigram 检索（spec §A3）

**Files:**
- Modify: `src/store/db.ts`（FTS 建表/触发器/rebuild + ftsEnabled）、`src/store/notes.ts`（searchNotes FTS 路径）、`src/cli.ts`（doctor 的 fts5Available 占位回填）
- Test: `test/notes-fts.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/notes-fts.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, ftsEnabled, type Db } from "../src/store/db.js";
import { saveNote, searchNotes, updateNote } from "../src/store/notes.js";

let db: Db;
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db")); });

describe("notes FTS5 trigram", () => {
  it("FTS5 在本环境可用", () => {
    expect(ftsEnabled(db)).toBe(true);
  });
  it("中文子串命中（≥3 字符走 FTS）", () => {
    saveNote(db, { title: "部署决策", content: "凭证持久化用配置文件优先于环境变量", tags: [] });
    expect(searchNotes(db, "配置文件优先").length).toBe(1);
    expect(searchNotes(db, "持久化用配").length).toBe(1); // 任意子串，LIKE 同样命中但这里验证 FTS 路径不丢
  });
  it("<3 字符降级 LIKE 仍可命中（中文双字词）", () => {
    saveNote(db, { title: "偏好", content: "简洁直接", tags: [] });
    expect(searchNotes(db, "偏好").length).toBe(1);
  });
  it("bm25 排序：标题+内容多处命中的排前", () => {
    saveNote(db, { title: "无关", content: "只提了一次 esbuild", tags: [] });
    saveNote(db, { title: "esbuild 构建", content: "esbuild 打包 esbuild external", tags: ["esbuild"] });
    const rows = searchNotes(db, "esbuild");
    expect(rows[0].title).toBe("esbuild 构建");
  });
  it("update/delete 经触发器同步索引", () => {
    const id = saveNote(db, { title: "t", content: "旧索引内容", tags: [] });
    updateNote(db, id, { content: "新索引内容" });
    expect(searchNotes(db, "旧索引内容").length).toBe(0);
    expect(searchNotes(db, "新索引内容").length).toBe(1);
    db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    expect(searchNotes(db, "新索引内容").length).toBe(0);
  });
  it("含引号的 query 不炸 FTS 语法", () => {
    saveNote(db, { title: "q", content: '他说 "hello world" 然后离开', tags: [] });
    expect(() => searchNotes(db, '"hello world"')).not.toThrow();
  });
});
```

Run: `npx vitest run test/notes-fts.test.ts` → FAIL（ftsEnabled 不存在）

- [ ] **Step 2: 实现**

`src/store/db.ts`：

```ts
// FTS5 trigram 检索层（spec §A3）：external-content 表 + 触发器同步。
// trigram 对 CJK/英文子串匹配均可用（unicode61 对中文无效）；建失败（老 SQLite 无 FTS5/trigram）则
// 整体降级 LIKE，doctor 报告。一次性建表时 rebuild 收编存量行。
const ftsReady = new WeakMap<Db, boolean>();
export function ftsEnabled(db: Db): boolean {
  return ftsReady.get(db) ?? false;
}

function setupFts(db: Db): void {
  try {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'",
    ).get();
    if (!exists) {
      db.exec(`
        CREATE VIRTUAL TABLE notes_fts USING fts5(
          title, content, tags, content='notes', content_rowid='id', tokenize='trigram'
        );
        CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
        END;
        CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
            VALUES ('delete', old.id, old.title, old.content, old.tags);
        END;
        CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
            VALUES ('delete', old.id, old.title, old.content, old.tags);
          INSERT INTO notes_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
        END;
      `);
      db.exec("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')"); // 收编存量行
    }
    ftsReady.set(db, true);
  } catch {
    ftsReady.set(db, false); // 降级 LIKE
  }
}
```

`openDb` 里 `migrate(db);` 之后加 `setupFts(db);`。

`src/store/notes.ts` searchNotes 改为 FTS 优先（保留 Task 9 的 LIKE 版为 `searchNotesLike` 内部函数）：

```ts
import { ftsEnabled } from "./db.js";

export function searchNotes(
  db: Db, query: string, opts?: { limit?: number; kind?: NoteKind },
): Note[] {
  // trigram 需要 ≥3 字符；短查询（中文双字词很常见）与 FTS 不可用时走 LIKE
  if (query.length >= 3 && ftsEnabled(db)) {
    try {
      const match = `"${query.replaceAll('"', '""')}"`; // 整体作短语，防注入 FTS 语法
      const kindSql = opts?.kind ? " AND n.kind = ?" : "";
      const params: unknown[] = [match, ...(opts?.kind ? [opts.kind] : []), opts?.limit ?? 20];
      return db.prepare(
        `SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
         WHERE notes_fts MATCH ?${kindSql} ORDER BY rank LIMIT ?`,
      ).all(...params) as Note[];
    } catch { /* FTS 查询异常，落 LIKE */ }
  }
  return searchNotesLike(db, query, opts);
}

function searchNotesLike(
  db: Db, query: string, opts?: { limit?: number; kind?: NoteKind },
): Note[] {
  // …Task 9 的 LIKE 实现原样搬入…
}
```

`src/cli.ts` doctor 的 `fts5Available` 占位改真实现：`() => { try { const db = openDb(dbPath()); const r = ftsEnabled(db); db.close(); return r; } catch { return false; } }`（import 补 ftsEnabled）。

- [ ] **Step 3: 测试 + Commit**

Run: `npx vitest run` → 全绿（notes.test.ts 旧例走新路径必须仍绿）

```bash
git add -A && git commit -m "feat: FTS5 trigram search for notes (bm25, CJK-capable, LIKE fallback)"
```

---

### Task 11: 常驻核心记忆（spec §A2）

**Files:**
- Modify: `src/store/notes.ts`（core memory 读取/容量）、`src/lead/session.ts`（创建时注入）、`src/daemon/server.ts`（compaction 后刷新）、`src/lead/tools.ts`（save_note/update_note/search_notes 加 kind）
- Test: `test/core-memory.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// test/core-memory.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/store/db.js";
import { saveNote, updateNote, renderCoreMemory, CORE_MEMORY_CAP_DEFAULT } from "../src/store/notes.js";

let db: Db;
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), "plc-")), "plc.db")); });
afterEach(() => { delete process.env.PLC_CORE_MEMORY_CAP; });

describe("core memory", () => {
  it("renderCoreMemory 只含 profile+preference，无内容时返回 null", () => {
    expect(renderCoreMemory(db)).toBeNull();
    saveNote(db, { title: "画像", content: "后端工程师，偏 TS", tags: [], kind: "profile" });
    saveNote(db, { title: "偏好", content: "回复中文", tags: [], kind: "preference" });
    saveNote(db, { title: "工作沉淀", content: "不应出现", tags: [], kind: "note" });
    const block = renderCoreMemory(db)!;
    expect(block).toContain("后端工程师");
    expect(block).toContain("回复中文");
    expect(block).not.toContain("不应出现");
    expect(block).toContain("关于用户");
  });
  it("超过 PLC_CORE_MEMORY_CAP 时 saveNote 报错逼精炼（Hermes：错误而非静默截断）", () => {
    process.env.PLC_CORE_MEMORY_CAP = "50";
    saveNote(db, { title: "画像", content: "x".repeat(30), tags: [], kind: "profile" });
    expect(() =>
      saveNote(db, { title: "偏好", content: "y".repeat(30), tags: [], kind: "preference" }),
    ).toThrow(/核心记忆已满/);
  });
  it("updateNote 把普通 note 改成核心 kind 时同样受容量约束", () => {
    process.env.PLC_CORE_MEMORY_CAP = "50";
    saveNote(db, { title: "画像", content: "x".repeat(40), tags: [], kind: "profile" });
    const id = saveNote(db, { title: "长笔记", content: "z".repeat(40), tags: [] });
    expect(() => updateNote(db, id, { kind: "preference" })).toThrow(/核心记忆已满/);
  });
  it("普通 note 不受容量限制", () => {
    process.env.PLC_CORE_MEMORY_CAP = "10";
    expect(() => saveNote(db, { title: "长", content: "z".repeat(100), tags: [] })).not.toThrow();
    expect(CORE_MEMORY_CAP_DEFAULT).toBe(4000);
  });
});
```

Run: `npx vitest run test/core-memory.test.ts` → FAIL

- [ ] **Step 2: 实现 notes.ts 部分**

```ts
// 常驻核心记忆（spec §A2，Hermes 映射）：profile+preference 有界常驻注入，超限报错逼 lead 精炼。
export const CORE_KINDS: NoteKind[] = ["profile", "preference"];
export const CORE_MEMORY_CAP_DEFAULT = 4000;

function coreMemoryCap(): number {
  return Number(process.env.PLC_CORE_MEMORY_CAP ?? CORE_MEMORY_CAP_DEFAULT);
}

export function coreNotes(db: Db): Note[] {
  return db.prepare(
    "SELECT * FROM notes WHERE kind IN ('profile','preference') ORDER BY kind, id",
  ).all() as Note[];
}

function coreSize(db: Db, excludeId?: number): number {
  return coreNotes(db)
    .filter((n) => n.id !== excludeId)
    .reduce((s, n) => s + n.title.length + n.content.length, 0);
}

// saveNote/updateNote 目标为核心 kind 时的容量闸（唯一写入口在 lead 工具，DAO 层做闸最稳）
function assertCoreCapacity(db: Db, incoming: { title: string; content: string }, excludeId?: number): void {
  const cap = coreMemoryCap();
  const total = coreSize(db, excludeId) + incoming.title.length + incoming.content.length;
  if (total > cap) {
    throw new Error(
      `核心记忆已满（${total}/${cap} 字符）。请先 search_notes 查看 profile/preference 条目，` +
      `用 update_note 精炼合并后再保存；不属于长期画像/偏好的内容请用 kind='note' 或 'fact'。`,
    );
  }
}

export function renderCoreMemory(db: Db): string | null {
  const rows = coreNotes(db);
  if (!rows.length) return null;
  const fmt = (k: NoteKind) => rows.filter((n) => n.kind === k)
    .map((n) => `- ${n.title}: ${n.content}`).join("\n");
  const profile = fmt("profile"), pref = fmt("preference");
  return [
    "## 关于用户（长期记忆，来自 notes 的 profile/preference）",
    profile ? `### 画像\n${profile}` : "",
    pref ? `### 偏好\n${pref}` : "",
  ].filter(Boolean).join("\n\n");
}
```

`saveNote` 开头加：`if (CORE_KINDS.includes(args.kind ?? "note")) assertCoreCapacity(db, args);`
`updateNote` 需先取现行（决定目标 kind 与新文案）：

```ts
export function updateNote(
  db: Db,
  id: number,
  patch: { title?: string; content?: string; tags?: string[]; kind?: NoteKind },
): void {
  const cur = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note | undefined;
  if (!cur) return;
  const targetKind = patch.kind ?? cur.kind;
  if (CORE_KINDS.includes(targetKind)) {
    assertCoreCapacity(db, { title: patch.title ?? cur.title, content: patch.content ?? cur.content }, id);
  }
  // …既有 sets/vals 逻辑（含 kind 分支）…
}
```

- [ ] **Step 3: 注入接线**

`src/lead/session.ts`（冻结语义：session 创建时取一次）：

```ts
import { renderCoreMemory } from "../store/notes.js";

// createLeadSession 内，loader 创建前：
const coreMemory = renderCoreMemory(opts.db);
const systemPrompt = coreMemory ? `${LEAD_SYSTEM_PROMPT}\n\n${coreMemory}` : LEAD_SYSTEM_PROMPT;
const loader = new DefaultResourceLoader({
  cwd: opts.dataDir,
  agentDir: isolatedAgentDir,
  systemPromptOverride: () => systemPrompt,
});
```

`src/daemon/server.ts`（compaction 后下一轮 prepend 刷新——**与 spec §A2 的"followUp 注入"表述的偏差**：改为下一轮 runTurn 前缀注入，无额外 LLM 回合、无 busy 竞态，功能等价）：

```ts
// subscribe 的 compaction_end 分支加：
let coreMemoryDirty = false; // 与 precipitated 同级声明
if (event.type === "compaction_end") {
  precipitated = false;
  coreMemoryDirty = true; // 压缩摘要不保真核心记忆，下一轮重新注入
  log("compaction done, precipitation re-armed");
}

// runTurn 组装 full 前：
let coreBlock = "";
if (coreMemoryDirty) {
  const cm = renderCoreMemory(db);
  if (cm) coreBlock = `（长期记忆刷新——上下文压缩后重新注入）\n${cm}`;
  coreMemoryDirty = false;
}
const full = [clock, coreBlock, notices, message].filter(Boolean).join("\n\n");
```

（import 补 `renderCoreMemory`。）

- [ ] **Step 4: lead 工具加 kind**

`src/lead/tools.ts`（import 补 `NOTE_KINDS, type NoteKind`）：

save_note——parameters 加：

```ts
kind: Type.Optional(Type.Union(NOTE_KINDS.map((k) => Type.Literal(k)), {
  description: "profile=用户画像；preference=工作/沟通偏好；fact=用户相关长期事实；note=工作沉淀结论（缺省）。" +
    "profile/preference 常驻注入你的上下文且有容量上限，只放真正长期的精炼条目",
})),
```

description 尾部追加一句：`"关于用户本人的长期信息用 profile/preference/fact 分类；这两类核心记忆有容量上限，满了会报错，此时先精炼合并旧条目。"`
execute 透传 `kind: params.kind`。

update_note——parameters 加 `kind: Type.Optional(Type.Union(NOTE_KINDS.map((k) => Type.Literal(k))))`，execute 透传。

search_notes——parameters 加 `kind` 可选过滤 + description 更新：

```ts
description: "检索语义记忆（FTS 全文检索）。回答'我们之前定过/说过什么'、涉及用户个人信息或历史约定的问题前先查这里。",
parameters: Type.Object({
  query: Type.String(),
  kind: Type.Optional(Type.Union(NOTE_KINDS.map((k) => Type.Literal(k)))),
}),
execute: async (_id, params: { query: string; kind?: NoteKind }) => {
  const rows = searchNotes(db, params.query, { kind: params.kind });
  if (!rows.length) return text("（无匹配笔记）");
  return text(rows.map((n) =>
    `note #${n.id} [${n.kind}] [${n.updated_at}] ${n.title}\n${n.content}`,
  ).join("\n---\n"));
},
```

- [ ] **Step 5: 测试 + Commit**

Run: `npx vitest run` → 全绿（lead-tools.test.ts 若断言 save_note 参数需同步）

```bash
git add -A && git commit -m "feat: always-loaded core memory (profile/preference, capped, refresh after compaction)"
```

---

### Task 12: 沉淀提示词 + 纪律修订（spec §A4）

**Files:**
- Modify: `src/lead/precipitate.ts`、`src/lead/prompt.ts`
- Test: `test/precipitate.test.ts`（追加轻量断言）

- [ ] **Step 1: 写失败测试**

`test/precipitate.test.ts` 追加：

```ts
it("沉淀提示词包含画像/偏好检查项与 kind 指引", () => {
  expect(PRECIPITATE_PROMPT).toContain("profile");
  expect(PRECIPITATE_PROMPT).toContain("preference");
  expect(PRECIPITATE_PROMPT).toContain("画像");
});
```

Run → FAIL

- [ ] **Step 2: 实现**

`src/lead/precipitate.ts`：

```ts
export const PRECIPITATE_PROMPT =
  "（系统：你的上下文水位已接近自动压缩阈值。压缩后未沉淀的细节只剩摘要精度。" +
  "现在执行沉淀检查：回顾本会话，把尚未 save_note 的长期有价值结论逐条保存——" +
  "①技术决策、重要约定 → kind='note'或'fact'；" +
  "②用户画像有无新增或变化（身份/角色/技术背景）→ kind='profile'；" +
  "③用户工作/沟通偏好有无新增或变化 → kind='preference'。" +
  "画像与偏好优先 update_note 精炼合并既有条目而非新增重复。已保存过的不要重复；" +
  "工单事实不用存（账本是事实源）。完成后一句话确认即可。）";
```

`src/lead/prompt.ts` 纪律 10 改为：

```
10. **记忆沉淀与召回。** 你的会话会被自动压缩，没有 save_note 的内容终将丢失。快问快答或讨论中出现长期有价值的结论时主动 save_note，并正确分类 kind：用户画像=profile、工作/沟通偏好=preference、用户相关长期事实=fact、工作沉淀结论=note（画像/偏好常驻你的上下文且有容量上限，只放精炼条目，优先更新合并）。回答"我们之前定过什么"、涉及用户个人信息或历史约定的问题，必须先 search_notes 再回答，禁止直接说"不记得"。工单相关的事实不要存笔记——账本才是任务事实源。
```

- [ ] **Step 3: 测试 + Commit**

Run: `npx vitest run` → 全绿

```bash
git add -A && git commit -m "feat: precipitation prompt covers profile/preference, recall-before-deny discipline"
```

---

### Task 13: 文档同步 + 全量回归 + 真机验收清单

**Files:**
- Modify: `docs/ACCEPTANCE.md`（M9 验收段）、`docs/DESIGN-GATEWAY.md`（§7 一行修正："单文件"→"bundle+external native deps"；cron UTC 表述更新）
- Modify: `README`/CLAUDE 类文档若存在相关命令说明（grep 确认）

- [ ] **Step 1: 全量回归**

Run: `npx vitest run && npm run build && node dist/cli.mjs --help`
Expected: 全绿 + 构建冒烟通过

- [ ] **Step 2: ACCEPTANCE.md 追加 M9 真机验收清单**（来自 spec §D，执行需真机与用户配合，逐项记录实证）：

```markdown
## M9 真机验收（部署硬化+记忆层）

1. [ ] 凭证：config.json 写入 AM_API_KEY（value 或 fromEnv）→ `env -i HOME=$HOME PATH=$PATH plc daemon start` 环境不含 AM_API_KEY 实测 → Slack/CLI 问答通畅无 401
2. [ ] launchd：`npm run build && plc daemon install` → 注销重登（或重启）→ daemon 自动在跑（plc doctor 全 ✓）→ Slack 问答通畅
3. [ ] 崩溃拉起+自动重派联动：跑一个长任务 child → `kill -9 <daemon pid>` → launchd 拉起 → aish 自动重连 → 工单自动重派并完成 → Slack 收到完成通知（验 lastAishOrigin 持久化）
4. [ ] 重派上限：同工单二次 kill -9 → 收敛到 blocked + blocker，无 spawn 风暴
5. [ ] 沉淀实战：真实长会话推到 70% 水位 → 沉淀触发 → notes 表 >0 行且含 profile/preference
6. [ ] 核心记忆：daemon 重启后新会话，lead 未检索即"记得"偏好；对历史结论提问 lead 先 search_notes（FTS 命中中文关键词）
7. [ ] doctor 故障注入：mv config.json → doctor 对应项 ✗ 且修复提示正确；恢复后全 ✓
8. [ ] plc daemon stop 后 launchd 不复活（SuccessfulExit=false 语义）；plc daemon start 手动可再拉起
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: M9 acceptance checklist + spec wording sync"
```

---

## 计划自查记录

- **Spec 覆盖**：§0.1→Task 1；§B2→Task 2；§B1→Task 3；§B3→Task 4；§B4→Task 5；§C2→Task 6；§C1→Task 7；§C3→Task 8；§A1→Task 9；§A3→Task 10；§A2→Task 11；§A4→Task 12；§D→各 task 单测 + Task 13 真机清单；§E 不做项无 task ✓
- **已知偏差（相对 spec）**：①核心记忆 compaction 后刷新用"下一轮 prepend"而非 followUp（无竞态，功能等价，Task 11 有注）；②doctor 的 fts5Available 在 Task 5 先占位、Task 10 回填（任务顺序依赖，两处都有标记）。
- **类型一致性**：searchNotes 第三参 `{limit?, kind?}`（Task 9 定义，Task 10/11 沿用）；recoverOrphans 第二参 `{redispatch?: (id)=>boolean}`（Task 7 内一致）；NoteKind/NOTE_KINDS 从 notes.ts 单点导出 ✓
- **真机注意**：launchd 验收（Task 13 清单 2/3/4/8）无法在单测/CI 复现——M6 教训，必须真机执行并记录。
