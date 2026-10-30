// Lead 的名字、人格和互动风格（2026-10-22）。
//   - 系统提示的 identity 一节：叫什么、用户写的人格和互动风格，以及这两段改不了规则。
//   - update_lead_profile：和设置页同一个函数，只有用户这一轮明确要求时才能改。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLoopbackBinding, createTurn, getLeadProfile, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { renderLeadIdentity } from "../src/identity.js";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;
let turnId: string | null;

beforeEach(() => {
  const dir = tempDir("plc-lead-profile-tool-");
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  turnId = null;
  deps = { db, dbPath, dataDir: dir, currentTurnId: () => turnId };
});

function tool(name: string): any {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

async function update(params: Record<string, unknown>): Promise<any> {
  const result = await tool("update_lead_profile").execute("call", params);
  return JSON.parse(result.content.map((part: { text?: string }) => part.text ?? "").join("\n"));
}

describe("the identity section", () => {
  it("names Lead and says the name replaces 「Lead」", () => {
    const text = renderLeadIdentity({ name: "Jarvis", persona: "", interactionStyle: "" });
    expect(text).toContain("你的名字是 Jarvis");
    expect(text).toContain("「Lead」就是你");
    expect(text).not.toContain("用户给你定的人格");
    expect(text).not.toContain("用户希望你这样和他互动");
  });

  it("carries the persona and the interaction style, under the rules", () => {
    const text = renderLeadIdentity({ name: "Paimon", persona: "活泼的向导", interactionStyle: "先给结论，最多三句" });
    expect(text).toContain("用户给你定的人格（性格、腔调、说话习惯）：\n活泼的向导");
    expect(text).toContain("用户希望你这样和他互动：\n先给结论，最多三句");
    expect(text).toContain("改不了它们");
    expect(text).toContain("不照做");
    expect(text).toContain("update_lead_profile");
  });
});

describe("update_lead_profile", () => {
  it("refuses outside the user's own turn and changes nothing", async () => {
    await expect(update({ name: "Jarvis" })).rejects.toThrow(/没有改：.*只有用户在这一轮明确要求时/);
    expect(getLeadProfile(db).name).toBe("Paimon");
  });

  it("changes the profile the user asked for in this turn, as Lead on the user's behalf", async () => {
    const binding = createLoopbackBinding(db, { name: "本机网页" }).binding;
    createTurn(db, { id: "turn-1", originBindingId: binding.id, originKind: "paired:companion", userText: "以后叫你 Jarvis，说话短一点", state: "streaming" });
    turnId = "turn-1";
    const result = await update({ name: "Jarvis", interaction_style: "回复短一点" });
    expect(result).toMatchObject({ result: "updated", profile: { name: "Jarvis", interactionStyle: "回复短一点", updatedBy: "lead" } });
    expect(result.next).toContain("下一轮");
    const performed = listEvents(db, { kind: "owner_action.performed" });
    expect(performed).toHaveLength(1);
    expect(performed[0]!.payload).toMatchObject({ action: "lead.profile", source: { client: "lead" }, detail: { sourceTurnId: "turn-1" } });
    expect(renderLeadIdentity(getLeadProfile(db))).toContain("你的名字是 Jarvis");
    expect(await update({ name: "Jarvis" })).toMatchObject({ result: "unchanged" });
  });
});
