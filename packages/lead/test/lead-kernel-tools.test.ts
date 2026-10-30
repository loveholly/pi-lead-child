import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { getItem } from "@pi-lead-child/store";
import { findProject, listProjectRepositories } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";

let db: Db;
let deps: LeadDeps;

function tool(name: string) {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  const dir = tempDir("plc-lead-kernel-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir };
});

describe("Lead kernel tools", () => {
  it("creates items through Coordinator project resolution", async () => {
    await tool("create_project").execute("x", { name: "returns", summary: "buyer and seller" });
    await tool("create_task").execute("x", {
      title: "audit", brief: "b", project: "returns", runtime: "codex",
    });
    expect(getItem(db, 1)).toMatchObject({ project: "returns", project_id: 1, requested_runtime: "codex" });
  });

  it("links repositories and transactionally merges logical projects", async () => {
    await tool("create_project").execute("x", { name: "returns-buyer" });
    await tool("create_project").execute("x", { name: "returns" });
    await tool("link_project_repository").execute("x", {
      project: "returns-buyer", repo_root: "/tmp/buyer", repo_name: "buyer", role: "buyer",
    });
    await tool("merge_projects").execute("x", {
      source: "returns-buyer", target: "returns", reason: "same logical product",
    });
    const project = findProject(db, "returns")!;
    expect(listProjectRepositories(db, project.id)).toEqual([
      expect.objectContaining({ repo_name: "buyer", role: "buyer" }),
    ]);
    expect(findProject(db, "returns-buyer")?.id).toBe(project.id);
  });

  it("exposes hierarchy and learning/capability inspection tools", () => {
    const names = createLeadTools(deps).map((candidate: any) => candidate.name);
    expect(names).toEqual(expect.arrayContaining([
      "get_ticket_tree", "list_learning_candidates", "get_capability",
    ]));
  });

  it("rejects a Codex model from another provider before creating a Run", async () => {
    const itemId = createItem(db, { title: "execute", brief: "b", createdBy: "lead" });
    await expect(tool("spawn_child").execute("x", { reason: "测试开跑",
      ticket_id: itemId, runtime: "codex", model: "anthropic/claude-opus",
    })).rejects.toThrow(/runtime 'codex' cannot use model/);
    expect(getItem(db, itemId)?.stage).toBe("ready");
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id=?").get(itemId)).toEqual({ n: 0 });
  });

  it("does not let Lead use the PLC data directory as a child workspace", async () => {
    await expect(tool("create_task").execute("x", {
      title: "unsafe", brief: "b", workdir: deps.dataDir,
    })).rejects.toThrow(/points inside the PLC data directory/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
  });
});
