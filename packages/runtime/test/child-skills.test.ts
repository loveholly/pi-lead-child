// PLC 内置给执行 agent 的 skill（child-skills.ts，2026-10-28）。这里守三件事：
//   - 内置的每个 skill 都齐：名字等于目录名、带 plc- 前缀（pi 里同名的用户 skill 会顶掉它）、有说明；角色目录是一个
//     Claude Code 插件（plugin.json 的 name 是 plc）。
//   - 解析的边界：缺 name 或 description 的目录不算 skill；带引号的值去掉引号；没有角色目录或 root 为 null 时什么也不送。
//   - 送到 CLI 那一头：仓库依赖的真实 pi 用 adapter 给的参数启动，RPC 的 get_commands 列出了 plc-diagnosing-bugs。
//     Claude Code 和 Codex 不是仓库的依赖，这里只核对参数和提示词（claude-runtime、codex-runtime 的测试）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  childSkills, childSkillsDir, claudeChildSkillArgs, codexChildSkillListing, defaultChildSkillsRoot, piChildSkillArgs,
} from "../src/child-skills.js";

const ROOT = defaultChildSkillsRoot();

function writeSkill(root: string, role: string, dir: string, frontmatter: string): string {
  mkdirSync(join(root, role, "skills", dir), { recursive: true });
  const path = join(root, role, "skills", dir, "SKILL.md");
  writeFileSync(path, `---\n${frontmatter}\n---\n\nBody.\n`);
  return path;
}

describe("PLC's built-in child skills", () => {
  it("are complete: plc- names equal to their directory, a description, and a plugin manifest per role", () => {
    const skills = childSkills(ROOT, "executor");
    expect(skills.map((skill) => skill.name)).toContain("plc-diagnosing-bugs");
    const dirs = readdirSync(join(ROOT, "executor", "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    // 每个目录都解析成一个 skill：漏了 name 或 description 的目录，pi 和 Claude Code 会加载，Codex 的列表里却没有。
    expect(skills.map((skill) => skill.name).sort()).toEqual(dirs.map((entry) => entry.name).sort());
    for (const skill of skills) {
      expect(skill.name).toMatch(/^plc-[a-z0-9-]+$/);
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.path).toBe(join(ROOT, "executor", "skills", skill.name, "SKILL.md"));
    }
    for (const role of readdirSync(ROOT)) {
      const manifest = JSON.parse(readFileSync(join(ROOT, role, ".claude-plugin", "plugin.json"), "utf8"));
      expect(manifest.name, role).toBe("plc");
    }
  });

  it("keeps the MIT notice next to the skill adapted from mattpocock/skills", () => {
    const license = readFileSync(join(ROOT, "executor", "skills", "plc-diagnosing-bugs", "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Matt Pocock");
    expect(readFileSync(join(ROOT, "executor", "skills", "plc-diagnosing-bugs", "SKILL.md"), "utf8"))
      .toContain("改编自 mattpocock/skills 的 diagnosing-bugs");
  });

  it("skips directories without a name or description, and strips quotes", () => {
    const root = tempDir("plc-child-skills-");
    const quoted = writeSkill(root, "executor", "plc-quoted", 'name: "plc-quoted"\ndescription: \'Quoted: with a colon.\'');
    writeSkill(root, "executor", "plc-no-description", "name: plc-no-description");
    writeSkill(root, "executor", "plc-no-name", "description: No name here.");
    expect(childSkills(root, "executor")).toEqual([{ name: "plc-quoted", description: "Quoted: with a colon.", path: quoted }]);
  });

  it("sends nothing for a role without a directory, or when skills are turned off", () => {
    const root = tempDir("plc-child-skills-empty-");
    for (const [base, role] of [[root, "reviewer"], [null, "executor"], [ROOT, "reviewer"]] as const) {
      expect(childSkillsDir(base, role)).toBeNull();
      expect(childSkills(base, role)).toEqual([]);
      expect(piChildSkillArgs(base, role)).toEqual([]);
      expect(claudeChildSkillArgs(base, role)).toEqual([]);
      expect(codexChildSkillListing(base, role)).toBe("");
    }
  });

  it("gives each runtime the same files: pi's skills folder, Claude Code's plugin root, Codex's absolute paths", () => {
    const dir = join(ROOT, "executor");
    expect(piChildSkillArgs(ROOT, "executor")).toEqual(["--skill", join(dir, "skills")]);
    expect(claudeChildSkillArgs(ROOT, "executor")).toEqual(["--plugin-dir", dir]);
    const listing = codexChildSkillListing(ROOT, "executor");
    for (const skill of childSkills(ROOT, "executor")) {
      expect(listing).toContain(`- ${skill.name}：${skill.description}（${skill.path}）`);
      expect(existsSync(skill.path)).toBe(true);
    }
  });

  // 最外面一跳：pi 自己按 adapter 给的参数加载到它。HOME 换成空目录，用户 ~/.agents/skills 里的 skill 不掺进来。
  it("loads into the real pi with the arguments the pi adapter passes", () => {
    const home = tempDir("plc-child-skills-home-");
    const result = spawnSync(resolve("node_modules/.bin/pi"), ["--mode", "rpc", "--no-session", ...piChildSkillArgs(ROOT, "executor")], {
      cwd: home, env: { ...process.env, HOME: home }, input: '{"id":"1","type":"get_commands"}\n', encoding: "utf8", timeout: 60_000,
    });
    const response = result.stdout.split("\n").flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).find((message) => message.command === "get_commands");
    expect(response, result.stderr).toBeDefined();
    const skill = response.data.commands.find((command: { name: string }) => command.name === "skill:plc-diagnosing-bugs");
    expect(skill).toMatchObject({ source: "skill", sourceInfo: { path: join(ROOT, "executor", "skills", "plc-diagnosing-bugs", "SKILL.md") } });
  });
});
