// 子 agent 的权限清单（.scratch/confidence-model/landing.md 第 5 节）：读写 run_grants、run_grant_changes、run_tool_calls
// （schema.ts 的 RUN_GRANTS_SCHEMA，v55）。清单的形状和计算在 protocol 的 run-grants.ts；这里只管存取。
//
// 规则：
//   - 一个 Run 最多一份清单，建 Run 的那笔事务里一起建（insertRunGrant）。没有清单的 Run 照旧按连接的角色和写入策略放行。
//   - 清单只经 applyRunGrantChange 改：带上改之前的 revision（乐观锁），同一笔事务里记一条账本。没有删除的入口。
//   - 读出来的清单不合 schema（例如有人绕过 daemon 改了库）时，当作空清单：拒绝一切调用（故障关闭）。
//   - run_tool_calls 是连接中心写的审计：每次调用一行，拒绝的也记。参数只存截短、脱敏以后的预览。
import {
  isRunGrant, redactSecretText,
  type GrantIntent, type GrantLocalRepo, type GrantScope, type IntentGrantBound, type RunGrant, type RunGrantRule,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export interface RunGrantRecord {
  runId: number;
  itemId: number;
  intent: GrantIntent;
  // 现在生效的清单。库里的值坏了时是空清单（rules 为空），invalid 为 true。
  grant: RunGrant;
  invalid: boolean;
  bound: IntentGrantBound | null;
  scope: GrantScope | null;
  dropped: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type RunGrantChangeKind = "created" | "widened" | "reverted";

export interface RunGrantChange {
  id: number;
  runId: number;
  revision: number;
  change: RunGrantChangeKind;
  // created：建时的全部规则；widened：这次加上的；reverted：这次删掉的。
  rules: RunGrantRule[];
  localRepos: GrantLocalRepo[];
  actor: "user" | "lead" | "system";
  onBehalfTurnId: string | null;
  reason: string | null;
  revertsChangeId: number | null;
  createdAt: string;
}

interface RunGrantRow {
  run_id: number;
  item_id: number;
  intent: string;
  grant_json: string;
  bound_json: string;
  scope_json: string;
  dropped_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RunGrantChangeRow {
  id: number;
  run_id: number;
  revision: number;
  change: RunGrantChangeKind;
  rules_json: string;
  local_repos_json: string;
  actor: "user" | "lead" | "system";
  on_behalf_turn_id: string | null;
  reason: string | null;
  reverts_change_id: number | null;
  created_at: string;
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: RunGrantRow): RunGrantRecord {
  const parsed = parse<unknown>(row.grant_json, null);
  const valid = isRunGrant(parsed);
  const intent = row.intent as GrantIntent;
  return {
    runId: row.run_id,
    itemId: row.item_id,
    intent,
    grant: valid ? parsed : { version: 1, intent, rules: [], localRepos: [] },
    invalid: !valid,
    bound: parse<IntentGrantBound | null>(row.bound_json, null),
    scope: parse<GrantScope | null>(row.scope_json, null),
    dropped: parse<string[]>(row.dropped_json, []),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChange(row: RunGrantChangeRow): RunGrantChange {
  return {
    id: row.id,
    runId: row.run_id,
    revision: row.revision,
    change: row.change,
    rules: parse<RunGrantRule[]>(row.rules_json, []),
    localRepos: parse<GrantLocalRepo[]>(row.local_repos_json, []),
    actor: row.actor,
    onBehalfTurnId: row.on_behalf_turn_id,
    reason: row.reason,
    revertsChangeId: row.reverts_change_id,
    createdAt: row.created_at,
  };
}

/** 建一个 Run 的清单，记一条 created。调用方负责事务（和建 Run 在同一笔里）。 */
export function insertRunGrant(db: Db, input: {
  runId: number;
  itemId: number;
  grant: RunGrant;
  bound: IntentGrantBound;
  scope: GrantScope;
  dropped?: readonly string[];
  actor?: "lead" | "system";
  reason?: string | null;
  now?: Date;
}): RunGrantRecord {
  if (!isRunGrant(input.grant)) throw new Error("run grant does not match the RunGrant schema");
  const at = (input.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO run_grants (run_id, item_id, intent, grant_json, bound_json, scope_json, dropped_json, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    input.runId, input.itemId, input.grant.intent, JSON.stringify(input.grant), JSON.stringify(input.bound),
    JSON.stringify(input.scope), JSON.stringify(input.dropped ?? []), at, at,
  );
  db.prepare(
    `INSERT INTO run_grant_changes (run_id, revision, change, rules_json, local_repos_json, actor, reason, created_at)
     VALUES (?, 1, 'created', ?, ?, ?, ?, ?)`,
  ).run(
    input.runId, JSON.stringify(input.grant.rules), JSON.stringify(input.grant.localRepos), input.actor ?? "lead",
    input.reason ?? null, at,
  );
  return getRunGrant(db, input.runId)!;
}

export function getRunGrant(db: Db, runId: number): RunGrantRecord | null {
  const row = db.prepare("SELECT * FROM run_grants WHERE run_id = ?").get(runId) as RunGrantRow | undefined;
  return row ? toRecord(row) : null;
}

/** 一张工单最近一个带清单的 Run 的清单。工单动作「放宽权限」不给 runId 时用它。 */
export function latestRunGrantOfItem(db: Db, itemId: number): RunGrantRecord | null {
  const row = db.prepare("SELECT * FROM run_grants WHERE item_id = ? ORDER BY run_id DESC LIMIT 1").get(itemId) as RunGrantRow | undefined;
  return row ? toRecord(row) : null;
}

export class RunGrantConflictError extends Error {
  constructor(runId: number, expected: number, actual: number) {
    super(`run #${runId} grant changed meanwhile (revision ${actual}, expected ${expected})`);
    this.name = "RunGrantConflictError";
  }
}

/**
 * 改一个 Run 的清单：写新的清单，revision 加一，记一条账本。expectedRevision 和库里的不一样时抛 RunGrantConflictError
 * （读和写之间别人改过）。调用方负责事务时也可以直接调；不在事务里时这里自己开一笔。
 */
export function applyRunGrantChange(db: Db, input: {
  runId: number;
  expectedRevision: number;
  grant: RunGrant;
  change: Exclude<RunGrantChangeKind, "created">;
  rules: readonly RunGrantRule[];
  localRepos?: readonly GrantLocalRepo[];
  actor: "user" | "lead" | "system";
  onBehalfTurnId?: string | null;
  reason?: string | null;
  revertsChangeId?: number | null;
  now?: Date;
}): { record: RunGrantRecord; change: RunGrantChange } {
  if (!isRunGrant(input.grant)) throw new Error("run grant does not match the RunGrant schema");
  const apply = () => {
    const current = getRunGrant(db, input.runId);
    if (!current) throw new Error(`run #${input.runId} has no grant`);
    if (current.revision !== input.expectedRevision) throw new RunGrantConflictError(input.runId, input.expectedRevision, current.revision);
    const at = (input.now ?? new Date()).toISOString();
    const revision = current.revision + 1;
    db.prepare("UPDATE run_grants SET grant_json = ?, revision = ?, updated_at = ? WHERE run_id = ?")
      .run(JSON.stringify(input.grant), revision, at, input.runId);
    const changeId = Number(db.prepare(
      `INSERT INTO run_grant_changes
         (run_id, revision, change, rules_json, local_repos_json, actor, on_behalf_turn_id, reason, reverts_change_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId, revision, input.change, JSON.stringify(input.rules), JSON.stringify(input.localRepos ?? []), input.actor,
      input.onBehalfTurnId ?? null, input.reason?.slice(0, 2_000) ?? null, input.revertsChangeId ?? null, at,
    ).lastInsertRowid);
    return { record: getRunGrant(db, input.runId)!, change: getRunGrantChange(db, changeId)! };
  };
  return db.inTransaction ? apply() : db.transaction(apply).immediate();
}

export function getRunGrantChange(db: Db, id: number): RunGrantChange | null {
  const row = db.prepare("SELECT * FROM run_grant_changes WHERE id = ?").get(id) as RunGrantChangeRow | undefined;
  return row ? toChange(row) : null;
}

export function listRunGrantChanges(db: Db, runId: number): RunGrantChange[] {
  return (db.prepare("SELECT * FROM run_grant_changes WHERE run_id = ? ORDER BY id").all(runId) as RunGrantChangeRow[]).map(toChange);
}

/** 一次放宽有没有被撤销过。 */
export function grantChangeRevertedBy(db: Db, changeId: number): RunGrantChange | null {
  const row = db.prepare("SELECT * FROM run_grant_changes WHERE reverts_change_id = ? ORDER BY id LIMIT 1").get(changeId) as RunGrantChangeRow | undefined;
  return row ? toChange(row) : null;
}

// ── 连接中心的调用审计 ──────────────────────────────────────────────────────────────

export interface RunToolCallInput {
  runId: number;
  itemId: number;
  connection: string;
  tool: string;
  access: "read" | "write";
  decision: "allowed" | "refused";
  // 放行的调用的结果。拒绝的为 null；调用本身抛错时是 failed；工具返回错误时是 error。
  outcome?: "ok" | "error" | "failed" | null;
  reason?: string | null;
  ruleId?: string | null;
  // 调用的对象，例如 Acme/x#101、pi-lead-child:src/a.ts。
  target?: string | null;
  // 写操作做了什么（一句话）和链接。
  summary?: string | null;
  url?: string | null;
  args?: Record<string, unknown> | null;
  now?: Date;
}

export interface RunToolCall {
  id: number;
  runId: number;
  itemId: number;
  connection: string;
  tool: string;
  access: "read" | "write";
  decision: "allowed" | "refused";
  outcome: "ok" | "error" | "failed" | null;
  reason: string | null;
  ruleId: string | null;
  target: string | null;
  summary: string | null;
  url: string | null;
  // 写操作别人看不看得到。读和拒绝的是 null。
  visible: boolean | null;
  argsPreview: string | null;
  createdAt: string;
}

const ARGS_PREVIEW_CHARS = 2_000;

function argsPreview(args: Record<string, unknown> | null | undefined): string | null {
  if (!args) return null;
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return null;
  }
  return redactSecretText(text.length > ARGS_PREVIEW_CHARS ? `${text.slice(0, ARGS_PREVIEW_CHARS)}…` : text);
}

const clip = (value: string | null | undefined, max: number) => (value == null ? null : value.slice(0, max));

/** 记一次调用。返回行号。 */
export function recordRunToolCall(db: Db, input: RunToolCallInput): number {
  return Number(db.prepare(
    `INSERT INTO run_tool_calls
       (run_id, item_id, connection, tool, access, decision, outcome, reason, rule_id, target, summary, url, args_preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId, input.itemId, input.connection.slice(0, 100), input.tool.slice(0, 100), input.access, input.decision,
    input.outcome ?? null, clip(input.reason, 500), clip(input.ruleId, 200), clip(input.target, 300), clip(input.summary, 500),
    clip(input.url, 1_000), argsPreview(input.args), (input.now ?? new Date()).toISOString(),
  ).lastInsertRowid);
}

/** 放行的调用有了结果以后补上结果、做了什么、链接和别人看不看得到。 */
export function settleRunToolCall(db: Db, id: number, input: {
  outcome: "ok" | "error" | "failed";
  reason?: string | null;
  summary?: string | null;
  url?: string | null;
  visible?: boolean | null;
}): void {
  db.prepare(
    `UPDATE run_tool_calls SET outcome = ?, reason = COALESCE(?, reason), summary = COALESCE(?, summary), url = COALESCE(?, url),
       visible = COALESCE(?, visible) WHERE id = ?`,
  ).run(
    input.outcome, clip(input.reason, 500), clip(input.summary, 500), clip(input.url, 1_000),
    input.visible === undefined || input.visible === null ? null : input.visible ? 1 : 0, id,
  );
}

export function getRunToolCall(db: Db, id: number): RunToolCall | null {
  const row = db.prepare("SELECT * FROM run_tool_calls WHERE id = ?").get(id) as RunToolCallRow | undefined;
  return row ? toCall(row) : null;
}

interface RunToolCallRow {
  id: number;
  run_id: number;
  item_id: number;
  connection: string;
  tool: string;
  access: "read" | "write";
  decision: "allowed" | "refused";
  outcome: "ok" | "error" | "failed" | null;
  reason: string | null;
  rule_id: string | null;
  target: string | null;
  summary: string | null;
  url: string | null;
  visible: number | null;
  args_preview: string | null;
  created_at: string;
}

function toCall(row: RunToolCallRow): RunToolCall {
  return {
    id: row.id, runId: row.run_id, itemId: row.item_id, connection: row.connection, tool: row.tool, access: row.access,
    decision: row.decision, outcome: row.outcome, reason: row.reason, ruleId: row.rule_id, target: row.target,
    summary: row.summary, url: row.url, visible: row.visible === null ? null : row.visible === 1,
    argsPreview: row.args_preview, createdAt: row.created_at,
  };
}

export function listRunToolCalls(db: Db, runId: number, filter: { access?: "read" | "write"; decision?: "allowed" | "refused" } = {}): RunToolCall[] {
  const rows = db.prepare(
    `SELECT * FROM run_tool_calls WHERE run_id = ?
       AND (? IS NULL OR access = ?) AND (? IS NULL OR decision = ?)
     ORDER BY id`,
  ).all(runId, filter.access ?? null, filter.access ?? null, filter.decision ?? null, filter.decision ?? null) as RunToolCallRow[];
  return rows.map(toCall);
}

/** 这个 Run 经连接中心成功做了的写操作（交回结果时「做了哪些动作」的出处）。 */
export function listRunWrites(db: Db, runId: number): RunToolCall[] {
  return listRunToolCalls(db, runId, { access: "write", decision: "allowed" }).filter((call) => call.outcome === "ok");
}
