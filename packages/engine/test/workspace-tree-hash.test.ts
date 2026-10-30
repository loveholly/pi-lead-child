// 工作区指纹（第二轮 release review N2）：git 仓库按 git 的视角算、不看 HEAD；
// 其他目录有界地遍历，跳过依赖和缓存；算不出来时抛错。
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { workspaceTreeHash } from "../src/pipeline/workspace-tree-hash.js";

function dir(): string {
  const path = tempDir("plc-tree-hash-");
  writeFileSync(join(path, "src.txt"), "v1");
  return path;
}

function repo(): { path: string; git: (...args: string[]) => void } {
  const path = dir();
  writeFileSync(join(path, ".gitignore"), "cache/\n");
  const git = (...args: string[]) => {
    execFileSync("git", ["-C", path, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { path, git };
}

describe("workspace tree hash in a git repository", () => {
  it("changes when a tracked file, a new file or a deletion changes the content", async () => {
    const { path } = repo();
    const clean = await workspaceTreeHash(path);

    writeFileSync(join(path, "src.txt"), "v2");
    const edited = await workspaceTreeHash(path);
    expect(edited).not.toBe(clean);

    writeFileSync(join(path, "new.txt"), "new");
    const added = await workspaceTreeHash(path);
    expect(added).not.toBe(edited);

    unlinkSync(join(path, "new.txt"));
    writeFileSync(join(path, "src.txt"), "v1");
    expect(await workspaceTreeHash(path)).toBe(clean);
  });

  it("does not change when existing changes are committed", async () => {
    const { path, git } = repo();
    writeFileSync(join(path, "src.txt"), "v2");
    writeFileSync(join(path, "new.txt"), "new");
    const dirty = await workspaceTreeHash(path);

    git("add", "-A");
    git("commit", "-q", "-m", "commit what was already there");

    expect(await workspaceTreeHash(path)).toBe(dirty);
  });

  it("ignores files that git ignores", async () => {
    const { path } = repo();
    const before = await workspaceTreeHash(path);
    mkdirSync(join(path, "cache"));
    writeFileSync(join(path, "cache", "result.json"), "{}");

    expect(await workspaceTreeHash(path)).toBe(before);
  });

  // 第三轮 release review F2：共用的工作区就是用户的主 checkout，用户和其他会话在那里提交。
  // 指纹计算不能拿 .git/index.lock（git status 默认会顺手刷新索引并写回），不能写任何东西，
  // 也不能跑 clean filter（git-lfs 的 clean 会把文件存进 .git/lfs/objects）。
  it("never writes to the repository and never runs a clean filter", async () => {
    const { path, git } = repo();
    const marker = join(tempDir("plc-tree-hash-filter-"), "ran");
    // 和 git-lfs 装上的一样：名字叫 lfs、required；这里每跑一次就在 marker 里记一行。
    git("config", "filter.lfs.clean", `sh -c 'echo ran >> "${marker}"; cat'`);
    git("config", "filter.lfs.required", "true");
    writeFileSync(join(path, ".gitattributes"), "*.bin filter=lfs\n");
    writeFileSync(join(path, "blob.bin"), "binary");
    git("add", "-A");
    git("commit", "-q", "-m", "lfs file");
    rmSync(marker, { force: true });
    // 内容不变、mtime 变了：git status 要比内容才知道没改，默认会顺手把新的 stat 写回索引。
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(path, "src.txt"), later, later);
    utimesSync(join(path, "blob.bin"), later, later);
    writeFileSync(join(path, "new.bin"), "new binary");
    const objects = () => readdirSync(join(path, ".git", "objects")).flatMap((dir) =>
      /^[0-9a-f]{2}$/.test(dir) ? readdirSync(join(path, ".git", "objects", dir)) : []).length;
    const index = readFileSync(join(path, ".git", "index"));
    const objectCount = objects();

    await workspaceTreeHash(path);

    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(path, ".git", "index")).equals(index)).toBe(true);
    expect(objects()).toBe(objectCount);
    expect(existsSync(join(path, ".git", "index.lock"))).toBe(false);
  });

  // 第三轮 F6：在仓库里，git 失败就是"算不出来"，不能悄悄改成遍历目录、得出另一个指纹。
  it("fails instead of walking the directory when git fails inside a repository", async () => {
    const { path } = repo();
    writeFileSync(join(path, ".git", "HEAD"), "not a ref\n");

    await expect(workspaceTreeHash(path)).rejects.toThrow();
  });

  it("hashes a symlink the same way before and after it is committed", async () => {
    const { path, git } = repo();
    symlinkSync("src.txt", join(path, "link"));
    const dirty = await workspaceTreeHash(path);
    git("add", "-A");
    git("commit", "-q", "-m", "add link");

    expect(await workspaceTreeHash(path)).toBe(dirty);
  });

  it("sees a change inside a submodule", async () => {
    const sub = repo();
    const { path, git } = repo();
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.path, "sub");
    git("commit", "-q", "-m", "add submodule");
    const clean = await workspaceTreeHash(path);

    writeFileSync(join(path, "sub", "src.txt"), "edited in the submodule");
    const once = await workspaceTreeHash(path);
    expect(once).not.toBe(clean);
    writeFileSync(join(path, "sub", "src.txt"), "edited again");
    expect(await workspaceTreeHash(path)).not.toBe(once);
  });

  it("hashes only the workspace directory inside a larger repository", async () => {
    const { path } = repo();
    mkdirSync(join(path, "pkg"));
    writeFileSync(join(path, "pkg", "a.txt"), "a");
    const before = await workspaceTreeHash(join(path, "pkg"));
    writeFileSync(join(path, "src.txt"), "outside the workspace");

    expect(await workspaceTreeHash(join(path, "pkg"))).toBe(before);
    writeFileSync(join(path, "pkg", "a.txt"), "b");
    expect(await workspaceTreeHash(join(path, "pkg"))).not.toBe(before);
  });
});

describe("workspace tree hash outside git", () => {
  it("changes with the content and skips dependency and cache directories", async () => {
    const path = dir();
    const before = await workspaceTreeHash(path);
    mkdirSync(join(path, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(path, "node_modules", "dep", "index.js"), "x");
    mkdirSync(join(path, ".cache"));
    writeFileSync(join(path, ".cache", "x"), "x");
    expect(await workspaceTreeHash(path)).toBe(before);

    writeFileSync(join(path, "src.txt"), "v2");
    expect(await workspaceTreeHash(path)).not.toBe(before);
  });

  it("checks the byte limit before it reads a file", async () => {
    const path = dir();
    writeFileSync(join(path, "big.txt"), "0123456789");
    chmodSync(join(path, "big.txt"), 0o000);

    await expect(workspaceTreeHash(path, { maxBytes: 5 })).rejects.toThrow(/larger than 5 bytes/);
    chmodSync(join(path, "big.txt"), 0o644);
  });

  it("throws instead of guessing when the directory is missing, too large or too slow", async () => {
    const path = dir();
    writeFileSync(join(path, "b.txt"), "b");
    await expect(workspaceTreeHash(path, { maxFiles: 1 })).rejects.toThrow(/more than 1 files/);
    await expect(workspaceTreeHash(path, { timeoutMs: 0 })).rejects.toThrow(/timed out/);
    rmSync(path, { recursive: true, force: true });
    await expect(workspaceTreeHash(path)).rejects.toThrow();
  });
});
