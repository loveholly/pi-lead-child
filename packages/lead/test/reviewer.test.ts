import { describe, it, expect, beforeEach, vi } from "vitest";
import { join, resolve } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import { buildReviewerPrompt } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;

function tool(name: string) {
  return createLeadTools(deps).find((t: any) => t.name === name) as any;
}

beforeEach(() => {
  const dir = tempDir("plc-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  deps = {
    db, dbPath, dataDir: dir,
    childPi: { piBin: resolve("node_modules/.bin/tsx"), piArgs: [resolve("packages/runtime/testing/fake-pi.ts")] },
  };
});

describe("buildReviewerPrompt", () => {
  it("contains reviewer identity, verification duty, and no-modify rule", () => {
    const p = buildReviewerPrompt({
      id: 5, title: "工具开发", brief: "写工具并自测通过", body: "已完成，测试通过",
    } as any);
    expect(p).toContain("#5");
    expect(p).toContain("独立核查");
    expect(p).toContain("禁止修改");
    expect(p).toContain("独立核查报告");
    // 复核 P1-10：核查报告和结论证据写给用户看，用中文。
    expect(p).toContain("review_verdict 的 evidence 是给用户看的，用中文写");
    // 工单 10：材料在系统拼的核查包里（manager 接在后面），这里不再放 brief 和工单正文（执行 agent 的自述）。
    expect(p).toContain("核查包");
    expect(p).not.toContain("写工具并自测通过");
    expect(p).not.toContain("已完成，测试通过");
    // 逐条结论的格式，和只看结构化字段的 escalate。
    expect(p).toContain("criteria：核查包里的每一条验收标准一项 {id, result, evidence}");
    expect(p).toContain("有一条不通过时总结论只能是 fail");
    expect(p).toContain("系统只看这个字段，不看证据里的字眼");
  });
});

describe("spawn_child role=reviewer", () => {
  it("requires item in review stage", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    await expect(tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: id, role: "reviewer" }))
      .rejects.toThrow(/review/);
  });

  it("runs reviewer on review item; item stays review; run role recorded", async () => {
    const id = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    transition(db, { itemId: id, to: "active", actor: "system", reason: "" });
    transition(db, { itemId: id, to: "review", actor: "child", reason: "" });
    const done = vi.fn();
    deps.onChildDone = done;
    const res = await tool("spawn_child").execute("t", { reason: "测试开跑", ticket_id: id, role: "reviewer" });
    expect(res.content[0].text).toContain("spawned");
    await vi.waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 5000 });
    expect(getItem(db, id)!.stage).toBe("review"); // reviewer 不扭转状态
    expect(getRun(db, 1)!.role).toBe("reviewer");
    expect(getRun(db, 1)!.state).toBe("finished");
  });
});
