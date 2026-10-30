// 代查的作用域检查（slack-takeover spec D5）：路径、禁止名单、候选仓库、git 的远端和 HEAD。
import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import {
  deniedSegment, headSha, isDeniedName, listLookupCandidates, parseGithubRemote, readScopedFile, resolveScopedPath,
} from "../src/lookup/index.js";

function fakeRepo(root: string, remote: string | null, head = "a".repeat(40)): void {
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), `${head}\n`);
  writeFileSync(join(root, ".git", "config"), remote
    ? `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/thing.git\n[remote "origin"]\n\turl = ${remote}\n`
    : "[core]\n\tbare = false\n");
}

describe("lookup deny list", () => {
  it("denies env files, keys and credentials but keeps the example env files", () => {
    for (const name of [".env", ".env.local", ".ENV.production", "server.pem", "tls.key", "cert.p12", "a.pfx",
      "id_rsa", "id_ed25519", "id_ecdsa", "credentials", "credentials.json", "secrets.yaml"]) {
      expect(isDeniedName(name), name).toBe(true);
    }
    for (const name of [".env.example", ".env.sample", ".env.template", "env.ts", "keys.md", "secret.ts", "README.md"]) {
      expect(isDeniedName(name), name).toBe(false);
    }
    expect(deniedSegment("config/.env")).toBe(".env");
    expect(deniedSegment(".git/config")).toBe(".git");
    expect(deniedSegment("src/index.ts")).toBeNull();
  });
});

describe("resolveScopedPath", () => {
  const setup = () => {
    const base = tempDir("plc-lookup-scope-");
    const root = join(base, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const answer = 42;\n");
    writeFileSync(join(root, ".env"), "TOKEN=hunter2\n");
    writeFileSync(join(root, ".env.example"), "TOKEN=\n");
    writeFileSync(join(base, "outside.txt"), "outside\n");
    fakeRepo(root, "https://github.com/acme/widgets.git");
    return { base, root };
  };

  it("resolves a relative path inside the repository", () => {
    const { root } = setup();
    const resolved = resolveScopedPath(root, "./src//index.ts");
    expect(resolved).toMatchObject({ ok: true, relative: "src/index.ts" });
    if (!resolved.ok) throw new Error("expected ok");
    expect(readScopedFile(resolved, 1_000)).toMatchObject({ ok: true, text: "export const answer = 42;\n" });
  });

  it("refuses absolute paths, .. escapes, symlink escapes, .env and .git", () => {
    const { base, root } = setup();
    symlinkSync(join(base, "outside.txt"), join(root, "src", "escape.txt"));
    symlinkSync(join(root, ".env"), join(root, "src", "config.txt"));
    expect(resolveScopedPath(root, join(base, "outside.txt"))).toMatchObject({ ok: false });
    expect(resolveScopedPath(root, "../outside.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("..") });
    expect(resolveScopedPath(root, "src/../../outside.txt")).toMatchObject({ ok: false });
    expect(resolveScopedPath(root, "src/escape.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("仓库外面") });
    expect(resolveScopedPath(root, ".env")).toMatchObject({ ok: false, reason: expect.stringContaining("禁止名单") });
    expect(resolveScopedPath(root, "src/config.txt")).toMatchObject({ ok: false, reason: expect.stringContaining("禁止名单") });
    expect(resolveScopedPath(root, ".git/config")).toMatchObject({ ok: false });
    expect(resolveScopedPath(root, "~/x")).toMatchObject({ ok: false });
    expect(resolveScopedPath(root, ".env.example")).toMatchObject({ ok: true, relative: ".env.example" });
  });
});

describe("git helpers", () => {
  it("parses GitHub remotes in their three spellings and drops credentials", () => {
    expect(parseGithubRemote("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGithubRemote("https://github.com/acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGithubRemote("https://x-access-token:abc@github.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGithubRemote("ssh://git@github.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGithubRemote("https://gitlab.com/acme/widgets.git")).toBeNull();
  });

  it("reads HEAD through a loose ref", () => {
    const root = join(tempDir("plc-lookup-head-"), "repo");
    mkdirSync(root, { recursive: true });
    fakeRepo(root, null, "b".repeat(40));
    expect(headSha(root)).toBe("b".repeat(40));
  });
});

describe("listLookupCandidates", () => {
  it("lists project repositories and git repositories two levels under the roots, without duplicates", () => {
    const base = tempDir("plc-lookup-candidates-");
    const workspace = join(base, "Workspace");
    const direct = join(workspace, "widgets");
    const nested = join(workspace, "team", "gadgets");
    const tooDeep = join(workspace, "a", "b", "deep");
    const plain = join(workspace, "notes");
    for (const dir of [direct, nested, tooDeep, plain, join(workspace, "node_modules", "dep"), join(workspace, ".hidden", "x")]) {
      mkdirSync(dir, { recursive: true });
    }
    fakeRepo(direct, "git@github.com:acme/widgets.git");
    fakeRepo(nested, null);
    fakeRepo(tooDeep, "git@github.com:acme/deep.git");
    fakeRepo(join(workspace, "node_modules", "dep"), "git@github.com:acme/dep.git");
    // worktree：.git 是一个文件，远端在公共目录的 config 里。
    const worktree = join(workspace, "widgets-wt");
    mkdirSync(join(direct, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(direct, ".git", "worktrees", "wt", "commondir"), "../..\n");
    writeFileSync(join(direct, ".git", "worktrees", "wt", "HEAD"), `${"c".repeat(40)}\n`);
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(direct, ".git", "worktrees", "wt")}\n`);

    const db = openDb(join(base, "plc.db"));
    db.prepare("INSERT INTO projects (name, slug, created_by) VALUES ('Widgets', 'widgets', 'user')").run();
    const projectId = (db.prepare("SELECT id FROM projects").get() as { id: number }).id;
    db.prepare("INSERT INTO project_repositories (project_id, repo_root, remote_url, repo_name, role) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, direct, "https://github.com/acme/widgets.git", "widgets", "primary");

    const candidates = listLookupCandidates({ db, roots: [workspace] });
    expect(candidates.map((candidate) => [candidate.repo, candidate.source])).toEqual([
      ["acme/widgets", "project"],
      ["gadgets", "local"],
      ["acme/widgets", "local"],
    ]);
    expect(candidates[0]).toMatchObject({ github: { owner: "acme", repo: "widgets" }, projectId, role: "primary" });
    expect(candidates[2]!.root.endsWith("widgets-wt")).toBe(true);
    expect(headSha(worktree)).toBe("c".repeat(40));
    db.close();
  });
});
