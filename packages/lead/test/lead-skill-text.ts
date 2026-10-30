// Lead 自带 skill 的全文（2026-10-28 起，某一类任务的做法从系统提示词拆进 skill）。
// 测试按规则所在的位置读：每一轮都要用的在 LEAD_SYSTEM_PROMPT 里，某一类任务的在这里。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAD_SKILLS_DIR } from "../src/session.js";

export function leadSkillText(name: string): string {
  return readFileSync(join(LEAD_SKILLS_DIR, name, "SKILL.md"), "utf8");
}
