// apps/cli/scripts/build.ts — 把 plc 命令行打包成 apps/cli/dist/cli.mjs。bin/plc 优先运行它。
// plc 是 daemon 的客户端，只打包 client、protocol 和 core，没有 native 依赖。
// plc 运行 daemon 的运维入口时，按 distDir() 找 daemon 的构建产物，不引用 daemon 包。
import { join } from "node:path";
import { build } from "esbuild";
import { packageSource, workspaceDir } from "@pi-lead-child/core";

const outdir = join(workspaceDir("cli"), "dist");
await build({
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
});
console.log(`build ok: ${outdir}/cli.mjs`);
