import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../testing/index.js";
import { distDir, findWorkspaceRoot, packageSource, projectRoot, workspaceDir } from "../src/config.js";

describe("projectRoot", () => {
  it("从任意源码深度解析到 monorepo 根，而不是本包的 package.json", () => {
    const root = projectRoot();
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "packages", "core", "package.json"))).toBe(true);
    expect(existsSync(packageSource("daemon", "main.ts"))).toBe(true);
    expect(existsSync(packageSource("cli", "cli.ts"))).toBe(true);
    expect(distDir()).toBe(join(root, "apps", "daemon", "dist"));
  });
});

describe("workspaceDir", () => {
  it("找到 apps/ 和 packages/ 里的每一个工作区包", () => {
    const root = projectRoot();
    for (const group of ["apps", "packages"]) {
      for (const name of readdirSync(join(root, group))) {
        if (!existsSync(join(root, group, name, "package.json"))) continue;
        expect(workspaceDir(name), name).toBe(join(root, group, name));
      }
    }
  });
});

describe("findWorkspaceRoot", () => {
  it("跳过没有 workspaces 的包清单，找到声明 workspaces 的根", () => {
    const top = tempDir("plc-findup-");
    writeFileSync(join(top, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    const pkg = join(top, "packages", "core");
    mkdirSync(join(pkg, "src", "deep"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@x/core" }));
    expect(findWorkspaceRoot(join(pkg, "src", "deep"))).toBe(top);
  });

  it("只有普通 package.json、沿途直到根都没有 workspaces 时抛错", () => {
    const top = tempDir("plc-findup-");
    writeFileSync(join(top, "package.json"), "{}");
    expect(() => findWorkspaceRoot(join(top, "a"))).toThrow("no package.json with workspaces found upward");
  });
});
