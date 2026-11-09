// 从仓库的构建产物组装一个运行包（设计文档第 2 节），再打成 tar.gz，写 manifest.json。
//
// <out>/runtime/                     运行包目录，冒烟脚本（smoke-runtime.ts）直接跑它
// <out>/bytezard-lead-runtime-<版本>-arm64.tar.gz   运行包目录的内容，解开就是 versions/<版本>/
// <out>/manifest.json               更新检查读的清单，带 tar.gz 的大小和 SHA-256
// <out>/bytezard-lead-sourcemaps-<版本>-arm64.tar.gz   dist 里的源码映射，不进运行包（设计第 7.5.7 节）
// <out>/cache/                      下载的 Node，哈希对得上时下次复用
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { RUNTIME_ASSETS } from "@pi-lead-child/core";
import { AGENT_BINARY, installAgent, type SignFn } from "./agent-bundle.js";
import { copyExternals, externalClosure, type ClosureEntry, type Lockfile } from "./externals.js";
import { assertMachOArch } from "./macho.js";
import { extractNodeBinary, fetchVerifiedNode, type FetchLike } from "./node-dist.js";
import {
  hashComponents, hashFiles, MANIFEST_FILE, RELEASE_FILE, releaseManifest, runtimeArchiveName, sha256File, sourceMapArchiveName,
  SUPPORTED_ARCH, updateManifest, type ReleaseManifest, type UpdateManifest,
} from "./release.js";

const execFileAsync = promisify(execFile);

// 运行时按路径加载的文件（core 的 RUNTIME_ASSETS，工单 #260）：pi 扩展的 bundle、child-skills、Lead 的 skill 和辅助脚本。
// 运行包里没有源码，少了哪一个，用到它的功能就起不来。扩展目录里的 package.json 让 pi 的加载器改写这些 bundle
// （apps/daemon/scripts/build.ts），少了它 SoL-Pi 找不到 pi 的包。
export const RUNTIME_ASSET_FILES: readonly string[] = [
  ...Object.values(RUNTIME_ASSETS).map((asset) => ["apps/daemon/dist", ...asset.dist].join("/")),
  "apps/daemon/dist/assets/extensions/package.json",
];

// 打包要用的构建产物。缺任何一个都说明还没构建，或者构建失败了。
export const REQUIRED_BUILD_FILES: readonly string[] = [
  "apps/daemon/dist/supervisor.mjs",
  "apps/daemon/dist/coordinatord.mjs",
  "apps/daemon/dist/ops.mjs",
  "apps/daemon/dist/mcp-server.mjs",
  "apps/daemon/dist/hindsight.mjs",
  "apps/daemon/dist/idle-compact.mjs",
  "apps/daemon/dist/launcher-shim.mjs",
  "apps/daemon/dist/web/index.html",
  "apps/cli/dist/cli.mjs",
  ...RUNTIME_ASSET_FILES,
];

const SOURCE_MAP = /\.map$/;
// dist 里不进运行包的东西：开发模式的构建记录（发布模式看 release.json），build:web 中途留下的临时目录，
// 源码映射（约 54 MB，运行时用不到，另打成附件，设计第 7.5.7 节）。
const SKIPPED_DIST_ENTRIES = [/^build-info\.json$/, /^\.web-staging-/, /^\.web-previous-/, SOURCE_MAP];

// bin/plc：用运行包自带的 Node 运行 plc。从 PATH 上的软链接调用时也先解开链接，找到运行包根。
export const PLC_WRAPPER = `#!/bin/sh
# plc 命令行：用运行包自带的 Node（bin/lead-agent）运行 apps/cli/dist/cli.mjs。
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
exec "$ROOT/bin/lead-agent" "$ROOT/apps/cli/dist/cli.mjs" "$@"
`;

export interface PackOptions {
  repoRoot: string;
  outDir: string;
  version: string;
  repository: string;
  nodeVersion: string;
  schemaVersion: number;
  sourceTree: string;
  externals: readonly string[];
  nodeDistUrl?: string;
  fetchImpl?: FetchLike;
  now?: Date;
  log?: (line: string) => void;
  /** 给后台服务的程序（bin/lead-agent）重签。缺省是 codesign 的 ad-hoc 签名；测试里的假 Node 签不了，换成假的。 */
  sign?: SignFn;
}

export interface PackResult {
  runtimeDir: string;
  archive: string;
  /** 源码映射的附件；dist 里没有源码映射时为 null。 */
  sourceMaps: string | null;
  manifestPath: string;
  release: ReleaseManifest;
  manifest: UpdateManifest;
  externals: ClosureEntry[];
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDist(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => !(dirname(path) === source && SKIPPED_DIST_ENTRIES.some((re) => re.test(basename(path)))),
  });
}

export async function packRuntime(o: PackOptions): Promise<PackResult> {
  const log = o.log ?? (() => {});
  const arch = SUPPORTED_ARCH;
  const repoRoot = resolve(o.repoRoot);
  const outDir = resolve(o.outDir);
  if (outDir === repoRoot) throw new Error("--out 不能是仓库根目录");

  const missing = REQUIRED_BUILD_FILES.filter((file) => !existsSync(join(repoRoot, file)));
  if (missing.length) {
    throw new Error(`缺少构建产物：${missing.join("、")}。先在仓库根运行 npm run build && npm run build:web`);
  }

  const runtimeDir = join(outDir, "runtime");
  const archiveName = runtimeArchiveName(o.version);
  const archive = join(outDir, archiveName);
  const manifestPath = join(outDir, MANIFEST_FILE);
  const sourceMapArchive = join(outDir, sourceMapArchiveName(o.version));
  // 只清掉这个脚本自己产出的东西，cache 留着。
  for (const path of [runtimeDir, archive, manifestPath, sourceMapArchive]) rmSync(path, { recursive: true, force: true });
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });

  // Node：官方二进制，校验哈希，改名为 lead-agent（设计文档第 9 节决定 6、7），用自己的标识重新做 ad-hoc 签名，
  // 再建软链接 bin/Bytezard Lead 给 launchd 用：登录项显示这个软链接的名字，进程名还是 lead-agent（第 8.7 节，做法 1b）。
  const node = await fetchVerifiedNode({
    version: o.nodeVersion, arch, cacheDir: join(outDir, "cache", "node"), baseUrl: o.nodeDistUrl, fetchImpl: o.fetchImpl, log,
  });
  await installAgent({
    root: runtimeDir,
    placeBinary: async (dest) => {
      await extractNodeBinary({ tarball: node.tarball, version: o.nodeVersion, arch, dest, workDir: outDir });
      assertMachOArch(dest, AGENT_BINARY, arch);
    },
    sign: o.sign,
  });
  // 给 #!/usr/bin/env node 的脚本用（pi 的 bin 就是这样的脚本）。
  symlinkSync("lead-agent", join(runtimeDir, "bin", "node"));
  writeFileSync(join(runtimeDir, "bin", "plc"), PLC_WRAPPER);
  chmodSync(join(runtimeDir, "bin", "plc"), 0o755);

  // 沿用仓库的目录形状：projectRoot() 找声明了 workspaces 的 package.json，workspaceDir() 看 apps/<名字>/package.json。
  writeJson(join(runtimeDir, "package.json"), { name: "bytezard-lead-runtime", private: true, type: "module", workspaces: [] });
  for (const app of ["daemon", "cli"]) {
    const name = (JSON.parse(readFileSync(join(repoRoot, "apps", app, "package.json"), "utf8")) as { name: string }).name;
    mkdirSync(join(runtimeDir, "apps", app), { recursive: true });
    writeJson(join(runtimeDir, "apps", app, "package.json"), { name, private: true, type: "module" });
    copyDist(join(repoRoot, "apps", app, "dist"), join(runtimeDir, "apps", app, "dist"));
  }
  const lost = RUNTIME_ASSET_FILES.filter((file) => !existsSync(join(runtimeDir, file)));
  if (lost.length) throw new Error(`运行包里缺少运行时加载的文件：${lost.join("、")}`);

  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as Lockfile;
  const externals = copyExternals({ repoRoot, lock, entries: externalClosure(lock, o.externals), dest: runtimeDir });
  log(`node_modules：${externals.length} 个包（${o.externals.join("、")} 及其依赖）`);
  const sqlite = join(runtimeDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!existsSync(sqlite)) throw new Error("运行包里没有 better-sqlite3 的原生模块 build/Release/better_sqlite3.node");
  assertMachOArch(sqlite, "better-sqlite3 的 .node 文件", arch);

  const release = releaseManifest({
    version: o.version, node: o.nodeVersion, schemaVersion: o.schemaVersion, sourceTree: o.sourceTree,
    builtAt: o.now ?? new Date(), repository: o.repository, files: await hashFiles(runtimeDir), components: hashComponents(runtimeDir),
  });
  writeJson(join(runtimeDir, RELEASE_FILE), release);

  // COPYFILE_DISABLE：macOS 的 tar 不往包里塞 ._ 开头的扩展属性文件。
  // release.json 放在第一项：壳解包时先只读它，按 components 决定哪些部分不用解（设计第 7.5.4 节）。
  const entries = ["./release.json", ...readdirSync(runtimeDir).filter((name) => name !== RELEASE_FILE).sort().map((name) => `./${name}`)];
  const tarEnv = { env: { ...process.env, COPYFILE_DISABLE: "1" } };
  await execFileAsync("tar", ["-czf", archive, "-C", runtimeDir, ...entries], tarEnv);
  const manifest = updateManifest(release, { file: archiveName, size: statSync(archive).size, sha256: await sha256File(archive) });
  writeJson(manifestPath, manifest);

  const maps = ["daemon", "cli"].flatMap((app) => {
    const dist = join(repoRoot, "apps", app, "dist");
    return readdirSync(dist).filter((name) => SOURCE_MAP.test(name)).map((name) => `apps/${app}/dist/${name}`);
  });
  if (maps.length) await execFileAsync("tar", ["-czf", sourceMapArchive, "-C", repoRoot, ...maps], tarEnv);
  log(`运行包：${runtimeDir}`);
  log(`附件：${archive}、${manifestPath}${maps.length ? `、${sourceMapArchive}` : ""}`);
  return { runtimeDir, archive, sourceMaps: maps.length ? sourceMapArchive : null, manifestPath, release, manifest, externals };
}
