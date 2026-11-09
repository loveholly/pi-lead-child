// 宿主隔离的架构测试（lead-scheduler spec P0）：Lead 所在的 daemon 进程不做重活。
//
// 2026-11-09：daemon 用 fs.promises.rm 在后台删一个带 node_modules 的 worktree，占满了 Node 的 I/O 线程池，
// Lead 在同一个进程里，发请求前等了 9–14 分钟。同步的 child_process 调用（execFileSync 这类）在主线程上等子进程，
// 那段时间 daemon 什么都做不了（2026-11-03：同步的 git worktree add 停住 daemon 约 19 秒）。
//
// 规则：daemon 进程会加载的后端包里，
//   · 不用进程内递归的 fs.rm / fs.cp（以及 rmSync、cpSync、递归的 rmdir）：删整个目录树用 core 的 removeTree（子进程）；
//   · 不用同步的 child_process 调用：用 execFile / spawn 的异步版本。
// 现有的例外逐个列在下面，写明理由和次数。次数变了（多了或少了）测试都会失败：多了说明加了新的同步调用，
// 少了说明例外可以删掉。
// 检查的是代码，不是注释：先用 esbuild 去掉注释和类型（写法和 runtime-architecture.test.ts 一样）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { packageSource } from "@pi-lead-child/core";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// daemon 进程加载的后端包。supervisor 和 cli 是别的进程，不在这里：它们的同步调用不会卡住 Lead。
// protocol 是线上契约，没有 I/O。
const DAEMON_PACKAGES = ["core", "runtime", "store", "engine", "gateway", "lead", "connections", "daemon"];

type Kind = "sync-child-process" | "recursive-fs";

const PATTERNS: Array<[Kind, RegExp]> = [
  ["sync-child-process", /\b(?:execFileSync|execSync|spawnSync)\s*\(/g],
  // 一条语句里调 rm / rmSync / cp / cpSync / rmdir / rmdirSync，参数里带 recursive: true。
  ["recursive-fs", /\b(?:rm|rmSync|cp|cpSync|rmdir|rmdirSync)\s*\([^;]*?recursive:\s*(?:true|!0)/g],
];

// 允许的例外：文件 → 每种调用的次数和理由。
const EXCEPTIONS: Record<string, Partial<Record<Kind, { count: number; reason: string }>>> = {
  "packages/core/src/login-shell.ts": {
    "sync-child-process": { count: 1, reason: "启动时读一次登录 shell 的环境（main.ts，在 daemon 开始服务之前）；有超时" },
  },
  "packages/core/src/sandbox-policy.ts": {
    "sync-child-process": { count: 2, reason: "沙箱策略的同步版（git 目录、系统信任的证书）。daemon 用异步版 leadSandboxPolicyAsync 和 warmSandboxTrustBundle 预热；同步版留给测试和 CLI" },
  },
  "packages/engine/src/coordinator/git-facts.ts": {
    "sync-child-process": { count: 2, reason: "最后的兜底：调用方没预热时同步查一次，并记一行 [git-facts] not warmed。daemon 的入口都先预热（spawn_child、开始执行、恢复、工单对话、孤儿重派、定时触发）" },
  },
  "packages/engine/src/coordinator/workspace.ts": {
    "sync-child-process": { count: 1, reason: "provisionWorkspace 的同步版（git worktree add）只给测试和 prepareRunWorkspaceNowForTesting 用；daemon 用 provisionWorkspaceAsync" },
  },
  "packages/engine/src/coordinator/workspace-policy.ts": {
    "sync-child-process": { count: 2, reason: "removeFailedWorktreeNow 只给 prepareRunWorkspaceNowForTesting 用；daemon 走异步的 removeFailedWorktree" },
    "recursive-fs": { count: 1, reason: "同上：removeFailedWorktreeNow 只给测试用" },
  },
  "packages/engine/src/coordinator/workspace-remote.ts": {
    "sync-child-process": { count: 1, reason: "chooseWorktreeBase 的同步版只给同步的 provisionWorkspace（测试）用；daemon 用 chooseWorktreeBaseAsync" },
  },
  "packages/engine/src/extension/sol-pi-package.ts": {
    "sync-child-process": { count: 1, reason: "启动时读一次内置 SoL-Pi 的 commit（main.ts，在 daemon 开始服务之前）" },
  },
  "packages/engine/src/sandbox/bash.ts": {
    "sync-child-process": { count: 1, reason: "沙箱自检：/usr/bin/true，1 秒超时，只在 bash 起不来时查原因" },
  },
  "packages/connections/src/vault.ts": {
    "sync-child-process": { count: 3, reason: "钥匙串的同步读（security），只在第一次用到连接的密钥时；daemon 先用异步的 read 预热（lazyVault.preload）" },
  },
  "apps/daemon/src/ops.ts": {
    "sync-child-process": { count: 1, reason: "plc doctor / ops 自检里查执行器的版本：用户手动跑的诊断，不在 Lead 的路径上" },
  },
  "packages/runtime/src/launcher.ts": {
    "recursive-fs": { count: 3, reason: "垫片的启动目录：几个小文件（控制文件、脚本），Run 结束时删" },
  },
  "packages/runtime/src/claude.ts": {
    "recursive-fs": { count: 1, reason: "Claude 执行器的临时设置目录：一个文件" },
  },
  "packages/engine/src/pipeline/restart-adoption.ts": {
    "recursive-fs": { count: 2, reason: "重启后清理垫片的启动目录：几个小文件" },
  },
  "packages/engine/src/installs/skills.ts": {
    "recursive-fs": { count: 2, reason: "安装 skill 的暂存目录和卸载的 skill 目录：一个 skill 只有几个文件" },
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function runtimeCode(file: string): string {
  return transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "esm" }).code;
}

function findings(file: string): Partial<Record<Kind, number>> {
  const code = runtimeCode(file);
  const counts: Partial<Record<Kind, number>> = {};
  for (const [kind, pattern] of PATTERNS) {
    const found = [...code.matchAll(pattern)].length;
    if (found) counts[kind] = found;
  }
  return counts;
}

describe("the daemon process does no heavy work in process (lead-scheduler spec P0)", () => {
  const files = DAEMON_PACKAGES.flatMap((pkg) => sourceFiles(packageSource(pkg)));
  const found = Object.fromEntries(files
    .map((file) => [relative(ROOT, file), findings(file)] as const)
    .filter(([, counts]) => Object.keys(counts).length > 0));

  it("covers the workspace, Lead and daemon modules", () => {
    const covered = files.map((file) => relative(ROOT, file));
    expect(covered).toEqual(expect.arrayContaining([
      "packages/engine/src/coordinator/workspace.ts",
      "packages/engine/src/coordinator/git-facts.ts",
      "packages/lead/src/session.ts",
      "apps/daemon/src/server.ts",
      "packages/core/src/host-jobs.ts",
    ]));
  });

  it("finds sync child_process calls and in-process recursive deletes only where they are listed, with their reasons", () => {
    const expected = Object.fromEntries(Object.entries(EXCEPTIONS).map(([file, kinds]) => [
      file, Object.fromEntries(Object.entries(kinds).map(([kind, entry]) => [kind, entry!.count])),
    ]));
    expect(found).toEqual(expected);
  });

  it("still detects a forbidden call, so the scan is not vacuous", () => {
    const code = [
      'import { rm } from "node:fs/promises";',
      'import { execFileSync } from "node:child_process";',
      "export async function drop(path: string) { await rm(path, {",
      "  recursive: true, force: true }); execFileSync(\"git\", [\"status\"]); }",
    ].join("\n");
    const stripped = transformSync(code, { loader: "ts", format: "esm" }).code;
    expect(PATTERNS.map(([kind, pattern]) => [kind, [...stripped.matchAll(pattern)].length]))
      .toEqual([["sync-child-process", 1], ["recursive-fs", 1]]);
  });
});
