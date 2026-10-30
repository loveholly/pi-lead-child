// Lead 自带的 skill genui-cards（2026-10-20 用户决定）：讲怎样组合 render_ui 的组件。
// 设计规范在 docs/genui-design.md。这里守三件事：pi 真的能找到它、它和组件目录对得上、render_ui 的描述指向它。
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_COMPONENT_TYPES } from "@pi-lead-child/protocol";
import { openDb } from "@pi-lead-child/store";
import { LEAD_SKILLS_DIR } from "../src/session.js";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

const SKILL = join(LEAD_SKILLS_DIR, "genui-cards", "SKILL.md");

// 确认卡（连接、记忆切换、常设指令）各自的用法写在 Lead 的系统提示词里，skill 不讲。
const PROMPT_ONLY = new Set(["ConnectionConnect", "ConnectionConfirm", "MemorySwitchConfirm", "StandingOrderChangeConfirm"]);

describe("genui-cards skill", () => {
  it("is found by pi's resource loader the way the Lead session configures it", async () => {
    const dir = tempDir("plc-genui-skill-");
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, additionalSkillPaths: [LEAD_SKILLS_DIR] });
    await loader.reload();
    const skill = loader.getSkills().skills.find((entry) => entry.name === "genui-cards");
    expect(skill?.filePath).toBe(SKILL);
    expect(skill?.description).toMatch(/render_ui/);
    expect(skill?.disableModelInvocation).toBe(false);
  });

  it("covers every layout and information component in the catalog", () => {
    const text = readFileSync(SKILL, "utf8");
    const missing = UI_COMPONENT_TYPES.filter((type) => !PROMPT_ONLY.has(type) && !text.includes(type));
    expect(missing).toEqual([]);
  });

  it("is what render_ui tells Lead to read before drawing a card", () => {
    const dir = tempDir("plc-genui-skill-tool-");
    const db = openDb(join(dir, "plc.db"));
    const tool = createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps)
      .find((candidate: any) => candidate.name === "render_ui") as any;
    expect(tool.description).toContain("画卡之前先读 skill genui-cards");
    db.close();
  });
});
