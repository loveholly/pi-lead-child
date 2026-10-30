// 工单 12（spec D8）的架构测试：内核模块的代码里不出现具体 runtime 的名字。
// 派发、恢复、目录、失败标题和模型解析都从 registry 读 adapter 的知识。新增一个 runtime 时，
// 只需要写 adapter，再在 registry 的装配处登记它，不需要改内核模块。
// 检查的对象是代码，不是注释：先用 esbuild 去掉注释和类型，再找 runtime id 的字面量。
// 只出现在类型里的字面量不算，它们不影响运行时的行为。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { packageSource } from "@pi-lead-child/core";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// 内核是除 protocol 之外的所有后端包。protocol 是线上契约，它的 runtime id 枚举本来就是契约的一部分。
// cli 现在还直接调用内核（过渡状态），所以也一起扫描。
const KERNEL_PACKAGES = ["core", "runtime", "store", "engine", "supervisor", "gateway", "lead", "daemon", "cli"];

// 允许出现 runtime 名字的文件。每一项都写明理由。
const NAMED_RUNTIME_FILES: Record<string, string> = {
  "packages/runtime/src/pi.ts": "adapter 本身",
  "packages/runtime/src/codex.ts": "adapter 本身",
  "packages/runtime/src/claude.ts": "adapter 本身",
  "packages/runtime/src/registry.ts": "registry 的装配处",
  "packages/runtime/src/index.ts": "runtime 包的公开出口：导出各 adapter，内核仍只通过 registry 取用它们",
  // 下面两项是留下的债，见工单 12 的 Comments。
  "packages/runtime/src/profile.ts": "配置目录的环境变量按名字写。工单 10 正在改 profile 的构造，合入后搬进 adapter",
  "packages/supervisor/src/server.ts": "supervisor 的状态列出各个 CLI 的路径。pi 不读 PLC_PI_BIN，和目录不同，搬进 registry 会改变行为",
};

// 冻结的文本片段。它们属于已经发布的契约，不是内核的决定，所以扫描前去掉。
const FROZEN_FRAGMENTS: Record<string, RegExp[]> = {
  // 旧库的 DDL：runs.runtime 的默认值。改它就改了 schema。
  "packages/store/src/schema.ts": [/DEFAULT 'pi'/g],
  "packages/store/src/db.ts": [/DEFAULT 'pi'/g],
  // agent 工具的 schema 是线上契约（packages/protocol 的 KernelRuntimeId）。字节必须保持不变。
  "packages/lead/src/tools.ts": [/Type\.Literal\("pi"\),\s*Type\.Literal\("codex"\),\s*Type\.Literal\("claude"\)/g],
  "packages/engine/src/agent-tools/definitions.ts": [/\[\s*"pi",\s*"codex",\s*"claude"\s*\]/g],
  // v51 的一次性数据更正（2026-10-21）：按 aefa7716 以前 Claude 和 pi 的 adapter 写下的事件格式重算 token 用量。
  // 它描述的是已经写进库里的历史，迁移发布以后不再改，所以只冻结这三处，文件的其余部分照常扫描。
  "packages/store/src/token-usage-recompute.ts": [
    /r\.runtime IN \('claude', 'pi'\)/g,
    /runtime === "claude"/g,
    /runtime === "pi"/g,
  ],
};

const RUNTIME_NAMES = "pi|codex|claude";
const PATTERNS: Array<[string, RegExp]> = [
  ["字面量", new RegExp(`(["'\`])(?:${RUNTIME_NAMES})\\1`, "g")],
  ["对象的键", new RegExp(`[{,]\\s*(?:${RUNTIME_NAMES})\\s*:`, "g")],
  // 只认标识符后面的属性访问。路径和产品名里的 .pi（例如 ~/.pi-lead-child）不是属性。
  ["属性", new RegExp(`(?<=[\\w)\\]?])\\.(?:${RUNTIME_NAMES})(?![\\w-])`, "g")],
  ["引用 adapter 模块", new RegExp(`/(?:${RUNTIME_NAMES})\\.js["']`, "g")],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

// esbuild 去掉注释和类型，只留下运行时会执行的代码。
function runtimeCode(file: string): string {
  return transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "esm" }).code;
}

function namedRuntimes(file: string): string[] {
  const path = relative(ROOT, file);
  let code = runtimeCode(file);
  for (const fragment of FROZEN_FRAGMENTS[path] ?? []) code = code.replace(fragment, "");
  return PATTERNS.flatMap(([kind, pattern]) =>
    [...code.matchAll(pattern)].map((match) => `${path}: ${kind} ${match[0].trim()}`));
}

describe("kernel modules do not name a runtime (spec D8)", () => {
  const kernel = KERNEL_PACKAGES
    .flatMap((pkg) => sourceFiles(packageSource(pkg)))
    .filter((file) => !(relative(ROOT, file) in NAMED_RUNTIME_FILES));

  it("covers the dispatch, recovery, manager and failure modules", () => {
    const covered = kernel.map((file) => relative(ROOT, file));
    expect(covered).toEqual(expect.arrayContaining([
      "packages/engine/src/coordinator/dispatch.ts",
      "packages/engine/src/coordinator/runtime-recovery.ts",
      "packages/engine/src/children/manager.ts",
      "packages/runtime/src/failure.ts",
      "packages/runtime/src/model.ts",
      "packages/engine/src/runtime-catalog.ts",
      "packages/engine/src/pipeline/ingest.ts",
      "packages/engine/src/pipeline/orchestrator.ts",
      "packages/lead/src/tools.ts",
      "apps/daemon/src/main.ts",
      "apps/cli/src/cli.ts",
    ]));
  });

  it("finds no runtime id outside the adapters and the registry", () => {
    expect(kernel.flatMap(namedRuntimes)).toEqual([]);
  });

  it("still detects a runtime id, so the scan is not vacuous", () => {
    const adapters = ["packages/runtime/src/pi.ts", "packages/runtime/src/codex.ts", "packages/runtime/src/claude.ts"];
    for (const adapter of adapters) expect(namedRuntimes(join(ROOT, adapter))).not.toEqual([]);
  });
});
