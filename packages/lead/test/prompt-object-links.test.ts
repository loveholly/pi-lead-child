// Object links (design spec P14.7) are written into chat replies as plain Markdown links: [#165](plc:ticket/165).
// The App renders anything inside backticks as inline code, so a link wrapped in backticks shows as a grey,
// unclickable chip. Some models copy the prompt's example formatting literally, so the examples the model
// reads (system prompt and Lead skills) must show the links bare, never inside backticks or code fences.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { LEAD_SKILLS_DIR } from "../src/session.js";

const OBJECT_LINK = /\[[^\]\n]*\]\(plc:[a-z]+\/[^)\s]*\)/g;

// Returns every object link that sits inside an inline code span or a fenced code block.
function linksInsideCode(text: string): string[] {
  const found: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      found.push(...(line.match(OBJECT_LINK) ?? []));
      continue;
    }
    for (const span of line.match(/`[^`]*`/g) ?? []) found.push(...(span.match(OBJECT_LINK) ?? []));
  }
  return found;
}

describe("object link examples the Lead model reads", () => {
  it("keeps the ticket and card examples in the system prompt as bare links", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("[#165](plc:ticket/165)");
    expect(LEAD_SYSTEM_PROMPT).toContain("[#165 升级 Node](plc:ticket/165)");
    expect(LEAD_SYSTEM_PROMPT).toContain("[Ethan 的私信](plc:card/134)");
    expect(linksInsideCode(LEAD_SYSTEM_PROMPT)).toEqual([]);
  });

  it("tells the model not to wrap an object link in backticks", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("不要套反引号或代码块");
  });

  it("never shows an object link inside code in a Lead skill", () => {
    for (const name of readdirSync(LEAD_SKILLS_DIR)) {
      const text = readFileSync(join(LEAD_SKILLS_DIR, name, "SKILL.md"), "utf8");
      expect({ skill: name, links: linksInsideCode(text) }).toEqual({ skill: name, links: [] });
    }
  });

  it("detects a link wrapped in backticks", () => {
    expect(linksInsideCode("工单：`[#165](plc:ticket/165)`")).toEqual(["[#165](plc:ticket/165)"]);
    expect(linksInsideCode("```\n[Ethan 的私信](plc:card/134)\n```")).toEqual(["[Ethan 的私信](plc:card/134)"]);
    expect(linksInsideCode("工单：[#165](plc:ticket/165)")).toEqual([]);
  });
});
