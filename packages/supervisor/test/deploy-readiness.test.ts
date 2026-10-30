// 部署闸门的判断（deploy/readiness.ts）。#89、#92、#93、#95 的 child 在主 checkout 里改代码、构建，随后的重启就把
// 没提交的代码部署上线了。supervisor 的维护入口按这里的判断拒绝（supervisor.test.ts 测入口本身）。
import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { deployReadiness, writeBuildProvenance } from "../src/deploy/readiness.js";

let checkout: string;
let dist: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", checkout, "-c", "user.email=t@example.test", "-c", "user.name=T", ...args], { encoding: "utf8" }).trim();
}

const readiness = () => deployReadiness(checkout, dist);
const reasons = () => readiness().reasons.join("\n");

beforeEach(() => {
  checkout = join(tempDir("plc-deploy-readiness-"), "checkout");
  dist = join(checkout, "apps", "daemon", "dist");
  mkdirSync(join(checkout, "packages", "engine", "src"), { recursive: true });
  mkdirSync(join(checkout, "packages", "engine", "test"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  writeFileSync(join(checkout, ".gitignore"), "dist/\n");
  writeFileSync(join(checkout, "package.json"), "{}\n");
  writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(checkout, "packages", "engine", "test", "index.test.ts"), "// test\n");
  mkdirSync(join(checkout, "artifacts"));
  writeFileSync(join(checkout, "artifacts", "evidence.json"), "{}\n");
  git("add", ".");
  git("commit", "-qm", "base");
  mkdirSync(dist, { recursive: true });
});

describe("deploy readiness", () => {
  it("passes a clean checkout with a clean build of a commit in its history", () => {
    const built = writeBuildProvenance(checkout, dist);
    expect(readiness()).toMatchObject({ ready: true, reasons: [], head: built.commit, build: { commit: built.commit, dirty: false } });
  });

  it("refuses an uncommitted change to code, and names the file", () => {
    writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 2;\n");
    expect(readiness().ready).toBe(false);
    expect(reasons()).toContain("packages/engine/src/index.ts");
  });

  it("counts a new file under packages/ and a change to the root package.json", () => {
    writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "packages", "engine", "src", "new.ts"), "export {};\n");
    expect(reasons()).toContain("packages/engine/src/new.ts");
    git("add", "packages/engine/src/new.ts");
    git("commit", "-qm", "new");
    writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "package.json"), "{\"dependencies\":{}}\n");
    expect(reasons()).toContain("package.json");
  });

  it("does not count notes, test evidence under artifacts/, or test files", () => {
    writeBuildProvenance(checkout, dist);
    mkdirSync(join(checkout, ".scratch"));
    writeFileSync(join(checkout, ".scratch", "notes.md"), "notes\n");
    // 有个测试每次跑都会改写 artifacts/ 里的证据文件。
    writeFileSync(join(checkout, "artifacts", "evidence.json"), "{\"rewritten\":true}\n");
    writeFileSync(join(checkout, "packages", "engine", "test", "index.test.ts"), "// changed test\n");
    writeFileSync(join(checkout, "packages", "engine", "src", "extra.spec.ts"), "// new spec\n");
    expect(readiness()).toMatchObject({ ready: true, reasons: [] });
  });

  it("refuses a dist without a build record, or one built from uncommitted code", () => {
    expect(reasons()).toContain("build-info.json");
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 3;\n");
    writeBuildProvenance(checkout, dist);
    git("checkout", "--", ".");
    expect(reasons()).toContain("不是从一个已提交的 commit 构建的");
  });

  it("refuses a build of a commit that is not in the current branch's history", () => {
    git("checkout", "-qb", "side");
    writeFileSync(join(checkout, "packages", "engine", "src", "index.ts"), "export const x = 4;\n");
    git("commit", "-qam", "side");
    const side = writeBuildProvenance(checkout, dist);
    git("checkout", "-q", "main");
    expect(reasons()).toContain(`${side.commit} 不在主 checkout 当前分支的历史里`);
  });

  it("passes when HEAD moved on after the build: the build is still a committed ancestor", () => {
    const built = writeBuildProvenance(checkout, dist);
    writeFileSync(join(checkout, "README.md"), "later\n");
    git("add", "README.md");
    git("commit", "-qm", "later");
    expect(readiness()).toMatchObject({ ready: true, build: { commit: built.commit } });
  });
});
