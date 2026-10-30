import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { tempDir } from "@pi-lead-child/core/testing";
import { restoreItemTree } from "../src/ticket-actions/restore.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-item-restore-"), "plc.db"));
});

function cancelledTree(titles: string[]) {
  const rootId = createItem(db, { title: "Root", brief: "b", createdBy: "lead" });
  const childIds = titles.map((title) => createItem(db, {
    title,
    brief: "b",
    createdBy: "lead",
    parentItemId: rootId,
    rootItemId: rootId,
  }));
  for (const itemId of [...childIds, rootId]) {
    transition(db, { itemId, to: "cancelled", actor: "lead", reason: "stop" });
  }
  return { rootId, childIds };
}

describe("item tree restore", () => {
  it("restores only the root to draft when root_only is selected", () => {
    const { rootId, childIds } = cancelledTree(["A", "B"]);

    const result = restoreItemTree(db, {
      itemId: rootId,
      mode: "root_only",
      requestedBy: "user via test",
    });

    expect(result.restoredItemIds).toEqual([rootId]);
    expect(result.retainedCancelledIds).toEqual(childIds);
    expect(getItem(db, rootId)!.stage).toBe("draft");
    expect(childIds.map((id) => getItem(db, id)!.stage)).toEqual(["cancelled", "cancelled"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });

  it("reviews the tree, restores the earliest duplicate, and keeps raw ids", () => {
    const { rootId, childIds } = cancelledTree(["Phase -1", "Phase -1", "Implement"]);

    const result = restoreItemTree(db, {
      itemId: rootId,
      mode: "review_tree",
      requestedBy: "user via test",
    });

    expect(result.duplicateGroups).toEqual([[childIds[0], childIds[1]]]);
    expect(result.restoredItemIds).toEqual([rootId, childIds[0], childIds[2]]);
    expect(result.retainedCancelledIds).toEqual([childIds[1]]);
    expect(getItem(db, rootId)!.stage).toBe("ready");
    expect(childIds.map((id) => getItem(db, id)!.stage)).toEqual(["ready", "cancelled", "ready"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });

  it("adds dependency closure when selected children are restored", () => {
    const { rootId, childIds } = cancelledTree(["Foundation", "Feature"]);
    db.prepare(
      "INSERT INTO item_plan_revisions (parent_item_id, revision, state) VALUES (?, 1, 'sealed')",
    ).run(rootId);
    db.prepare(
      `INSERT INTO item_dependencies
        (parent_item_id, plan_revision, item_id, depends_on_item_id, kind)
       VALUES (?, 1, ?, ?, 'blocks')`,
    ).run(rootId, childIds[1], childIds[0]);

    const result = restoreItemTree(db, {
      itemId: rootId,
      mode: "selected_children",
      childItemIds: [childIds[1]!],
      requestedBy: "user via test",
    });

    expect(result.restoredItemIds).toEqual([rootId, childIds[0], childIds[1]]);
    expect(childIds.map((id) => getItem(db, id)!.stage)).toEqual(["ready", "ready"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });

  it("continues a tree restore after the root was already restored to draft", () => {
    const { rootId, childIds } = cancelledTree(["Phase -1", "Implement"]);
    restoreItemTree(db, {
      itemId: rootId,
      mode: "root_only",
      requestedBy: "user via test",
    });
    expect(getItem(db, rootId)!.stage).toBe("draft");

    const result = restoreItemTree(db, {
      itemId: rootId,
      mode: "review_tree",
      requestedBy: "user via test",
    });

    expect(result.restoredItemIds).toEqual([rootId, ...childIds]);
    expect(getItem(db, rootId)!.stage).toBe("ready");
    expect(childIds.map((id) => getItem(db, id)!.stage)).toEqual(["ready", "ready"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });
});
