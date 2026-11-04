// apps/cli/scripts/build.ts — 把 plc 命令行打包成 apps/cli/dist/cli.mjs。bin/plc 优先运行它。
// plc 是 daemon 的客户端，只打包 client、protocol 和 core，没有 native 依赖。
// plc 运行 daemon 的运维入口时，按 distDir() 找 daemon 的构建产物，不引用 daemon 包。
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { packageSource, workspaceDir } from "@pi-lead-child/core";

// --outdir：supervisor 维护时构建到暂存目录（daemon 的 dist/.next/cli），备份成功以后和 daemon 一起换进来（2026-11-03 三审）。
const outdirArg = process.argv.indexOf("--outdir");
const outdir = outdirArg > 0 ? process.argv[outdirArg + 1] : join(workspaceDir("cli"), "dist");
if (!outdir) throw new Error("--outdir needs a directory");
const result = await build({
  entryPoints: { cli: packageSource("cli", "cli.ts") },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // ESM bundle 里 CJS 依赖需要 require 垫片
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  logLevel: "info",
  write: false,
});
// 先写临时文件（名字带 pid）再改名：构建中途被杀，不会留下写了一半的 cli.mjs。
for (const file of result.outputFiles) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(`${file.path}.${process.pid}.tmp`, file.contents);
  renameSync(`${file.path}.${process.pid}.tmp`, file.path);
}
console.log(`build ok: ${outdir}/cli.mjs`);
