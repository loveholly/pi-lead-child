// apps/daemon/scripts/build.ts — esbuild 打包（spec §B1）。better-sqlite3 是 native addon 必须 external；
// 运行时靠仓库 node_modules 解析。目标：launchd 跑 node apps/daemon/dist/，不依赖 tsx。
// 这里构建 supervisor、launchd 加载的运行时产物，以及 plc 调用的运维入口 ops.mjs。
// plc 的 cli.mjs 由 apps/cli/scripts/build.ts 构建。
// 各后端包以源码形式互相引用（exports 指向 src/index.ts），这里把它们一起打进每个入口。
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { distDir, packageSource, projectRoot } from "@pi-lead-child/core";
import { clearBuildProvenance, writeBuildProvenance } from "@pi-lead-child/supervisor";

const external = [
  "better-sqlite3",
  // pi SDK 打包失败（transitive @mistralai/mistralai 引用未安装的 optional @opentelemetry/api），
  // 按 spec §B1 决策规则加入 external，运行时靠仓库 node_modules 解析。
  "@earendil-works/pi-coding-agent",
  // 沙箱（lead-tools-and-routing spec D2）：它按自己的安装位置找辅助文件（Windows 的 srt-win、代理的入口），打进包里会找错位置。
  // 运行时靠仓库 node_modules 解析；pi 子进程加载的扩展（engine 的 extension/sandbox.ts）也是这样找到它的。
  "@anthropic-ai/sandbox-runtime",
];

const outdir = distDir();
mkdirSync(outdir, { recursive: true });
// 先删掉上一次的构建记录：这次构建中途失败时，部署闸门看到的是「没有记录」，不是一份旧的、看起来干净的记录。
clearBuildProvenance(outdir);
await build({
  entryPoints: {
    supervisor: packageSource("supervisor", "main.ts"),
    coordinatord: packageSource("daemon", "main.ts"),
    ops: packageSource("daemon", "ops.ts"),
    "mcp-server": packageSource("engine", "agent-tools", "mcp-server.ts"),
    // Hindsight 记忆服务的 launchd 入口（supervisor 的 deploy/hindsight.ts）。
    hindsight: packageSource("daemon", "hindsight-main.ts"),
  },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external,
  // ESM bundle 里 CJS 依赖需要 require 垫片
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  logLevel: "info",
});
// 启动垫片（工单 14）是独立运行的脚本，不打包。launcher.ts 在自己所在的目录里找它，
// 所以把它复制到 dist/，和同一次构建的 launcher 放在一起。
copyFileSync(packageSource("runtime", "launcher-shim.mjs"), join(outdir, "launcher-shim.mjs"));
// 记下这次构建来自哪个 commit、构建时源码有没有改动。Lead 请求重启前按它检查（supervisor 的 deploy/readiness.ts）：
// 没提交的代码不能部署。
const provenance = writeBuildProvenance(projectRoot(), outdir);
console.log(`build ok: ${outdir}/{supervisor,coordinatord,ops,mcp-server,hindsight,launcher-shim}.mjs`);
console.log(`build provenance: ${provenance.commit}${provenance.dirty ? ` (dirty: ${provenance.dirtyFiles.join(", ")})` : ""}`);
