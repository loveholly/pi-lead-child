// 恢复一张已经取消的工单（和它下面选中的子任务）。以前在网关（item-restore.ts），只有页面能用；工单操作层的 restore
// （ui-action-parity plan.md P03）要让 Lead 在你这一轮里代你恢复，所以搬到这里，按「谁做的」（ActionAttribution）落笔：
// 你本人是 actor=user；Lead 代你是 actor=lead，带 onBehalfOf=user 和那一轮，权限按你查。
import type { Db } from "@pi-lead-child/store";
import { listDependencies, listDescendants } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { canonicalDuplicateOf, duplicateSourcesFor } from "@pi-lead-child/store";
import { BY_USER, behalfCursor, behalfFields, transitionBy, type ActionAttribution } from "./attribution.js";

export const ITEM_RESTORE_MODES = ["root_only", "review_tree", "selected_children"] as const;
export type ItemRestoreMode = typeof ITEM_RESTORE_MODES[number];

export interface ItemRestorePreview {
  itemId: number;
  descendantIds: number[];
  cancelledDescendantIds: number[];
  suggestedChildIds: number[];
  duplicateGroups: number[][];
}

export interface ItemRestoreResult extends ItemRestorePreview {
  mode: ItemRestoreMode;
  restoredItemIds: number[];
  retainedCancelledIds: number[];
  state: "draft" | "ready";
}

function normalizedTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function previewItemRestore(db: Db, itemId: number): ItemRestorePreview {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item #${itemId} not found`);
  if (item.kind !== "task") throw new Error(`item #${itemId} is not a task`);

  const descendants = listDescendants(db, item.id);
  const candidates = descendants.filter((child) => child.stage === "cancelled");
  const bySiblingTitle = new Map<string, number[]>();
  for (const child of candidates) {
    const key = `${child.parent_item_id ?? item.id}:${normalizedTitle(child.title)}`;
    const ids = bySiblingTitle.get(key) ?? [];
    ids.push(child.id);
    bySiblingTitle.set(key, ids);
  }

  const duplicateGroups = [...bySiblingTitle.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => [...ids].sort((left, right) => left - right));
  const candidateIds = new Set(candidates.map((child) => child.id));
  const duplicateSourceIds = new Set<number>();
  const canonicalCandidateIds = new Set<number>();
  const relationGroupKeys = new Set<string>();
  for (const child of candidates) {
    const canonicalId = canonicalDuplicateOf(db, child.id);
    if (canonicalId === null) continue;
    duplicateSourceIds.add(child.id);
    const group = [canonicalId, ...duplicateSourcesFor(db, canonicalId)]
      .filter((id) => candidateIds.has(id))
      .sort((left, right) => left - right);
    if (candidateIds.has(canonicalId)) canonicalCandidateIds.add(canonicalId);
    if (group.length > 1) {
      const key = group.join(",");
      if (!relationGroupKeys.has(key)) {
        relationGroupKeys.add(key);
        duplicateGroups.push(group);
      }
    }
  }

  const suggestedSet = new Set([...bySiblingTitle.values()]
    .map((ids) => Math.min(...ids))
    .filter((id) => !duplicateSourceIds.has(id)));
  for (const id of canonicalCandidateIds) suggestedSet.add(id);
  const suggestedChildIds = [...suggestedSet].sort((left, right) => left - right);

  return {
    itemId: item.id,
    descendantIds: descendants.map((child) => child.id),
    cancelledDescendantIds: candidates.map((child) => child.id),
    suggestedChildIds,
    duplicateGroups,
  };
}

function dependencyClosure(db: Db, rootItemId: number, requestedIds: number[]): number[] {
  const descendants = new Map(listDescendants(db, rootItemId).map((item) => [item.id, item]));
  const selected = new Set<number>();
  const queue = [...requestedIds];
  while (queue.length) {
    const id = queue.shift()!;
    const item = descendants.get(id);
    if (!item) throw new Error(`item #${id} is not a descendant of #${rootItemId}`);
    if (selected.has(id)) continue;
    selected.add(id);
    for (const dependency of listDependencies(db, id)) queue.push(dependency.depends_on_item_id);
  }
  return [...selected].sort((left, right) => left - right);
}

export function restoreItemTree(
  db: Db,
  input: {
    itemId: number;
    mode?: ItemRestoreMode;
    childItemIds?: number[];
    requestedBy: string;
    sourceTurnId?: string | null;
    now?: Date;
    // 谁做的。不给时是你本人。
    by?: ActionAttribution;
  },
): ItemRestoreResult {
  const by = input.by ?? BY_USER;
  const who = by.actor === "user" ? "user" : "lead on behalf of user";
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item #${input.itemId} not found`);
  if (item.kind !== "task") throw new Error(`item #${input.itemId} is not a task`);

  const mode = input.mode ?? "root_only";
  const continuingTreeRestore = item.stage === "draft" && mode !== "root_only";
  if (item.stage !== "cancelled" && !continuingTreeRestore) {
    throw new Error(`cannot restore item #${item.id} from stage ${item.stage}`);
  }
  const preview = previewItemRestore(db, item.id);
  const requested = mode === "review_tree"
    ? preview.suggestedChildIds
    : mode === "selected_children"
      ? input.childItemIds ?? []
      : [];
  if (mode === "selected_children" && requested.length === 0) {
    throw new Error("selected_children restore requires at least one child item");
  }
  if (mode === "selected_children") {
    const cancelled = new Set(preview.cancelledDescendantIds);
    const unavailable = requested.filter((id) => !cancelled.has(id));
    if (unavailable.length > 0) {
      throw new Error(`selected child items are not cancelled descendants of #${item.id}: ${unavailable.join(", ")}`);
    }
  }
  const selected = mode === "root_only" ? [] : dependencyClosure(db, item.id, requested);
  const selectedSet = new Set(selected);
  const restoredItemIds: number[] = [];
  const at = input.now ?? new Date();

  db.transaction(() => {
    if (item.stage === "cancelled") {
      transition(db, {
        itemId: item.id,
        to: "draft",
        ...transitionBy(by),
        reason: mode === "root_only" ? `restored root item by ${who}` : `restore plan prepared by ${who}`,
        now: at,
      });
    }
    restoredItemIds.push(item.id);

    if (mode !== "root_only") {
      transition(db, {
        itemId: item.id,
        to: "ready",
        ...transitionBy(by),
        reason: continuingTreeRestore
          ? `continued tree restore confirmed by ${who}`
          : `restore plan confirmed by ${who}`,
        now: at,
      });
      for (const childId of selected) {
        const child = getItem(db, childId)!;
        if (child.stage !== "cancelled") continue;
        transition(db, {
          itemId: child.id,
          to: "ready",
          actor: "system",
          reason: `restored with root item #${item.id}`,
          now: at,
        });
        restoredItemIds.push(child.id);
      }
    }

    addActivity(db, {
      itemId: item.id,
      actor: by.actor,
      kind: "decision",
      ...behalfCursor(by),
      payload: {
        decision: "恢复任务",
        mode,
        requestedBy: input.requestedBy,
        ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
        restoredItemIds,
        retainedCancelledIds: preview.cancelledDescendantIds.filter((id) => !selectedSet.has(id)),
        duplicateGroups: preview.duplicateGroups,
        ...behalfFields(by),
      },
    });
  }).immediate();

  return {
    ...preview,
    mode,
    restoredItemIds,
    retainedCancelledIds: preview.cancelledDescendantIds.filter((id) => !selectedSet.has(id)),
    state: mode === "root_only" ? "draft" : "ready",
  };
}
