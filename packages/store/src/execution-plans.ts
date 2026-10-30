// 执行计划（工单详情与验收 spec 5.2，工单 06）：执行 agent 用 update_ticket_plan 维护的步骤列表，写的是「怎么做」。
// 验收标准写「要达到什么」，由 Lead 写；核查员对照验收标准，不对照计划。
//
// 表在 schema.ts 的 EXECUTION_PLANS_SCHEMA（v53）。只追加：每次更新一行，带整张列表、提交它的 Run 和时间。
// 这一行就是这次更新的账本记录；最新的一行是现在的计划。计划不写进工单的活动，所以「经过」和 Lead 的最近活动里没有它。
//
// 规则在这里校验，所有写入方都走它：
// - 每次提交整张列表。没做完（不是 done、skipped）的步骤最多 30 步，整张列表最多 60 步（审查 M2：只按总数算上限，
//   和下一条叠在一起，返工时 30 步都做完了就再也加不了一步）。
// - id 不重复，标题和备注有长度上限，状态是五种之一。
// - 标题只能有一行，备注的换行压成空格：计划会拼进 Lead 的 get_ticket 和执行 agent 的提示词，换行能伪造出
//   别的段落（审查 M3）。id、标题、备注里像密钥的内容（协议的 redactSecretText 会改动它）被拒绝。
// - id 稳定：现在的计划里有的 id，新列表里都要有，跳过的步骤除外（账本里旧的版本还在）。不做的步骤先标成 skipped，
//   在备注里写原因。返工时因此只能在原计划上更新，不能另起一份。被拒时报错带上现在的计划，开新会话的 agent
//   照着它补回原来的步骤，不用猜标题（审查 H1）。
// - 和现在的计划一样的列表不记新的一版（重试不刷账本）。
import { redactSecretText } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const PLAN_STEP_STATUSES = ["pending", "in_progress", "done", "skipped", "blocked"] as const;
export type PlanStepStatus = typeof PLAN_STEP_STATUSES[number];

export const PLAN_LIMITS = {
  maxSteps: 60, maxOpenSteps: 30, idMaxLength: 40, titleMaxLength: 120, noteMaxLength: 500,
} as const;

// 已经了结的步骤：不算进「没做完」的上限。
const SETTLED: readonly string[] = ["done", "skipped"];

const STEP_ID = new RegExp(`^[A-Za-z0-9._-]{1,${PLAN_LIMITS.idMaxLength}}$`);
const STEP_KEYS = new Set(["id", "title", "status", "note"]);
// 标题里不能有的字符：控制字符和行分隔符。
const NOT_ONE_LINE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  note: string | null;
}

// 现在的计划。createdAt 是第一次提交的时间，updatedAt 是这一版的时间，runId 是提交这一版的 Run。
export interface ExecutionPlan {
  itemId: number;
  revision: number;
  runId: number;
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionPlanRevision {
  itemId: number;
  revision: number;
  runId: number;
  steps: PlanStep[];
  createdAt: string;
}

interface RevisionRow {
  item_id: number;
  revision: number;
  run_id: number;
  steps: string;
  created_at: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNoSecret(value: string, field: string): void {
  if (redactSecretText(value) !== value) {
    throw new Error(`${field} looks like it contains a secret; remove it and name the secret instead of writing its value`);
  }
}

// 把执行 agent 交来的列表校验并规整成存储的样子。不合规时抛错，错误信息直接给 agent 看，所以写明怎么改。
export function normalizePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) throw new Error("items must be an array of plan steps");
  if (raw.length === 0) throw new Error("items must have at least one step");
  if (raw.length > PLAN_LIMITS.maxSteps) {
    throw new Error(
      `items has ${raw.length} steps; a plan has at most ${PLAN_LIMITS.maxSteps} steps. `
        + "To make room, remove skipped steps (the ledger keeps the older versions) "
        + "or group the remaining work into fewer, larger steps.",
    );
  }
  const seen = new Set<string>();
  const steps = raw.map((entry, index): PlanStep => {
    const at = `items[${index}]`;
    if (!isPlainObject(entry)) throw new Error(`${at} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!STEP_KEYS.has(key)) throw new Error(`${at} has unknown property '${key}'`);
    }
    const { id, title, status, note } = entry;
    if (typeof id !== "string" || !STEP_ID.test(id)) {
      throw new Error(`${at}.id must be 1 to ${PLAN_LIMITS.idMaxLength} letters, digits, '.', '_' or '-'`);
    }
    if (seen.has(id)) throw new Error(`duplicate step id '${id}'`);
    seen.add(id);
    assertNoSecret(id, `${at}.id`);
    const trimmedTitle = typeof title === "string" ? title.trim() : "";
    if (!trimmedTitle || trimmedTitle.length > PLAN_LIMITS.titleMaxLength) {
      throw new Error(`${at}.title must be a non-empty string of at most ${PLAN_LIMITS.titleMaxLength} characters`);
    }
    if (NOT_ONE_LINE.test(trimmedTitle)) {
      throw new Error(`${at}.title must be one line: it contains a line break or control character`);
    }
    assertNoSecret(trimmedTitle, `${at}.title`);
    if (typeof status !== "string" || !(PLAN_STEP_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`${at}.status must be one of ${PLAN_STEP_STATUSES.join(", ")}`);
    }
    if (note !== undefined && note !== null && typeof note !== "string") {
      throw new Error(`${at}.note must be a string or null`);
    }
    // 备注可以写成几行，存成一行：换行和连续的空白压成一个空格。
    const foldedNote = typeof note === "string" ? note.replace(/\s+/g, " ").trim() : "";
    if (CONTROL.test(foldedNote)) throw new Error(`${at}.note contains a control character`);
    if (foldedNote.length > PLAN_LIMITS.noteMaxLength) {
      throw new Error(`${at}.note must be at most ${PLAN_LIMITS.noteMaxLength} characters`);
    }
    if (foldedNote) assertNoSecret(foldedNote, `${at}.note`);
    return { id, title: trimmedTitle, status: status as PlanStepStatus, note: foldedNote || null };
  });
  const open = steps.filter((step) => !SETTLED.includes(step.status)).length;
  if (open > PLAN_LIMITS.maxOpenSteps) {
    throw new Error(
      `items has ${open} steps that are not done or skipped; at most ${PLAN_LIMITS.maxOpenSteps} such steps are allowed. `
        + "Group the remaining work into fewer, larger steps.",
    );
  }
  return steps;
}

function parseSteps(row: RevisionRow): PlanStep[] {
  return JSON.parse(row.steps) as PlanStep[];
}

function latestRow(db: Db, itemId: number): RevisionRow | undefined {
  return db.prepare(
    "SELECT * FROM item_execution_plans WHERE item_id = ? ORDER BY revision DESC LIMIT 1",
  ).get(itemId) as RevisionRow | undefined;
}

export function getExecutionPlan(db: Db, itemId: number): ExecutionPlan | null {
  const latest = latestRow(db, itemId);
  if (!latest) return null;
  const first = db.prepare(
    "SELECT created_at FROM item_execution_plans WHERE item_id = ? ORDER BY revision LIMIT 1",
  ).get(itemId) as { created_at: string };
  return {
    itemId: latest.item_id,
    revision: latest.revision,
    runId: latest.run_id,
    steps: parseSteps(latest),
    createdAt: first.created_at,
    updatedAt: latest.created_at,
  };
}

export function listExecutionPlanRevisions(db: Db, itemId: number): ExecutionPlanRevision[] {
  return (db.prepare(
    "SELECT * FROM item_execution_plans WHERE item_id = ? ORDER BY revision",
  ).all(itemId) as RevisionRow[]).map((row) => ({
    itemId: row.item_id,
    revision: row.revision,
    runId: row.run_id,
    steps: parseSteps(row),
    createdAt: row.created_at,
  }));
}

// 记下一份计划。changed=false 表示列表和现在的计划一样，没有记新的一版。
// 谁能提交（执行者、工单没结束、Run 在跑）由调用方判断（engine 的 update_ticket_plan）。
export function recordExecutionPlan(
  db: Db,
  input: { itemId: number; runId: number; steps: unknown; now?: Date },
): { plan: ExecutionPlan; changed: boolean } {
  const steps = normalizePlanSteps(input.steps);
  return db.transaction(() => {
    const item = db.prepare("SELECT kind FROM items WHERE id = ?").get(input.itemId) as { kind: string } | undefined;
    if (!item) throw new Error(`item #${input.itemId} not found`);
    if (item.kind !== "task") throw new Error(`item #${input.itemId} is a ${item.kind}; only a task has an execution plan`);
    const run = db.prepare("SELECT item_id FROM runs WHERE id = ?").get(input.runId) as { item_id: number } | undefined;
    if (!run || run.item_id !== input.itemId) {
      throw new Error(`run #${input.runId} does not belong to item #${input.itemId}`);
    }
    const latest = latestRow(db, input.itemId);
    if (latest) {
      const current = parseSteps(latest);
      const ids = new Set(steps.map((step) => step.id));
      const missing = current.filter((step) => step.status !== "skipped" && !ids.has(step.id)).map((step) => step.id);
      if (missing.length) {
        throw new Error(
          `every step of the current plan must stay in the list; missing: ${missing.join(", ")}. `
            + "Step ids are stable: update the current plan instead of starting a new one. "
            + "Keep the steps as they are, change only the steps whose status, title or note changed, and add new steps. "
            + "To drop a step, mark it skipped with the reason in note; a skipped step may be left out later. "
            + `Current plan: ${JSON.stringify(current.map(({ id, title, status }) => ({ id, title, status })))}`,
        );
      }
      if (JSON.stringify(current) === JSON.stringify(steps)) {
        return { plan: getExecutionPlan(db, input.itemId)!, changed: false };
      }
    }
    db.prepare(
      "INSERT INTO item_execution_plans (item_id, revision, run_id, steps, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      input.itemId, (latest?.revision ?? 0) + 1, input.runId, JSON.stringify(steps),
      (input.now ?? new Date()).toISOString(),
    );
    return { plan: getExecutionPlan(db, input.itemId)!, changed: true };
  }).immediate();
}
