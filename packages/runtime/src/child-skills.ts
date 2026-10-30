// PLC 给执行 agent 内置的 skill（2026-10-28，用户：「有价值的内置到 PLC」，不靠用户系统里装的）。
// 一个角色一个目录（engine 的 src/child-skills/<角色>/），目录本身是一个 Claude Code 插件：.claude-plugin/plugin.json 加 skills/。
// 三种 runtime 各用自己的方式加载同一份文件（2026-10-28 用本机的 CLI 核实，都没有调用模型）：
//   - pi 1.1.0：每次启动加 --skill <skills 目录>（RPC 的 get_commands 能列出它）。用户 ~/.agents/skills 里同名的 skill 会顶掉它，
//     pi 不报错，所以名字都带 plc- 前缀。
//   - Claude Code 2.1.311：每次启动加 --plugin-dir <角色目录>（`claude --plugin-dir <目录> plugin details plc` 能列出它）。
//     插件的 skill 自带 plc: 前缀，不会和用户的撞名。
//   - Codex 0.162.1：没有每次运行加 skill 的参数。它只读工作目录到仓库根之间的 .agents/skills、$CODEX_HOME/skills
//     （文档没写）和 ~/.agents/skills；skills.config 指向别处的 skill 不加载（codex debug prompt-input 核实）。
//     放进工作目录会混进交付，放进 CODEX_HOME 等于装进用户的系统。所以在提示词里列出名字、说明和 SKILL.md 的绝对路径，
//     由它自己读（Codex 的沙箱只限制写，不限制读）。
// 没有某个角色的目录时，这个角色不加载任何 skill。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageSource } from "@pi-lead-child/core";

export type ChildSkillRole = "executor" | "reviewer";

export interface ChildSkill {
  name: string;
  description: string;
  // SKILL.md 的绝对路径。
  path: string;
}

// 所有角色目录的上一级。runtime 的选项可以换成别的目录（测试），null 表示不加载任何 skill。
export function defaultChildSkillsRoot(): string {
  return packageSource("engine", "child-skills");
}

// 一个角色的插件目录。root 为 null，或者这个角色没有目录时返回 null。
export function childSkillsDir(root: string | null, role: ChildSkillRole): string | null {
  if (root === null) return null;
  const dir = join(root, role);
  return existsSync(join(dir, "skills")) ? dir : null;
}

// frontmatter 里单行的 key: value。这些文件是 PLC 自己写的，只用到 name 和 description 两个单行的值。
function frontmatterValue(frontmatter: string, key: string): string | null {
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(frontmatter);
  if (!match) return null;
  const value = match[1]!.trim();
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

// 一个角色的 skill，按名字排序。frontmatter 缺 name 或 description 的目录不算 skill（测试保证内置的都齐）。
export function childSkills(root: string | null, role: ChildSkillRole): ChildSkill[] {
  const dir = childSkillsDir(root, role);
  if (!dir) return [];
  const skillsDir = join(dir, "skills");
  const skills: ChildSkill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const path = join(skillsDir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(path)) continue;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
    const name = frontmatterValue(frontmatter, "name");
    const description = frontmatterValue(frontmatter, "description");
    if (name && description) skills.push({ name, description, path });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// pi 的启动参数：--skill 指向 skills 目录，pi 递归找里面的 SKILL.md。
export function piChildSkillArgs(root: string | null, role: ChildSkillRole): string[] {
  const dir = childSkillsDir(root, role);
  return dir ? ["--skill", join(dir, "skills")] : [];
}

// Claude Code 的启动参数：--plugin-dir 只取一个值，指向角色目录（插件的根）。
export function claudeChildSkillArgs(root: string | null, role: ChildSkillRole): string[] {
  const dir = childSkillsDir(root, role);
  return dir ? ["--plugin-dir", dir] : [];
}

// Codex 的提示词里列出的 skill。没有 skill 时是空串。
export function codexChildSkillListing(root: string | null, role: ChildSkillRole): string {
  const skills = childSkills(root, role);
  if (!skills.length) return "";
  return [
    "## PLC 给你的 skill",
    "下面的 skill 不在你的 skill 列表里。符合说明的情况出现时，先读 SKILL.md 的全文，再照着做。",
    ...skills.map((skill) => `- ${skill.name}：${skill.description}（${skill.path}）`),
  ].join("\n");
}
