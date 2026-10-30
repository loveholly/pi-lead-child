// 归档项目（左栏改版阶段 2，决定 7）：测试项目和不再推进的项目可以归档，项目 tab 底部保留入口，可以恢复。
// 每次改动都记一行 project_changes：谁、为什么、改之前和之后。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "../src/db.js";
import { createProject, getProject, setProjectStatus } from "../src/projects.js";

describe("archiving a project", () => {
  it("archives and restores it, and records each change", () => {
    const db = openDb(join(tempDir("plc-project-status-"), "plc.db"));
    const id = createProject(db, { name: "pi-lead-child-e2e", createdBy: "lead" });

    setProjectStatus(db, id, "archived", { actor: "user", reason: "测试项目，工单都已取消" });
    expect(getProject(db, id)?.status).toBe("archived");
    setProjectStatus(db, id, "active", { actor: "user", reason: "恢复" });
    expect(getProject(db, id)?.status).toBe("active");

    const changes = db.prepare("SELECT actor, reason, before_state, after_state FROM project_changes WHERE project_id = ? ORDER BY id").all(id) as
      { actor: string; reason: string; before_state: string; after_state: string }[];
    expect(changes.map((change) => [change.actor, change.reason, JSON.parse(change.before_state).status, JSON.parse(change.after_state).status]))
      .toEqual([["user", "测试项目，工单都已取消", "active", "archived"], ["user", "恢复", "archived", "active"]]);
  });

  it("refuses a merged project: it lives on in the project it was merged into", () => {
    const db = openDb(join(tempDir("plc-project-status-"), "plc.db"));
    const id = createProject(db, { name: "old", createdBy: "lead" });
    db.prepare("UPDATE projects SET status = 'merged' WHERE id = ?").run(id);
    expect(() => setProjectStatus(db, id, "archived", { actor: "user", reason: "x" })).toThrow();
  });
});
