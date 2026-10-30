import type { Db } from "./db.js";
import type { Item } from "@pi-lead-child/core";

export interface ItemDependency {
  parent_item_id: number;
  plan_revision: number;
  item_id: number;
  depends_on_item_id: number;
  kind: string;
  created_by_run_id: number | null;
  created_at: string;
}

export function listChildren(db: Db, parentItemId: number): Item[] {
  return db.prepare("SELECT * FROM items WHERE parent_item_id = ? ORDER BY id")
    .all(parentItemId) as Item[];
}

export function listDescendants(db: Db, itemId: number): Item[] {
  return db.prepare(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM items WHERE parent_item_id = ?
       UNION ALL
       SELECT t.id FROM items t JOIN descendants d ON t.parent_item_id = d.id
     )
     SELECT t.* FROM items t JOIN descendants d ON d.id = t.id ORDER BY t.id`,
  ).all(itemId) as Item[];
}

export function listDependencies(db: Db, itemId: number): ItemDependency[] {
  return db.prepare(
    `SELECT * FROM item_dependencies WHERE item_id = ?
     ORDER BY parent_item_id, plan_revision, depends_on_item_id`,
  ).all(itemId) as ItemDependency[];
}

export function dependencyWouldCycle(
  db: Db,
  parentItemId: number,
  revision: number,
  itemId: number,
  dependsOnItemId: number,
): boolean {
  const row = db.prepare(
    `WITH RECURSIVE reachable(id) AS (
       SELECT depends_on_item_id FROM item_dependencies
        WHERE parent_item_id = ? AND plan_revision = ? AND item_id = ?
       UNION
       SELECT d.depends_on_item_id
         FROM item_dependencies d JOIN reachable r ON d.item_id = r.id
        WHERE d.parent_item_id = ? AND d.plan_revision = ?
     )
     SELECT 1 FROM reachable WHERE id = ? LIMIT 1`,
  ).get(parentItemId, revision, dependsOnItemId, parentItemId, revision, itemId);
  return Boolean(row);
}
