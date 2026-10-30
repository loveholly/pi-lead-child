// 工单节点（左栏改版阶段 3）：截止、提测、发布、核查和自定义的日期，带出处和修改历史。
//
// - 只有 task 有节点（触发器 item_milestones_task_only）。提醒本身就是一个时间点。
// - 没有硬删除：取消就是 state = cancelled，可以恢复。每次改动写一行 item_milestone_changes。
// - items.due_at 是派生值：最早的未完成截止节点。所有写截止的路径都走这里，在同一个事务里同步它；
//   截止移动时重置 due_overdue_notified，逾期提醒按新的时间再提醒一次。
// - 这里不发事件。调用方（Lead 工具、child 工具、HTTP 接口）照常发 ticket.updated。
import type { Db } from "./db.js";

export const MILESTONE_KINDS = ["due", "test_handoff", "release", "review", "custom"] as const;
export type MilestoneKind = typeof MILESTONE_KINDS[number];
export const MILESTONE_STATES = ["planned", "done", "missed", "cancelled"] as const;
export type MilestoneState = typeof MILESTONE_STATES[number];
export const MILESTONE_ACTORS = ["user", "lead", "child", "system"] as const;
export type MilestoneActor = typeof MILESTONE_ACTORS[number];
export const MILESTONE_CONFIDENCES = ["high", "medium", "low"] as const;
export type MilestoneConfidence = typeof MILESTONE_CONFIDENCES[number];
export type MilestoneChangeKind =
  | "created" | "moved" | "relabeled" | "completed" | "missed" | "cancelled" | "restored";

/** 显示名的上限。custom 必须有显示名，其他类型可以改显示名。 */
export const MILESTONE_LABEL_MAX = 40;

export interface ItemMilestone {
  id: number;
  item_id: number;
  kind: MilestoneKind;
  label: string | null;
  at: string;
  all_day: 0 | 1;
  tz: string | null;
  state: MilestoneState;
  source_actor: MilestoneActor;
  source_run_id: number | null;
  source_turn_id: string | null;
  source_quote: string | null;
  confidence: MilestoneConfidence | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ItemMilestoneChange {
  id: number;
  milestone_id: number;
  actor: MilestoneActor;
  run_id: number | null;
  change: MilestoneChangeKind;
  before_json: string | null;
  after_json: string;
  reason: string | null;
  created_at: string;
}

export type MilestoneSource = {
  actor: MilestoneActor;
  runId?: number | null;
  turnId?: string | null;
  quote?: string | null;
  confidence?: MilestoneConfidence | null;
  reason?: string | null;
  now?: Date;
};

function oneOf<T extends string>(values: readonly T[], value: string, what: string): T {
  if (!(values as readonly string[]).includes(value)) throw new Error(`invalid milestone ${what}: ${value}`);
  return value as T;
}

function normalizeAt(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid milestone time: ${at}`);
  return date.toISOString();
}

function normalizeLabel(label: string | null | undefined): string | null {
  if (label === undefined || label === null) return null;
  const trimmed = label.trim();
  if (!trimmed) return null;
  if ([...trimmed].length > MILESTONE_LABEL_MAX) {
    throw new Error(`milestone label is longer than ${MILESTONE_LABEL_MAX} characters`);
  }
  return trimmed;
}

// 出处里的 Run 和对话轮次是外键。调用方给的 id 不存在（例如系统回合没有落库）时记成空，不让整次写入失败。
function existingRunId(db: Db, runId: number | null | undefined): number | null {
  if (runId == null) return null;
  return db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId) ? runId : null;
}

function existingTurnId(db: Db, turnId: string | null | undefined): string | null {
  if (!turnId) return null;
  return db.prepare("SELECT 1 FROM channel_turns WHERE id = ?").get(turnId) ? turnId : null;
}

function snapshot(milestone: ItemMilestone): Record<string, unknown> {
  return { kind: milestone.kind, label: milestone.label, at: milestone.at, allDay: milestone.all_day === 1, state: milestone.state };
}

export function getMilestone(db: Db, id: number): ItemMilestone | undefined {
  return db.prepare("SELECT * FROM item_milestones WHERE id = ?").get(id) as ItemMilestone | undefined;
}

export function listMilestones(
  db: Db,
  filter: { itemId?: number; states?: readonly MilestoneState[] } = {},
): ItemMilestone[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.itemId !== undefined) {
    where.push("item_id = ?");
    values.push(filter.itemId);
  }
  if (filter.states?.length) {
    where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
    values.push(...filter.states);
  }
  return db.prepare(
    `SELECT * FROM item_milestones${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at, id`,
  ).all(...values) as ItemMilestone[];
}

export function listMilestoneChanges(db: Db, milestoneId: number): ItemMilestoneChange[] {
  return db.prepare("SELECT * FROM item_milestone_changes WHERE milestone_id = ? ORDER BY id")
    .all(milestoneId) as ItemMilestoneChange[];
}

/** 每张工单最近的一个未完成节点（任何类型）。工单行、项目卡片和收件箱都读它。 */
export function nextPlannedMilestones(db: Db): Map<number, ItemMilestone> {
  const rows = db.prepare(
    `SELECT * FROM item_milestones m
     WHERE m.state = 'planned'
       AND NOT EXISTS (
         SELECT 1 FROM item_milestones o
         WHERE o.item_id = m.item_id AND o.state = 'planned'
           AND (o.at < m.at OR (o.at = m.at AND o.id < m.id))
       )`,
  ).all() as ItemMilestone[];
  return new Map(rows.map((row) => [row.item_id, row]));
}

/** items.due_at = 最早的未完成截止节点。截止变了就重置逾期提醒。 */
export function syncItemDueAt(db: Db, itemId: number): void {
  const earliest = db.prepare(
    "SELECT at FROM item_milestones WHERE item_id = ? AND kind = 'due' AND state = 'planned' ORDER BY at, id LIMIT 1",
  ).get(itemId) as { at: string } | undefined;
  const current = db.prepare("SELECT due_at FROM items WHERE id = ?").get(itemId) as { due_at: string | null } | undefined;
  if (!current) throw new Error(`item ${itemId} not found`);
  const dueAt = earliest?.at ?? null;
  if (current.due_at === dueAt) return;
  db.prepare("UPDATE items SET due_at = ?, due_overdue_notified = 0, updated_at = datetime('now') WHERE id = ?")
    .run(dueAt, itemId);
}

function insertChange(
  db: Db,
  milestoneId: number,
  change: MilestoneChangeKind,
  before: ItemMilestone | null,
  after: ItemMilestone,
  source: MilestoneSource,
  at: string,
): ItemMilestoneChange {
  const result = db.prepare(
    `INSERT INTO item_milestone_changes (milestone_id, actor, run_id, change, before_json, after_json, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    milestoneId, source.actor, existingRunId(db, source.runId), change,
    before ? JSON.stringify(snapshot(before)) : null, JSON.stringify(snapshot(after)),
    source.reason?.trim() || null, at,
  );
  return db.prepare("SELECT * FROM item_milestone_changes WHERE id = ?").get(result.lastInsertRowid) as ItemMilestoneChange;
}

export function createMilestone(
  db: Db,
  itemId: number,
  input: { kind: MilestoneKind; at: string; allDay?: boolean; label?: string | null; tz?: string | null },
  source: MilestoneSource,
): ItemMilestone {
  const kind = oneOf(MILESTONE_KINDS, input.kind, "kind");
  const actor = oneOf(MILESTONE_ACTORS, source.actor, "actor");
  const at = normalizeAt(input.at);
  const label = normalizeLabel(input.label);
  if (kind === "custom" && !label) throw new Error("a custom milestone needs a label");
  // 置信度只对 Lead 和 child 推断出的日期有意义；用户和系统定的日期就是事实。
  const confidence = actor === "lead" || actor === "child"
    ? source.confidence ? oneOf(MILESTONE_CONFIDENCES, source.confidence, "confidence") : null
    : null;
  const item = db.prepare("SELECT kind FROM items WHERE id = ?").get(itemId) as { kind: string } | undefined;
  if (!item) throw new Error(`item ${itemId} not found`);
  if (item.kind !== "task") throw new Error(`milestones belong to tasks; #${itemId} is a ${item.kind}`);
  const now = (source.now ?? new Date()).toISOString();
  return db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO item_milestones
         (item_id, kind, label, at, all_day, tz, state, source_actor, source_run_id, source_turn_id,
          source_quote, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      itemId, kind, label, at, input.allDay ? 1 : 0, input.tz ?? null, actor,
      existingRunId(db, source.runId), existingTurnId(db, source.turnId), source.quote?.trim() || null,
      confidence, now, now,
    );
    const milestone = getMilestone(db, Number(result.lastInsertRowid))!;
    insertChange(db, milestone.id, "created", null, milestone, { ...source, actor }, now);
    if (kind === "due") syncItemDueAt(db, itemId);
    return milestone;
  })();
}

export type MilestoneUpdate = {
  milestone: ItemMilestone;
  change: ItemMilestoneChange | null;
  /** 上一次改它的是用户，这一次是 Lead。收件箱的「Lead 已处理」据此告诉用户。 */
  overrodeUser: boolean;
};

export function updateMilestone(
  db: Db,
  id: number,
  patch: { at?: string; allDay?: boolean; label?: string | null; state?: MilestoneState },
  source: MilestoneSource,
): MilestoneUpdate {
  const actor = oneOf(MILESTONE_ACTORS, source.actor, "actor");
  const now = (source.now ?? new Date()).toISOString();
  return db.transaction(() => {
    const before = getMilestone(db, id);
    if (!before) throw new Error(`milestone ${id} not found`);
    const at = patch.at === undefined ? before.at : normalizeAt(patch.at);
    const allDay = patch.allDay === undefined ? before.all_day : patch.allDay ? 1 : 0;
    const label = patch.label === undefined ? before.label : normalizeLabel(patch.label);
    if (before.kind === "custom" && !label) throw new Error("a custom milestone needs a label");
    const state = patch.state === undefined ? before.state : oneOf(MILESTONE_STATES, patch.state, "state");
    const change: MilestoneChangeKind | null = state !== before.state
      ? state === "planned" ? "restored" : state === "done" ? "completed" : state
      : at !== before.at || allDay !== before.all_day ? "moved"
        : label !== before.label ? "relabeled"
          : null;
    if (change === null) return { milestone: before, change: null, overrodeUser: false };
    const last = db.prepare("SELECT actor FROM item_milestone_changes WHERE milestone_id = ? ORDER BY id DESC LIMIT 1")
      .get(id) as { actor: MilestoneActor } | undefined;
    const closedAt = state === "planned" ? null : state === before.state ? before.closed_at : now;
    db.prepare(
      `UPDATE item_milestones SET at = ?, all_day = ?, label = ?, state = ?, closed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(at, allDay, label, state, closedAt, now, id);
    const milestone = getMilestone(db, id)!;
    const recorded = insertChange(db, id, change, before, milestone, { ...source, actor }, now);
    if (milestone.kind === "due") syncItemDueAt(db, milestone.item_id);
    return { milestone, change: recorded, overrodeUser: actor === "lead" && last?.actor === "user" };
  })();
}

/**
 * 设一张工单的截止（setItemTime、Lead 和 child 的旧入口）。已有未完成的截止就移动最早的那个，
 * 没有就新建；传 null 取消全部未完成的截止。
 */
export function setItemDue(db: Db, itemId: number, dueAt: string | null, source: MilestoneSource): void {
  db.transaction(() => {
    const planned = listMilestones(db, { itemId, states: ["planned"] }).filter((milestone) => milestone.kind === "due");
    if (dueAt === null) {
      for (const milestone of planned) updateMilestone(db, milestone.id, { state: "cancelled" }, source);
      syncItemDueAt(db, itemId);
      return;
    }
    const earliest = planned[0];
    if (earliest) updateMilestone(db, earliest.id, { at: dueAt }, source);
    else createMilestone(db, itemId, { kind: "due", at: dueAt }, source);
  })();
}

export type LeadOverride = {
  change: ItemMilestoneChange;
  milestone: ItemMilestone;
};

/** Lead 改了用户定的节点（since 之后）。收件箱的「Lead 已处理」把它们告诉用户。 */
export function leadOverridesOfUser(db: Db, sinceIso: string): LeadOverride[] {
  const rows = db.prepare(
    `SELECT c.id AS change_id FROM item_milestone_changes c
     WHERE c.actor = 'lead' AND c.change <> 'created' AND c.created_at > ?
       AND (SELECT p.actor FROM item_milestone_changes p
            WHERE p.milestone_id = c.milestone_id AND p.id < c.id
            ORDER BY p.id DESC LIMIT 1) = 'user'
     ORDER BY c.id`,
  ).all(sinceIso) as { change_id: number }[];
  return rows.map(({ change_id }) => {
    const change = db.prepare("SELECT * FROM item_milestone_changes WHERE id = ?").get(change_id) as ItemMilestoneChange;
    return { change, milestone: getMilestone(db, change.milestone_id)! };
  });
}

// 日程顶部的一句话（决定 1 借的第二处）：Lead 写，只写事实和风险。存在 kv，带写下的时间；
// 客户端只在它是今天写的时候显示，否则显示同样内容的事实文案。
const AGENDA_NOTE_KEY = "companion_agenda_note";
export const AGENDA_NOTE_MAX = 200;

export function agendaNote(db: Db): { text: string; at: string } | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(AGENDA_NOTE_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { text?: unknown; at?: unknown };
    return typeof parsed.text === "string" && typeof parsed.at === "string" && parsed.text.trim()
      ? { text: parsed.text, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

export function setAgendaNote(db: Db, text: string, at: Date = new Date()): void {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("the agenda note is empty");
  if ([...trimmed].length > AGENDA_NOTE_MAX) throw new Error(`the agenda note is longer than ${AGENDA_NOTE_MAX} characters`);
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(AGENDA_NOTE_KEY, JSON.stringify({ text: trimmed, at: at.toISOString() }));
}
