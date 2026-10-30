// Lead 自带的 skill ticket-planning（2026-10-26）：建单、复用原工单、拆子工单、关联工单怎样判断。
// 起因是 #100/#101、#104、#116、#117：同一个目标被拆成了几张单。这里守三件事：pi 真的能找到它、
// 它讲到了每一种关系、create_task 和 link_tickets 的描述指向它。
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, TICKET_RELATION_STORED_TYPES } from "@pi-lead-child/store";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { LEAD_SKILLS_DIR } from "../src/session.js";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

const SKILL = join(LEAD_SKILLS_DIR, "ticket-planning", "SKILL.md");

describe("ticket-planning skill", () => {
  it("is found by pi's resource loader the way the Lead session configures it", async () => {
    const dir = tempDir("plc-ticket-skill-");
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, additionalSkillPaths: [LEAD_SKILLS_DIR] });
    await loader.reload();
    const skill = loader.getSkills().skills.find((entry) => entry.name === "ticket-planning");
    expect(skill?.filePath).toBe(SKILL);
    expect(skill?.description).toMatch(/create_task/);
    expect(skill?.disableModelInvocation).toBe(false);
  });

  it("names every stored relation type and the parent-child tree", () => {
    const text = readFileSync(SKILL, "utf8");
    const missing = TICKET_RELATION_STORED_TYPES.filter((type) => !text.includes(type));
    expect(missing).toEqual([]);
    expect(text).toContain("parent_ticket_id");
  });

  it("is what create_task, link_tickets and the system prompt tell Lead to read", () => {
    const dir = tempDir("plc-ticket-skill-tool-");
    const db = openDb(join(dir, "plc.db"));
    const tools = createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps) as any[];
    for (const name of ["create_task", "link_tickets"]) {
      expect(tools.find((tool) => tool.name === name)?.description).toContain("skill ticket-planning");
    }
    expect(LEAD_SYSTEM_PROMPT).toContain("skill ticket-planning");
    db.close();
  });
});
