// apps/daemon/scripts/build.ts — esbuild 打包（spec §B1）。better-sqlite3 是 native addon 必须 external；
// 运行时靠仓库 node_modules 解析。目标：launchd 跑 node apps/daemon/dist/，不依赖 tsx。
// 这里构建 supervisor、launchd 加载的运行时产物，以及 plc 调用的运维入口 ops.mjs。
// plc 的 cli.mjs 由 apps/cli/scripts/build.ts 构建。
// 各后端包以源码形式互相引用（exports 指向 src/index.ts），这里把它们一起打进每个入口。
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { distDir, packageSource, projectRoot, RUNTIME_ASSETS, type RuntimeAsset } from "@pi-lead-child/core";
import { clearBuildProvenance, writeBuildProvenance } from "@pi-lead-child/supervisor";
import { DAEMON_EXTERNALS } from "./externals.js";

const external = [...DAEMON_EXTERNALS];

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
    // 空闲车道写压缩摘要的子进程（lead 的 scheduler/idle-compaction.ts，lead-scheduler spec P4）。
    "idle-compact": packageSource("lead", "scheduler", "idle-compact-child.ts"),
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
// 运行时按路径加载的文件（core 的 RUNTIME_ASSETS，工单 #260）：桌面版的运行包里没有源码，从 dist/assets/ 加载。
// pi 扩展打成 bundle，pi SDK、typebox 和 daemon 的 external 不打进去。
// pi 用 jiti 加载扩展：.mjs 和 type 为 module 的 .js 走 Node 原生 import，不经过 pi 给 pi SDK、typebox 起的别名，
// SoL-Pi 的入口（sol-pi.ts 的 registerSolPi）就找不到 pi 的包。所以 bundle 是 .js，目录里放一个 type 为 commonjs 的
// package.json，让 jiti 像对源码一样改写后加载。改写以后的代码由 jiti 提供 require，不加上面那个 require 垫片。
const assets: RuntimeAsset[] = Object.values(RUNTIME_ASSETS);
const extensions = assets.filter((asset) => asset.kind === "extension");
rmSync(join(outdir, "assets"), { recursive: true, force: true });
await build({
  entryPoints: Object.fromEntries(extensions.map((asset) => [join(...asset.dist).replace(/\.js$/, ""), packageSource(asset.pkg, ...asset.source)])),
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [...external, "typebox", "typebox/*", "@earendil-works/*"],
  logLevel: "info",
});
for (const dir of new Set(extensions.map((asset) => join(outdir, ...asset.dist.slice(0, -1))))) {
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
}
for (const asset of assets.filter((entry) => entry.kind === "copy")) {
  const target = join(outdir, ...asset.dist);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(packageSource(asset.pkg, ...asset.source), target, { recursive: true });
}
// 记下这次构建来自哪个 commit、构建时源码有没有改动。Lead 请求重启前按它检查（supervisor 的 deploy/readiness.ts）：
// 没提交的代码不能部署。
const provenance = writeBuildProvenance(projectRoot(), outdir);
console.log(`build ok: ${outdir}/{supervisor,coordinatord,ops,mcp-server,hindsight,idle-compact,launcher-shim}.mjs, assets/`);
console.log(`build provenance: ${provenance.commit}${provenance.dirty ? ` (dirty: ${provenance.dirtyFiles.join(", ")})` : ""}`);
