// App 的一键更新（updater.ts）。网络和系统命令换成假的：fetch 回 manifest 和 dmg 的字节，hdiutil 把一个假的 App
// 放进挂载点，ditto 照原样复制，plutil 从假 App 的 Info.plist（这里写成 JSON）里读值。
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { ExecFile } from "../src/process.js";
import {
  appBundleOf, createUpdater, DOWNLOAD_RETRY_DELAYS_MS, DOWNLOAD_STALL_MS, dmgDownloadUrl, dmgFileName, LSREGISTER, parseUpdateManifest, updateBaseUrl,
  UPDATE_CHECK_INTERVAL_MS, UPDATE_STAGING_PREFIX,
  type ShellUpdateStatus, type UpdaterDeps,
} from "../src/updater.js";
import { sha256 } from "./fixtures.js";

const REPO = "acme/lead";

function writeApp(dir: string, version: string, id = "com.bytezard.plc") {
  mkdirSync(join(dir, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(dir, "Contents", "Info.plist"), JSON.stringify({ CFBundleShortVersionString: version, CFBundleIdentifier: id }));
  writeFileSync(join(dir, "Contents", "MacOS", "Bytezard Lead"), `app ${version}\n`);
}

function manifest(version: string, dmg: string, o: { size?: number; sha?: string } = {}) {
  return {
    schema: 1, product: "bytezard-lead", version, arch: "arm64",
    runtime: { file: `bytezard-lead-runtime-${version}-arm64.tar.gz`, size: 1, sha256: "0".repeat(64) },
    dmg: { file: dmgFileName(version), size: o.size ?? Buffer.byteLength(dmg), sha256: o.sha ?? sha256(dmg) },
  };
}

interface Setup {
  updater: ReturnType<typeof createUpdater>;
  app: string;
  applications: string;
  shellUserData: string;
  statuses: ShellUpdateStatus[];
  urls: string[];
  /** 每次请求的 cache 选项。 */
  caches: Array<string | undefined>;
  /** 每次下载 dmg 的请求带的 Range 头（没有时为 undefined）。 */
  ranges: Array<string | undefined>;
  /** 自动重试前等了多久。 */
  sleeps: number[];
  commands: string[][];
  relaunches: number;
  clock: { now: Date };
  /** 现在 GitHub 上最新的 release：测试中途可以改，模拟发了新版。 */
  github: { latest: string | null };
}

/** 一次 dmg 请求：url、Range 头，和这是第几次 dmg 请求（从 0 开始）。 */
interface DmgRequest {
  url: string;
  range: string | undefined;
  attempt: number;
}

/** 先给出 bytes，然后不再有数据（模拟卡住的连接）。 */
function stallingBody(bytes: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(bytes)); } });
}

/** 先给出 bytes，然后连接断开。 */
function breakingBody(bytes: string, reason = "net::ERR_CONNECTION_RESET"): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) controller.error(new Error(reason));
      else controller.enqueue(new TextEncoder().encode(bytes));
      sent = true;
    },
  });
}

function setup(o: {
  current?: string;
  latest?: string | null;
  dmgVersion?: string;
  dmgBody?: string;
  manifestOverrides?: { size?: number; sha?: string };
  manifestStatus?: number;
  failRename?: boolean;
  appBundle?: string | null;
  shellUserData?: string;
  prepareRuntime?: UpdaterDeps["prepareRuntime"];
  /** 换掉 dmg 的回应；返回 null 时照 GitHub 的规矩回。 */
  serveDmg?: (request: DmgRequest, github: (request: DmgRequest) => Response) => Response | Promise<Response> | null;
  /** 这些版本的 release 没有 dmg（GitHub 回 404）。 */
  missing?: string[];
  stallMs?: number;
} = {}): Setup {
  const root = tempDir("plc-desktop-update-");
  const applications = join(root, "Applications");
  const app = join(applications, "Bytezard Lead.app");
  const current = o.current ?? "1.0.0";
  writeApp(app, current);
  const runtime = join(root, "data", "runtime", "current");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "release.json"), JSON.stringify({ version: current, updateSource: { type: "github", repository: REPO } }));
  const shellUserData = o.shellUserData ?? join(root, "data", "shell");
  const dmgBody = o.dmgBody ?? "dmg bytes";
  const result: Setup = {
    updater: null as never, app, applications, shellUserData, statuses: [], urls: [], caches: [], ranges: [], sleeps: [], commands: [], relaunches: 0,
    clock: { now: new Date("2026-11-05T01:00:00.000Z") },
    github: { latest: o.latest === undefined ? "1.1.0" : o.latest },
  };
  // 照 GitHub 回 dmg：releases/latest/download/<文件> 跳到最新的 release，那里只有最新版本的文件；
  // releases/download/v<版本>/<文件> 是那个版本自己的 release。支持 Range。
  const github = (request: DmgRequest): Response => {
    const pinned = /\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(request.url);
    const latest = /\/releases\/latest\/download\/([^/]+)$/.exec(request.url);
    const release = pinned ? pinned[1]! : latest ? result.github.latest : null;
    const file = pinned ? pinned[2]! : latest ? latest[1]! : null;
    if (!release || !file || file !== dmgFileName(release) || o.missing?.includes(release)) return new Response("Not Found", { status: 404 });
    const range = /^bytes=(\d+)-$/.exec(request.range ?? "");
    if (!range) return new Response(dmgBody);
    const from = Number(range[1]);
    const size = Buffer.byteLength(dmgBody);
    if (from >= size) return new Response("", { status: 416 });
    return new Response(Buffer.from(dmgBody).subarray(from), { status: 206, headers: { "Content-Range": `bytes ${from}-${size - 1}/${size}` } });
  };
  let dmgRequests = 0;
  const fetch: UpdaterDeps["fetch"] = async (url, init) => {
    result.urls.push(url);
    result.caches.push(init?.cache);
    if (url.endsWith("/manifest.json")) {
      const latest = result.github.latest;
      if (latest === null) return new Response("Not Found", { status: 404 });
      if (o.manifestStatus) return new Response("", { status: o.manifestStatus });
      return Response.json(manifest(latest, dmgBody, o.manifestOverrides));
    }
    const request = { url, range: init?.headers?.Range, attempt: dmgRequests++ };
    result.ranges.push(request.range);
    return o.serveDmg?.(request, github) ?? github(request);
  };
  const execFile: ExecFile = async (file, args) => {
    result.commands.push([file, ...args]);
    // 假的 hdiutil 把 dmg 文件名里的版本的 App 放进挂载点（dmgVersion 换掉它，模拟 dmg 里的 App 不对）。
    if (file.endsWith("hdiutil") && args[0] === "attach") {
      const version = o.dmgVersion ?? /bytezard-lead-(.+)-arm64\.dmg$/.exec(args.at(-1)!)![1]!;
      writeApp(join(args[args.indexOf("-mountpoint") + 1]!, "Bytezard Lead.app"), version);
    }
    if (file.endsWith("ditto")) cpSync(args[0]!, args[1]!, { recursive: true });
    if (file.endsWith("plutil")) {
      const plist = JSON.parse(readFileSync(args.at(-1)!, "utf8")) as Record<string, string>;
      return { stdout: `${plist[args[1]!]}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  result.updater = createUpdater({
    paths: { current: runtime, shellUserData },
    env: {},
    currentVersion: current,
    appBundle: o.appBundle === undefined ? app : o.appBundle,
    fetch,
    execFile,
    relaunch: () => { result.relaunches += 1; },
    onStatus: (status) => result.statuses.push(status),
    now: () => result.clock.now,
    rename: async (from, to) => {
      if (o.failRename && from.endsWith("new.app")) throw new Error("EPERM");
      await rename(from, to);
    },
    ...(o.prepareRuntime ? { prepareRuntime: o.prepareRuntime } : {}),
    sleep: async (ms) => { result.sleeps.push(ms); },
    ...(o.stallMs ? { stallMs: o.stallMs } : {}),
  });
  return result;
}

function appVersion(app: string): string {
  return (JSON.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8")) as { CFBundleShortVersionString: string }).CFBundleShortVersionString;
}

describe("update source and manifest", () => {
  it("reads the repository from the installed runtime and lets a local or https override replace it", () => {
    const current = tempDir("plc-desktop-update-source-");
    expect(updateBaseUrl(current, {})).toBeNull();
    writeFileSync(join(current, "release.json"), JSON.stringify({ updateSource: { type: "github", repository: REPO } }));
    expect(updateBaseUrl(current, {})).toBe(`https://github.com/${REPO}/releases/latest/download`);
    expect(updateBaseUrl(current, { BYTEZARD_UPDATE_URL: "http://127.0.0.1:8765/updates/" })).toBe("http://127.0.0.1:8765/updates");
    expect(updateBaseUrl(current, { BYTEZARD_UPDATE_URL: "https://downloads.example.com/lead" })).toBe("https://downloads.example.com/lead");
    expect(updateBaseUrl(current, { BYTEZARD_UPDATE_URL: "http://downloads.example.com/lead" })).toBeNull();
    writeFileSync(join(current, "release.json"), JSON.stringify({ updateSource: { type: "github", repository: "acme/lead/../x" } }));
    expect(updateBaseUrl(current, {})).toBeNull();
  });

  it("accepts a manifest only with this product, arch, a semver version and the dmg of that version", () => {
    const good = manifest("1.2.0", "x");
    expect(parseUpdateManifest(good)).toEqual({ version: "1.2.0", dmg: good.dmg });
    expect(parseUpdateManifest({ ...good, product: "other" })).toBeNull();
    expect(parseUpdateManifest({ ...good, arch: "x64" })).toBeNull();
    expect(parseUpdateManifest({ ...good, version: "1.2" })).toBeNull();
    expect(parseUpdateManifest({ ...good, dmg: undefined })).toBeNull();
    expect(parseUpdateManifest({ ...good, dmg: { ...good.dmg, file: "../evil.dmg" } })).toBeNull();
    expect(parseUpdateManifest({ ...good, dmg: { ...good.dmg, sha256: "abc" } })).toBeNull();
    expect(parseUpdateManifest({ ...good, dmg: { ...good.dmg, size: -1 } })).toBeNull();
  });

  it("finds the .app of the running program", () => {
    expect(appBundleOf("/Applications/Bytezard Lead.app/Contents/MacOS/Bytezard Lead")).toBe("/Applications/Bytezard Lead.app");
    expect(appBundleOf("/usr/local/bin/electron")).toBeNull();
  });
});

describe("checking for updates", () => {
  it("offers a newer version, and nothing when the latest release is not newer or has no manifest", async () => {
    const newer = setup({ latest: "1.1.0" });
    await newer.updater.check();
    expect(newer.urls).toEqual([`https://github.com/${REPO}/releases/latest/download/manifest.json`]);
    expect(newer.updater.status()).toEqual({ state: "available", version: "1.1.0", size: Buffer.byteLength("dmg bytes") });
    expect(newer.statuses.at(-1)).toEqual(newer.updater.status());

    const same = setup({ latest: "1.0.0" });
    await same.updater.check();
    expect(same.updater.status()).toEqual({ state: "none" });

    const missing = setup({ latest: null });
    await missing.updater.check();
    expect(missing.updater.status()).toEqual({ state: "none" });
  });

  // 2026-11-05 在真的 App 里发现：Electron 的 net.fetch 走 Chromium 的 HTTP 缓存，发了新版以后还拿到旧的 manifest。
  it("asks for the manifest and the dmg past the HTTP cache", async () => {
    const run = setup();
    await run.updater.check();
    await run.updater.apply();
    expect(run.urls).toHaveLength(2);
    expect(run.caches).toEqual(["no-store", "no-store"]);
  });

  it("checks at most once a day, and retries in the next hour after a failed check", async () => {
    const run = setup({ manifestStatus: 502 });
    await run.updater.checkIfDue();
    await run.updater.checkIfDue();
    expect(run.urls).toHaveLength(2);

    const ok = setup();
    await ok.updater.checkIfDue();
    ok.clock.now = new Date(ok.clock.now.getTime() + UPDATE_CHECK_INTERVAL_MS - 1);
    await ok.updater.checkIfDue();
    expect(ok.urls).toHaveLength(1);
    ok.clock.now = new Date(ok.clock.now.getTime() + 1);
    await ok.updater.checkIfDue();
    expect(ok.urls).toHaveLength(2);
  });

  it("tells the menu what it found: a newer version, the latest one, no update information, a failure, or no update source", async () => {
    expect(await setup({ latest: "1.1.0" }).updater.check()).toEqual({ kind: "available", version: "1.1.0" });
    expect(await setup({ latest: "1.0.0" }).updater.check()).toEqual({ kind: "current" });
    // 2026-11-05：测试构建里的更新源是占位的仓库，清单 404，菜单却说「已是最新」。没有清单不算最新。
    expect(await setup({ latest: null }).updater.check()).toEqual({ kind: "no_info", source: `https://github.com/${REPO}/releases/latest/download` });
    expect(await setup({ manifestStatus: 502 }).updater.check()).toEqual({ kind: "failed", reason: "HTTP 502" });
    const noSource = setup();
    writeFileSync(join(noSource.shellUserData, "..", "runtime", "current", "release.json"), JSON.stringify({ version: "1.0.0" }));
    expect(await noSource.updater.check()).toEqual({ kind: "no_source" });
  });

  it("offers a dismissed version again when the user checks from the menu", async () => {
    const run = setup();
    await run.updater.check();
    run.updater.dismiss();
    expect(run.updater.status()).toEqual({ state: "none" });
    await run.updater.check({ manual: true });
    expect(run.updater.status()).toMatchObject({ state: "available", version: "1.1.0" });
  });

  it("hides a dismissed version for a day, then offers it again", async () => {
    const run = setup();
    await run.updater.check();
    run.updater.dismiss();
    expect(run.updater.status()).toEqual({ state: "none" });
    run.clock.now = new Date(run.clock.now.getTime() + UPDATE_CHECK_INTERVAL_MS);
    expect(run.updater.status()).toMatchObject({ state: "available", version: "1.1.0" });
  });
});

describe("applying an update", () => {
  it("downloads and checks the dmg, replaces the App and relaunches", async () => {
    const run = setup();
    await run.updater.check();
    await run.updater.apply();
    expect(run.relaunches).toBe(1);
    expect(appVersion(run.app)).toBe("1.1.0");
    expect(run.urls.at(-1)).toBe(`https://github.com/${REPO}/releases/download/v1.1.0/${dmgFileName("1.1.0")}`);
    expect([...new Set(run.statuses.map((status) => status.state))]).toEqual(["available", "downloading", "installing"]);
    const files = run.commands.map((command) => command[0]);
    expect(files).toEqual([
      "/usr/bin/hdiutil", "/usr/bin/ditto", "/usr/bin/hdiutil", "/usr/bin/plutil", "/usr/bin/plutil", "/usr/bin/plutil", "/usr/bin/codesign", "/usr/bin/xattr",
      LSREGISTER,
    ]);
    // 旧 App 留在隐藏的暂存目录里，新 App 打开时 cleanup 删掉它和下载目录。
    const staging = readdirSync(run.applications).filter((name) => name.startsWith(UPDATE_STAGING_PREFIX));
    expect(staging).toHaveLength(1);
    expect(appVersion(join(run.applications, staging[0]!, "old.app"))).toBe("1.0.0");
    await run.updater.cleanup();
    expect(readdirSync(run.applications)).toEqual(["Bytezard Lead.app"]);
    expect(existsSync(join(run.shellUserData, "updates"))).toBe(false);
  });

  // 设计第 7.5.6 节：换掉 App 以前先解好新版本的运行包，新 App 打开时只要换 current。
  it("prepares the runtime of the new App before it replaces the App, and still updates when that fails", async () => {
    const prepared: Array<{ staged: string; appVersionThen: string; stagedVersion: string }> = [];
    const run = setup({
      prepareRuntime: async (staged) => {
        prepared.push({ staged, appVersionThen: appVersion(run.app), stagedVersion: appVersion(staged) });
        return "{\"version\":\"unpacked\"}";
      },
    });
    await run.updater.check();
    await run.updater.apply();
    expect(prepared).toEqual([{ staged: expect.stringMatching(/new\.app$/), appVersionThen: "1.0.0", stagedVersion: "1.1.0" }]);
    expect(run.relaunches).toBe(1);
    expect(readFileSync(join(run.shellUserData, "update.log"), "utf8")).toMatch(/prepared the runtime of 1\.1\.0 in \d+ ms: \{"version":"unpacked"\}/);

    const failing = setup({ prepareRuntime: async () => { throw new Error("no space left on the disk"); } });
    await failing.updater.check();
    await failing.updater.apply();
    expect(failing.relaunches).toBe(1);
    expect(appVersion(failing.app)).toBe("1.1.0");
    expect(readFileSync(join(failing.shellUserData, "update.log"), "utf8")).toContain("the new App unpacks it itself: no space left on the disk");
  });

  // 2026-11-05：换了 App 图标以后，通知还是 Electron 的图标。macOS 按 bundle id 找图标，LaunchServices 里记着 17 份同一个
  // bundle id 的 App，其中有更新时挪进暂存目录的旧 App（目录早就删了，登记还在），换上的 App 的修改时间又是打包时的。
  it("registers the new App again after the swap, with a fresh modification time", async () => {
    const run = setup();
    await run.updater.check();
    await run.updater.apply();
    expect(run.commands.at(-1)).toEqual([LSREGISTER, "-f", run.app]);
    expect(statSync(run.app).mtimeMs).toBe(run.clock.now.getTime());
  });

  it("removes the registration of the old App before it deletes the staging folder", async () => {
    const run = setup();
    await run.updater.check();
    await run.updater.apply();
    const staging = readdirSync(run.applications).find((name) => name.startsWith(UPDATE_STAGING_PREFIX))!;
    run.commands.length = 0;
    await run.updater.cleanup();
    expect(run.commands).toEqual([[LSREGISTER, "-u", join(run.applications, staging, "old.app")]]);
    expect(readdirSync(run.applications)).toEqual(["Bytezard Lead.app"]);
  });

  it("keeps the old App when the download does not match the manifest", async () => {
    const run = setup({ manifestOverrides: { sha: "f".repeat(64) } });
    await run.updater.check();
    await run.updater.apply();
    expect(run.relaunches).toBe(0);
    expect(appVersion(run.app)).toBe("1.0.0");
    expect(run.updater.status()).toMatchObject({ state: "failed", version: "1.1.0", code: "checksum_mismatch" });
    expect(run.commands).toEqual([]);
  });

  it("keeps the old App when the App in the dmg is not the advertised version", async () => {
    const run = setup({ dmgVersion: "1.0.5" });
    await run.updater.check();
    await run.updater.apply();
    expect(run.relaunches).toBe(0);
    expect(appVersion(run.app)).toBe("1.0.0");
    expect(run.updater.status()).toMatchObject({ state: "failed", code: "app_invalid" });
    const staging = readdirSync(run.applications).filter((name) => name.startsWith(UPDATE_STAGING_PREFIX));
    expect(readdirSync(join(run.applications, staging[0]!))).toEqual([]);
  });

  it("puts the old App back when the new one cannot take its place", async () => {
    const run = setup({ failRename: true });
    await run.updater.check();
    await run.updater.apply();
    expect(run.relaunches).toBe(0);
    expect(appVersion(run.app)).toBe("1.0.0");
    expect(run.updater.status()).toMatchObject({ state: "failed", code: "replace_failed" });
  });

  it("lets the user put a failed update away until tomorrow", async () => {
    const run = setup({ manifestOverrides: { sha: "f".repeat(64) } });
    await run.updater.check();
    await run.updater.apply();
    expect(run.updater.status()).toMatchObject({ state: "failed" });
    run.updater.dismiss();
    expect(run.updater.status()).toEqual({ state: "none" });
  });

  it("does not update a copy that is not an installed App", async () => {
    const run = setup({ appBundle: null });
    await run.updater.check();
    await run.updater.apply();
    expect(run.relaunches).toBe(0);
    expect(run.updater.status()).toMatchObject({ state: "failed", code: "not_writable" });
  });

  it("forgets the offer once this App is that version", async () => {
    const before = setup({ latest: "1.1.0" });
    await before.updater.check();
    const readAvailable = () => (JSON.parse(readFileSync(join(before.shellUserData, "update-state.json"), "utf8")) as { available: unknown }).available;
    expect(readAvailable()).toMatchObject({ version: "1.1.0" });
    const after = setup({ current: "1.1.0", shellUserData: before.shellUserData });
    expect(after.updater.status()).toEqual({ state: "none" });
    await after.updater.cleanup();
    expect(readAvailable()).toBeNull();
  });
});

const log = (run: Setup) => readFileSync(join(run.shellUserData, "update.log"), "utf8");
const stagingFolders = (run: Setup) => readdirSync(run.applications).filter((name) => name.startsWith(UPDATE_STAGING_PREFIX));

// 2026-11-10：1.1.3 的 App 在 1.1.6 是最新版时查过一次，记下了 1.1.6。1.2.0 发布以后点「更新」，它照旧请求
// releases/latest/download/bytezard-lead-1.1.6-arm64.dmg：GitHub 把它转到 v1.2.0 的 release，那里没有这个文件，回 404。
// 重试不重新检查，所以一直 404。
describe("an App that remembers an older release than the latest", () => {
  it("still reads the feed old Apps read, and pins the dmg to the release of its version", () => {
    const base = `https://github.com/${REPO}/releases/latest/download`;
    expect(dmgDownloadUrl(base, "1.1.6", dmgFileName("1.1.6"))).toBe(`https://github.com/${REPO}/releases/download/v1.1.6/bytezard-lead-1.1.6-arm64.dmg`);
    // 本机验证用的目录没有 release 之分。
    expect(dmgDownloadUrl("http://127.0.0.1:8765/updates", "1.1.6", dmgFileName("1.1.6"))).toBe("http://127.0.0.1:8765/updates/bytezard-lead-1.1.6-arm64.dmg");
  });

  it("downloads the remembered version from its own release after a newer release came out", async () => {
    const run = setup({ current: "1.1.3", latest: "1.1.6" });
    await run.updater.check();
    expect(run.updater.status()).toMatchObject({ state: "available", version: "1.1.6" });
    run.github.latest = "1.2.0";
    await run.updater.apply();
    expect(run.urls.filter((url) => url.endsWith(".dmg"))).toEqual([`https://github.com/${REPO}/releases/download/v1.1.6/${dmgFileName("1.1.6")}`]);
    expect(run.relaunches).toBe(1);
    expect(appVersion(run.app)).toBe("1.1.6");
  });

  it("checks the manifest again before it updates when the last check is old, and installs the newest version", async () => {
    const run = setup({ current: "1.1.3", latest: "1.1.6" });
    await run.updater.check();
    run.github.latest = "1.2.0";
    run.clock.now = new Date(run.clock.now.getTime() + 3_600_000);
    await run.updater.apply();
    expect(run.urls.at(-1)).toBe(`https://github.com/${REPO}/releases/download/v1.2.0/${dmgFileName("1.2.0")}`);
    expect(appVersion(run.app)).toBe("1.2.0");
  });

  it("checks the manifest again after HTTP 404 and installs the version it finds", async () => {
    const run = setup({ current: "1.1.3", latest: "1.1.6", missing: ["1.1.6"] });
    await run.updater.check();
    run.github.latest = "1.2.0";
    await run.updater.apply();
    expect(run.urls.slice(1)).toEqual([
      `https://github.com/${REPO}/releases/download/v1.1.6/${dmgFileName("1.1.6")}`,
      `https://github.com/${REPO}/releases/latest/download/manifest.json`,
      `https://github.com/${REPO}/releases/download/v1.2.0/${dmgFileName("1.2.0")}`,
    ]);
    expect(run.sleeps).toEqual([]);
    expect(appVersion(run.app)).toBe("1.2.0");
    expect(log(run)).toContain("the dmg of 1.1.6 is not on the server (HTTP 404); checked again: latest 1.2.0");
  });

  it("reports HTTP 404 without retrying when the manifest still names the missing version", async () => {
    const run = setup({ current: "1.1.3", latest: "1.1.6", missing: ["1.1.6"] });
    await run.updater.check();
    await run.updater.apply();
    expect(run.sleeps).toEqual([]);
    expect(run.relaunches).toBe(0);
    expect(run.updater.status()).toEqual({ state: "failed", version: "1.1.6", code: "download_failed", detail: "HTTP 404" });
  });
});

describe("downloading the dmg", () => {
  it("resumes where the connection broke, after a short wait", async () => {
    const run = setup({ serveDmg: ({ attempt }) => (attempt === 0 ? new Response(breakingBody("dmg ")) : null) });
    await run.updater.check();
    await run.updater.apply();
    expect(run.ranges).toEqual([undefined, "bytes=4-"]);
    expect(run.sleeps).toEqual([DOWNLOAD_RETRY_DELAYS_MS[0]]);
    expect(run.relaunches).toBe(1);
    expect(appVersion(run.app)).toBe("1.1.0");
    expect(log(run)).toContain("resuming the download of 1.1.0 at 4 of 9 bytes");
  });

  it("retries a network error 3 times, waiting longer each time, then shows the reason", async () => {
    const run = setup({ serveDmg: () => new Response(breakingBody("dmg ")) });
    await run.updater.check();
    await run.updater.apply();
    expect(run.ranges).toHaveLength(4);
    expect(run.sleeps).toEqual([...DOWNLOAD_RETRY_DELAYS_MS]);
    expect(DOWNLOAD_RETRY_DELAYS_MS).toHaveLength(3);
    expect(DOWNLOAD_RETRY_DELAYS_MS[1]).toBeGreaterThan(DOWNLOAD_RETRY_DELAYS_MS[0]);
    expect(DOWNLOAD_RETRY_DELAYS_MS[2]).toBeGreaterThan(DOWNLOAD_RETRY_DELAYS_MS[1]);
    expect(run.updater.status()).toEqual({ state: "failed", version: "1.1.0", code: "download_failed", detail: "net::ERR_CONNECTION_RESET" });
    expect(run.relaunches).toBe(0);
  });

  it("resumes the download when the user tries again, also after the App was opened again", async () => {
    let broken = true;
    const first = setup({ serveDmg: () => (broken ? new Response(breakingBody("dmg ")) : null) });
    await first.updater.check();
    await first.updater.apply();
    expect(first.updater.status()).toMatchObject({ state: "failed" });
    broken = false;
    // App 重开：cleanup 留着还要装的版本的 .partial。
    const again = setup({ shellUserData: first.shellUserData });
    await again.updater.cleanup();
    expect(readdirSync(join(first.shellUserData, "updates"))).toEqual([`${dmgFileName("1.1.0")}.partial`]);
    await again.updater.apply();
    expect(again.ranges).toEqual(["bytes=4-"]);
    expect(again.relaunches).toBe(1);
  });

  it("starts over when the server ignores the range", async () => {
    const run = setup({
      serveDmg: ({ attempt }, github) => (attempt === 0 ? new Response(breakingBody("dmg ")) : github({ url: `https://github.com/${REPO}/releases/download/v1.1.0/${dmgFileName("1.1.0")}`, range: undefined, attempt })),
    });
    await run.updater.check();
    await run.updater.apply();
    expect(run.ranges).toEqual([undefined, "bytes=4-"]);
    expect(run.relaunches).toBe(1);
  });

  it("starts over when the server answers a range that does not start where the file ends", async () => {
    const run = setup({
      serveDmg: ({ attempt }) => {
        if (attempt === 0) return new Response(breakingBody("dmg "));
        if (attempt === 1) return new Response("bytes", { status: 206, headers: { "Content-Range": "bytes 0-4/9" } });
        return null;
      },
    });
    await run.updater.check();
    await run.updater.apply();
    expect(run.ranges).toEqual([undefined, "bytes=4-", undefined]);
    expect(run.relaunches).toBe(1);
  });

  it("retries a server error but not a missing file", async () => {
    const run = setup({ serveDmg: ({ attempt }) => (attempt === 0 ? new Response("", { status: 503 }) : null) });
    await run.updater.check();
    await run.updater.apply();
    expect(run.sleeps).toEqual([DOWNLOAD_RETRY_DELAYS_MS[0]]);
    expect(run.relaunches).toBe(1);
  });

  it("stops a download that gets no data for 60 seconds, resumes it, and shows stalled when it never moves", async () => {
    expect(DOWNLOAD_STALL_MS).toBe(60_000);
    const run = setup({ stallMs: 20, serveDmg: ({ attempt }) => (attempt === 0 ? new Response(stallingBody("dmg ")) : null) });
    await run.updater.check();
    await run.updater.apply();
    expect(run.ranges).toEqual([undefined, "bytes=4-"]);
    expect(run.relaunches).toBe(1);

    const stuck = setup({ stallMs: 20, serveDmg: () => new Response(stallingBody("dmg ")) });
    await stuck.updater.check();
    await stuck.updater.apply();
    expect(stuck.ranges).toHaveLength(4);
    expect(stuck.updater.status()).toEqual({ state: "failed", version: "1.1.0", code: "download_failed", detail: "stalled: no data for 20 ms" });
    expect(log(stuck)).toContain("download of 1.1.0 stopped (stalled: no data for 20 ms); retry 1 of 3 in 2 s");
  });

  it("also stops a request that never answers", async () => {
    const run = setup({ stallMs: 20, serveDmg: () => new Promise<Response>(() => {}) });
    await run.updater.check();
    await run.updater.apply();
    expect(run.updater.status()).toMatchObject({ state: "failed", code: "download_failed", detail: "stalled: no data for 20 ms" });
  });

  it("throws away a damaged download so the next try starts over", async () => {
    const run = setup({ manifestOverrides: { sha: "f".repeat(64) } });
    await run.updater.check();
    await run.updater.apply();
    expect(run.updater.status()).toMatchObject({ state: "failed", code: "checksum_mismatch" });
    expect(readdirSync(join(run.shellUserData, "updates"))).toEqual([]);
  });
});

// 2026-11-06：从 1.1.3 升 1.1.4 先 app_invalid，重试报 replace_failed: ENOTEMPTY，留下了
// /Applications/.bytezard-lead-update-<pid>/new.app。1.1.3 每次更新都用 .bytezard-lead-update-<pid>，删不掉就更新不了。
describe("staging folders left by a failed update", () => {
  it("removes them before it updates", async () => {
    const run = setup();
    const leftover = join(run.applications, `${UPDATE_STAGING_PREFIX}74539`);
    writeApp(join(leftover, "new.app"), "1.0.5");
    await run.updater.check();
    await run.updater.apply();
    expect(existsSync(leftover)).toBe(false);
    expect(run.commands).toContainEqual([LSREGISTER, "-u", join(leftover, "new.app")]);
    expect(run.relaunches).toBe(1);
  });

  it("updates in a new staging folder when a leftover cannot be removed", async () => {
    const run = setup();
    // 和 1.1.3 会再用的是同一个名字。里面的文件删不掉（目录只读）。
    const leftover = join(run.applications, `${UPDATE_STAGING_PREFIX}${process.pid}`);
    writeApp(join(leftover, "new.app"), "1.0.5");
    chmodSync(leftover, 0o555);
    try {
      await run.updater.check();
      await run.updater.apply();
      expect(run.relaunches).toBe(1);
      expect(appVersion(run.app)).toBe("1.1.0");
      expect(log(run)).toContain(`could not remove ${leftover}`);
      expect(stagingFolders(run)).toHaveLength(2);
    } finally {
      chmodSync(leftover, 0o755);
    }
  });

  it("uses a new staging folder each time the user tries again", async () => {
    const run = setup({ dmgVersion: "1.0.5" });
    await run.updater.check();
    await run.updater.apply();
    const first = stagingFolders(run);
    await run.updater.apply();
    const second = stagingFolders(run);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
  });
});
