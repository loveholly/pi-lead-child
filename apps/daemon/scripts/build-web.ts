// apps/daemon/scripts/build-web.ts — 把 apps/companion 导出成静态 web UI，写到 apps/daemon/dist/web。
// daemon 的配对网关在 / 下提供它（packages/gateway/src/web-static.ts），所以用户只打开网关地址，不需要 dev server。
//
// 导出不读任何 .env 文件，也不继承 shell 里的 EXPO_PUBLIC_*：回环地址上的页面以自己的 origin 作为网关地址，
// 换端口或换主机都不用重新构建。--clear 是必须的：Metro 缓存里会留着上一次内联的 EXPO_PUBLIC 值。
//
// 网页版本（2026-10-20，protocol 的 web-build.ts）：同一个版本号内联进 bundle（EXPO_PUBLIC_PLC_WEB_BUILD），
// 也写进导出目录的 web-build.json。已经打开的页面读到不一样的版本，就提示刷新。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { distDir, projectRoot } from "@pi-lead-child/core";
import { WEB_BUILD_FILE, webBuildInfo } from "@pi-lead-child/protocol";
import { buildProvenance } from "@pi-lead-child/supervisor";

const root = projectRoot();
const companion = join(root, "apps", "companion");
// workspaces 会把 expo 提升到仓库根的 node_modules，只有版本冲突时才留在 apps/companion 自己的 node_modules。
const expo = [join(companion, "node_modules", ".bin", "expo"), join(root, "node_modules", ".bin", "expo")].find(existsSync);
const dist = distDir();
const target = join(dist, "web");
const staging = join(dist, `.web-staging-${process.pid}`);
const previous = join(dist, `.web-previous-${process.pid}`);

if (!expo) {
  console.error("build:web: 找不到 expo 可执行文件。先在仓库根运行 npm install");
  process.exit(1);
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("EXPO_PUBLIC_")) delete env[key];
}
env.EXPO_NO_DOTENV = "1";
env.EXPO_PUBLIC_PLC_SERVED_BY_GATEWAY = "1";
const webBuild = webBuildInfo(buildProvenance(root));
env.EXPO_PUBLIC_PLC_WEB_BUILD = webBuild.build;
env.CI = "1";

mkdirSync(dist, { recursive: true });
rmSync(staging, { recursive: true, force: true });
const result = spawnSync(expo, ["export", "--platform", "web", "--output-dir", staging, "--clear"], {
  cwd: companion,
  env,
  stdio: "inherit",
});
if (result.status !== 0 || !existsSync(join(staging, "index.html"))) {
  rmSync(staging, { recursive: true, force: true });
  console.error(`build:web: expo export 失败（exit ${result.status ?? result.signal}）`);
  process.exit(1);
}

// 版本文件和页面放在同一个目录里一起换：daemon 提供的版本号永远和它提供的页面一致。
writeFileSync(join(staging, WEB_BUILD_FILE), `${JSON.stringify(webBuild, null, 2)}\n`);

// 先换目录再删旧的：正在运行的 daemon 任何时候都读到一份完整的导出。
if (existsSync(target)) renameSync(target, previous);
renameSync(staging, target);
rmSync(previous, { recursive: true, force: true });
console.log(`build:web ok: ${target}（网页版本 ${webBuild.build}）`);
