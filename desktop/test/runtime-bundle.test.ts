// 解出 App 带的运行包（设计第 4.2 节第 2 步）：先到 .partial，校验通过才 rename；中途退出不留半个版本；
// 去 quarantine 用 execFile("xattr", ["-dr", "com.apple.quarantine", dir])；current 原子地切换。
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { shellPaths } from "../src/paths.js";
import { execFile as realExecFile, type ExecFile } from "../src/process.js";
import {
  compareVersions, findBundledRuntime, installedVersion, needsUnpack, sharedNodeModulesEntry, unpackRuntime, UnpackError,
} from "../src/runtime-bundle.js";
import { runtimeTarball } from "./fixtures.js";

// 路径里有空格，和真的数据目录一样（~/Library/Application Support/Bytezard Lead）。
function setup() {
  const home = tempDir("plc-desktop-unpack-");
  const paths = shellPaths({ PLC_DATA_DIR: join(home, "Application Support", "Bytezard Lead") });
  const resources = join(home, "Bytezard Lead.app", "Contents", "Resources", "runtime");
  return { paths, resources };
}

// tar 真的跑；xattr、osascript 只记下参数（测试机上的文件没有 quarantine，也不该改测试以外的东西）。
function recordingExec(o: { failXattr?: boolean; iconAnswer?: string } = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const execFile: ExecFile = async (file, args, options) => {
    calls.push({ file, args });
    if (file === "xattr") {
      if (o.failXattr) throw new Error("xattr failed");
      return { stdout: "", stderr: "" };
    }
    if (file === "/usr/bin/osascript") return { stdout: `${o.iconAnswer ?? "ok"}\n`, stderr: "" };
    return realExecFile(file, args, options);
  };
  return { calls, execFile };
}

describe("compareVersions", () => {
  it("orders releases and pre-releases like semver", () => {
    expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.3.0-rc.1", "1.3.0")).toBe(-1);
    expect(compareVersions("1.3.0-rc.2", "1.3.0-rc.10")).toBe(-1);
    expect(compareVersions("1.3.0-alpha", "1.3.0-beta")).toBe(-1);
    expect(compareVersions("1.3.0-rc.1", "1.3.0-rc")).toBe(1);
  });
});

describe("findBundledRuntime", () => {
  it("picks the newest runtime archive and ignores other files", () => {
    const { resources } = setup();
    runtimeTarball(resources, "1.2.0");
    runtimeTarball(resources, "1.3.0");
    writeFileSync(join(resources, "notes.txt"), "x");
    writeFileSync(join(resources, "bytezard-lead-runtime-latest-arm64.tar.gz"), "x");
    expect(findBundledRuntime(resources)).toEqual({ version: "1.3.0", tarball: join(resources, "bytezard-lead-runtime-1.3.0-arm64.tar.gz") });
  });

  it("is null without a runtime folder", () => {
    expect(findBundledRuntime(join(tempDir("plc-desktop-none-"), "missing"))).toBeNull();
  });
});

describe("needsUnpack", () => {
  it("unpacks only when nothing is installed or the bundled runtime is newer", () => {
    const bundled = { version: "1.3.0", tarball: "/x" };
    expect(needsUnpack(bundled, null)).toBe(true);
    expect(needsUnpack(bundled, "1.2.0")).toBe(true);
    expect(needsUnpack(bundled, "1.3.0")).toBe(false);
    expect(needsUnpack(bundled, "1.4.0")).toBe(false);
    expect(needsUnpack(null, null)).toBe(false);
  });
});

describe("unpackRuntime", () => {
  it("unpacks through a .partial folder, removes quarantine without a shell, and points current at the new version", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.3.0");
    const exec = recordingExec();
    await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: exec.execFile });

    const target = join(paths.versionsDir, "1.3.0");
    expect(existsSync(join(target, "bin", "lead-agent"))).toBe(true);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(lstatSync(paths.current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(paths.current)).toBe(join("versions", "1.3.0"));
    expect(installedVersion(paths)).toBe("1.3.0");
    expect(exec.calls).toContainEqual({ file: "xattr", args: ["-dr", "com.apple.quarantine", `${target}.partial`] });
    // tar 也只收参数数组：带空格的路径原样是一个参数。先只读 release.json；这个包没有 components，整个解。
    const tarball = join(resources, "bytezard-lead-runtime-1.3.0-arm64.tar.gz");
    expect(exec.calls[0]).toEqual({ file: "/usr/bin/tar", args: ["-xzqf", tarball, "-C", `${target}.partial`, "./release.json"] });
    expect(exec.calls[1]).toEqual({ file: "/usr/bin/tar", args: ["-xzf", tarball, "-C", `${target}.partial`] });
    // 安装根里只有 versions 和 current，没有留下临时的软链接。
    expect(readdirSync(paths.installRoot).sort()).toEqual(["current", "versions"]);
  });

  it("refuses a runtime whose files do not match release.json and leaves no half version", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.2.0");
    await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: recordingExec().execFile });
    const corrupt = join(tempDir("plc-desktop-corrupt-"), "runtime");
    runtimeTarball(corrupt, "1.3.0", { corrupt: true });

    const error = await unpackRuntime({ bundled: findBundledRuntime(corrupt)!, paths, execFile: recordingExec().execFile }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnpackError);
    expect((error as UnpackError).code).toBe("runtime_invalid");
    expect((error as UnpackError).message).toContain("bin/lead-agent (hash does not match)");
    expect(readdirSync(paths.versionsDir)).toEqual(["1.2.0"]);
    expect(installedVersion(paths)).toBe("1.2.0");
  });

  it("refuses a runtime for another architecture", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.3.0", { arch: "x64" });
    const error = await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: recordingExec().execFile }).catch((e: unknown) => e);
    expect((error as UnpackError).code).toBe("runtime_invalid");
    expect(existsSync(paths.versionsDir) ? readdirSync(paths.versionsDir) : []).toEqual([]);
  });

  it("starts again from the archive when an earlier start quit in the middle", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.3.0");
    // 上一次在解包中途退出：留下了半个 .partial。
    const partial = join(paths.versionsDir, "1.3.0.partial");
    mkdirSync(join(partial, "bin"), { recursive: true });
    writeFileSync(join(partial, "half-written"), "x");

    await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: recordingExec().execFile });
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(join(paths.versionsDir, "1.3.0", "half-written"))).toBe(false);
    expect(installedVersion(paths)).toBe("1.3.0");
  });

  it("removes the .partial folder when a step after the unpack fails", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.3.0");
    const error = await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: recordingExec({ failXattr: true }).execFile }).catch((e: unknown) => e);
    expect((error as UnpackError).code).toBe("unpack_failed");
    expect(readdirSync(paths.versionsDir)).toEqual([]);
    expect(installedVersion(paths)).toBeNull();
  });

  it("switches current from the old version to the new one and keeps the old version", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.2.0");
    await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: recordingExec().execFile });
    const newer = join(tempDir("plc-desktop-newer-"), "runtime");
    runtimeTarball(newer, "1.3.0");
    await unpackRuntime({ bundled: findBundledRuntime(newer)!, paths, execFile: recordingExec().execFile });
    expect(readdirSync(paths.versionsDir).sort()).toEqual(["1.2.0", "1.3.0"]);
    expect(installedVersion(paths)).toBe("1.3.0");
  });

  it("re-uses an unpacked version that is whole instead of unpacking it again", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.3.0");
    await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: recordingExec().execFile });
    const again = recordingExec();
    await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: again.execFile });
    expect(again.calls).toEqual([]);
    expect(installedVersion(paths)).toBe("1.3.0");
  });
});

// 没变的部分不重写（设计第 7.5.4 节）：node_modules 共用一份，lead-agent 克隆，只解其余的。
// 克隆真的跑 /bin/cp -cR（APFS 的 clonefile），GNU cp 没有 -c，所以只在 macOS 上跑。App 也只有 macOS 版（docs/testing.md）。
describe.runIf(process.platform === "darwin")("unpackRuntime re-uses what did not change", () => {
  const unpack = async (paths: ReturnType<typeof setup>["paths"], dir: string, exec = recordingExec(), o: { switchCurrent?: boolean } = {}) => ({
    exec, result: await unpackRuntime({ bundled: findBundledRuntime(dir)!, paths, execFile: exec.execFile, ...o }),
  });
  const bundle = (version: string, o: Parameters<typeof runtimeTarball>[2]) => {
    const dir = join(tempDir("plc-desktop-bundle-"), "runtime");
    const fixture = runtimeTarball(dir, version, o);
    return { dir, release: JSON.parse(readFileSync(join(fixture.dir, "release.json"), "utf8")) as { components: Record<string, string> } };
  };
  const tarCalls = (exec: ReturnType<typeof recordingExec>) => exec.calls.filter((call) => call.file === "/usr/bin/tar").map((call) => call.args);

  it("puts node_modules into the shared folder and links the version to it", async () => {
    const { paths } = setup();
    const first = bundle("1.2.0", { modules: "a", agent: "node 24" });
    const { result, exec } = await unpack(paths, first.dir);
    expect(result).toEqual({ version: "unpacked", nodeModules: "unpacked", leadAgent: "unpacked", icon: null });
    const entry = sharedNodeModulesEntry(paths.installRoot, first.release.components.node_modules!);
    const link = join(paths.versionsDir, "1.2.0", "node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join("..", "..", "shared", "node_modules", first.release.components.node_modules!, "node_modules"));
    expect(readFileSync(join(link, "pi", "cli.js"), "utf8")).toBe("pi a");
    expect(readlinkSync(join(link, ".bin", "pi"))).toBe("../pi/cli.js");
    // 只解 node_modules 进共用的目录，再解其余的；quarantine 两处都去掉。
    expect(tarCalls(exec)).toContainEqual(["-xzf", findBundledRuntime(first.dir)!.tarball, "-C", `${entry}.partial`, "./node_modules"]);
    expect(exec.calls).toContainEqual({ file: "xattr", args: ["-dr", "com.apple.quarantine", `${entry}.partial`] });
    expect(readdirSync(join(paths.installRoot, "shared", "node_modules"))).toEqual([first.release.components.node_modules]);
  });

  it("only links node_modules and clones lead-agent when they did not change, and unpacks the rest", async () => {
    const { paths } = setup();
    await unpack(paths, bundle("1.2.0", { modules: "a", agent: "node 24" }).dir);
    const next = bundle("1.3.0", { modules: "a", agent: "node 24" });
    const { result, exec } = await unpack(paths, next.dir);
    expect(result).toEqual({ version: "unpacked", nodeModules: "shared", leadAgent: "cloned", icon: null });
    const tarball = findBundledRuntime(next.dir)!.tarball;
    const partial = join(paths.versionsDir, "1.3.0.partial");
    expect(tarCalls(exec)).toEqual([
      ["-xzqf", tarball, "-C", partial, "./release.json"],
      ["-xzf", tarball, "-C", partial, "--exclude", "./node_modules", "--exclude", "./bin/lead-agent"],
    ]);
    const version = join(paths.versionsDir, "1.3.0");
    expect(readFileSync(join(version, "bin", "lead-agent"), "utf8")).toBe("node 24");
    expect(lstatSync(join(version, "bin", "lead-agent")).mode & 0o111).toBe(0o111);
    expect(readlinkSync(join(version, "bin", "node"))).toBe("lead-agent");
    expect(readFileSync(join(version, "apps", "daemon", "dist", "ops.mjs"), "utf8")).toBe("// ops 1.3.0\n");
    expect(readlinkSync(join(version, "node_modules"))).toBe(readlinkSync(join(paths.versionsDir, "1.2.0", "node_modules")));
    expect(installedVersion(paths)).toBe("1.3.0");
  });

  it("unpacks node_modules again into a new shared copy when they changed, and leaves the old copy", async () => {
    const { paths } = setup();
    const old = bundle("1.2.0", { modules: "a", agent: "node 24" });
    await unpack(paths, old.dir);
    const next = bundle("1.3.0", { modules: "b", agent: "node 24" });
    const { result } = await unpack(paths, next.dir);
    expect(result).toMatchObject({ nodeModules: "unpacked", leadAgent: "cloned" });
    expect(readdirSync(join(paths.installRoot, "shared", "node_modules")).sort())
      .toEqual([old.release.components.node_modules, next.release.components.node_modules].sort());
    expect(readFileSync(join(paths.versionsDir, "1.3.0", "node_modules", "pi", "cli.js"), "utf8")).toBe("pi b");
    expect(readFileSync(join(paths.versionsDir, "1.2.0", "node_modules", "pi", "cli.js"), "utf8")).toBe("pi a");
  });

  it("clones node_modules from a version that holds its own copy", async () => {
    const { paths } = setup();
    // 旧版 App 在后台整个解出的版本：node_modules 是版本目录里的真目录（设计第 7.5.6 节）。
    const old = bundle("1.2.0", { modules: "a", agent: "node 24" });
    mkdirSync(join(paths.versionsDir, "1.2.0"), { recursive: true });
    await realExecFile("/usr/bin/tar", ["-xzf", findBundledRuntime(old.dir)!.tarball, "-C", join(paths.versionsDir, "1.2.0")]);
    const { result, exec } = await unpack(paths, bundle("1.3.0", { modules: "a", agent: "node 24" }).dir);
    expect(result).toMatchObject({ nodeModules: "cloned", leadAgent: "cloned" });
    const entry = sharedNodeModulesEntry(paths.installRoot, old.release.components.node_modules!);
    expect(exec.calls).toContainEqual({ file: "/bin/cp", args: ["-cR", join(paths.versionsDir, "1.2.0", "node_modules"), join(`${entry}.partial`, "node_modules")] });
    expect(readFileSync(join(paths.versionsDir, "1.3.0", "node_modules", "pi", "cli.js"), "utf8")).toBe("pi a");
  });

  it("unpacks everything again when a re-used part does not match release.json", async () => {
    const { paths } = setup();
    const old = bundle("1.2.0", { modules: "a", agent: "node 24" });
    await unpack(paths, old.dir);
    // 共用的那一份坏了。
    const entry = sharedNodeModulesEntry(paths.installRoot, old.release.components.node_modules!);
    writeFileSync(join(entry, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "damaged");
    const { result } = await unpack(paths, bundle("1.3.0", { modules: "a", agent: "node 24" }).dir);
    expect(result).toEqual({ version: "unpacked", nodeModules: "in_version", leadAgent: "unpacked", icon: null });
    expect(lstatSync(join(paths.versionsDir, "1.3.0", "node_modules")).isDirectory()).toBe(true);
    expect(installedVersion(paths)).toBe("1.3.0");
  });

  it("prepares a version without switching current, and the next start only switches", async () => {
    const { paths } = setup();
    await unpack(paths, bundle("1.2.0", { modules: "a", agent: "node 24" }).dir);
    const next = bundle("1.3.0", { modules: "a", agent: "node 24" });
    await unpack(paths, next.dir, recordingExec(), { switchCurrent: false });
    expect(existsSync(join(paths.versionsDir, "1.3.0"))).toBe(true);
    expect(installedVersion(paths)).toBe("1.2.0");

    const { result, exec } = await unpack(paths, next.dir);
    expect(result).toEqual({ version: "reused", nodeModules: null, leadAgent: null, icon: null });
    expect(exec.calls).toEqual([]);
    expect(installedVersion(paths)).toBe("1.3.0");
  });
});

// 「登录项与扩展」里后台项目的图标跟着 bin/lead-agent 走：不设时是通用的 exec 图标（用户 2026-11-05 实测）。
describe("unpackRuntime sets the App icon on the background program", () => {
  it("sets the icon on bin/lead-agent of the new version, also when the version was unpacked before", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.3.0");
    const icon = join(resources, "..", "icon.icns");
    const exec = recordingExec();
    const result = await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: exec.execFile, icon });
    expect(result.icon).toBe("set");
    const call = exec.calls.find((c) => c.file === "/usr/bin/osascript")!;
    // 脚本是固定的，路径从参数传：带空格的路径原样是一个参数。
    expect(call.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(call.args.slice(4)).toEqual([icon, join(paths.versionsDir, "1.3.0", "bin", "lead-agent")]);
    expect(call.args[3]).not.toContain(icon);

    const again = recordingExec();
    expect(await unpackRuntime({ bundled: findBundledRuntime(resources)!, paths, execFile: again.execFile, icon }))
      .toEqual({ version: "reused", nodeModules: null, leadAgent: null, icon: "set" });
  });

  it("still installs the version when the icon cannot be set", async () => {
    const { paths, resources } = setup();
    runtimeTarball(resources, "1.3.0");
    const result = await unpackRuntime({
      bundled: findBundledRuntime(resources)!, paths, execFile: recordingExec({ iconAnswer: "no image" }).execFile, icon: "/missing.icns",
    });
    expect(result).toMatchObject({ icon: "failed", iconError: "osascript: no image" });
    expect(installedVersion(paths)).toBe("1.3.0");
  });
});
