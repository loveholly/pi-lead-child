// 结构化验收标准（工单详情与验收 spec 4.3、5.1、D5、D6，工单 05）。表在 schema.ts 的 ACCEPTANCE_CRITERIA_SCHEMA（v54）。
// 验收标准写「要达到什么」，执行计划（execution-plans.ts）写「怎么做」。
//
// 谁写、谁改（调用方各自按自己的入口传 by）：
// - 写：Lead 建单（create_task）；PR 评审模板由系统抄入你的原话；执行 agent 拆子工单时给每张子工单写。
// - 改：Lead 和你（工单操作 edit_acceptance_criteria）。执行 agent 没有改的入口，有异议时用 request_decision 提出（D6）。
// - 确认：只属于你（工单操作 confirm_criterion、unconfirm_criterion），Lead 只能凭你这一轮代你做（spec 5.11）。
//
// 规则在这里校验，所有写入方都走它：
// - 文字只有一行：拒绝换行、行分隔符和控制字符（标准会拼进 Lead 的 get_ticket 和执行 agent 的提示词，换行能伪造出
//   别的段落，工单 06 审查 M3 的同类问题）。像密钥的内容（协议的 redactSecretText 会改动它）被拒绝。有长度和条数上限。
// - 同一张工单里没删的标准文字不重复。
// - 改了某一条的文字、或者删了它，你在「现在这次交付」上对它的确认结束，原因记成 criterion_edited 或 criterion_deleted。
//   现在这次交付：最新一次交付，而且工单停在待验收或已完成。返工中（上一次交付已经过去）和更早的交付上的确认不动
//   （工单 05 审查 M4）：那是历史，切回那次交付时，条数和确认要和当时一样。
//   核查员的逐条结论（工单 10）按同一条规则作废：结论记下标准的 revision，和现在的不一样就不算数。
// - 每一版文字都留着（item_acceptance_criterion_revisions），切回历史交付时显示那次交付的那一版。
// - 执行者每次启动时，记下它在提示里看到的每一条和版本（executor_criteria_views）。这样能判断「执行者做的不是现在这一版」，
//   执行中改的也算（审查 M2）。
// - 并发编辑：update、remove 的每一项可以带上页面看到的 revision。对不上、或者那一条已经被删了、order 列的不是现在留下的那些，
//   都是页面过时了（code=stale），不是输入不对（审查 M3）。
// - 确认按交付存：一次交付是 04 的一个执行 Run（delivery_snapshots.executor_run_id），确认还记下你看的那一份快照。
//   「现在是哪一次交付」由 engine 按交付快照定，这里只核对快照和执行 Run 对得上。
import { redactSecretText } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const ACCEPTANCE_CRITERIA_LIMITS = { maxCriteria: 20, textMaxLength: 500 } as const;

export type CriterionWriter = "user" | "lead" | "child" | "system";
export type CriterionEditor = "user" | "lead";
export type ConfirmationEndReason = "unconfirmed" | "criterion_edited" | "criterion_deleted";

// 规则不满足时的拒绝。message 直接给调用方看（Lead、执行 agent、页面），所以写明怎么改。
// stale：页面看到的已经过时了（那一条被别人改过、删了，或者顺序变了）。刷新以后再改。
export class AcceptanceCriteriaError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "stale", message: string) {
    super(message);
    this.name = "AcceptanceCriteriaError";
  }
}

export interface AcceptanceCriterion {
  id: number;
  itemId: number;
  position: number;
  text: string;
  revision: number;
  createdBy: CriterionWriter;
  createdRunId: number | null;
  createdAt: string;
  editedBy: CriterionEditor | null;
  editedAt: string | null;
  updatedAt: string;
  deletedBy: CriterionEditor | null;
  deletedAt: string | null;
}

export interface CriterionConfirmation {
  id: number;
  itemId: number;
  criterionId: number;
  criterionRevision: number;
  executorRunId: number;
  deliverySnapshotId: number;
  confirmedBy: "user" | "lead";
  onBehalfOf: "user" | null;
  sourceTurnId: string | null;
  confirmedAt: string;
  endedBy: CriterionEditor | null;
  endedAt: string | null;
  endReason: ConfirmationEndReason | null;
}

interface CriterionRow {
  id: number;
  item_id: number;
  position: number;
  text: string;
  revision: number;
  created_by: CriterionWriter;
  created_run_id: number | null;
  created_at: string;
  edited_by: CriterionEditor | null;
  edited_at: string | null;
  updated_at: string;
  deleted_by: CriterionEditor | null;
  deleted_at: string | null;
}

interface ConfirmationRow {
  id: number;
  item_id: number;
  criterion_id: number;
  criterion_revision: number;
  executor_run_id: number;
  delivery_snapshot_id: number;
  confirmed_by: "user" | "lead";
  on_behalf_of: "user" | null;
  source_turn_id: string | null;
  confirmed_at: string;
  ended_by: CriterionEditor | null;
  ended_at: string | null;
  end_reason: ConfirmationEndReason | null;
}

const criterionOf = (row: CriterionRow): AcceptanceCriterion => ({
  id: row.id,
  itemId: row.item_id,
  position: row.position,
  text: row.text,
  revision: row.revision,
  createdBy: row.created_by,
  createdRunId: row.created_run_id,
  createdAt: row.created_at,
  editedBy: row.edited_by,
  editedAt: row.edited_at,
  updatedAt: row.updated_at,
  deletedBy: row.deleted_by,
  deletedAt: row.deleted_at,
});

const confirmationOf = (row: ConfirmationRow): CriterionConfirmation => ({
  id: row.id,
  itemId: row.item_id,
  criterionId: row.criterion_id,
  criterionRevision: row.criterion_revision,
  executorRunId: row.executor_run_id,
  deliverySnapshotId: row.delivery_snapshot_id,
  confirmedBy: row.confirmed_by,
  onBehalfOf: row.on_behalf_of,
  sourceTurnId: row.source_turn_id,
  confirmedAt: row.confirmed_at,
  endedBy: row.ended_by,
  endedAt: row.ended_at,
  endReason: row.end_reason,
});

// 不能出现在一条标准里的字符：换行和行分隔符；控制字符（Cc，包括制表符和 NEL）和格式字符（Cf，包括双向控制字符和
// 零宽字符，它们能让显示的文字和存的不一样；审查 L4）。
const NOT_ONE_LINE = /[\n\r\u0085\u2028\u2029]/;
const CONTROL = /[\p{Cc}\p{Cf}]/u;

const invalid = (message: string) => new AcceptanceCriteriaError("invalid_input", message);

/** 一条标准的文字：去掉首尾空白，一行，没有控制字符，不像密钥，不超过上限。 */
export function normalizeCriterionText(raw: unknown, field = "criterion"): string {
  if (typeof raw !== "string") throw invalid(`${field} must be a string`);
  const text = raw.trim();
  if (!text) throw invalid(`${field} must not be empty`);
  if (text.length > ACCEPTANCE_CRITERIA_LIMITS.textMaxLength) {
    throw invalid(`${field} has ${text.length} characters; a criterion has at most ${ACCEPTANCE_CRITERIA_LIMITS.textMaxLength}. `
      + "Write one checkable statement per criterion.");
  }
  if (NOT_ONE_LINE.test(text)) throw invalid(`${field} must be one line: it contains a line break. Make each line its own criterion.`);
  if (CONTROL.test(text)) throw invalid(`${field} contains a control or invisible formatting character`);
  if (redactSecretText(text) !== text) {
    throw invalid(`${field} looks like it contains a secret; remove it and name the secret instead of writing its value`);
  }
  return text;
}

function assertDistinct(texts: string[], field: string): void {
  const seen = new Set<string>();
  for (const text of texts) {
    if (seen.has(text)) throw invalid(`${field} has a duplicate criterion: ${JSON.stringify(text)}`);
    seen.add(text);
  }
}

function assertCount(count: number, field: string): void {
  if (count > ACCEPTANCE_CRITERIA_LIMITS.maxCriteria) {
    throw invalid(`${field} would have ${count} criteria; a ticket has at most ${ACCEPTANCE_CRITERIA_LIMITS.maxCriteria}. `
      + "Merge related criteria into one.");
  }
}

/** 一组新标准的文字（建单、拆子工单时）。可以是空数组。 */
export function normalizeCriterionTexts(raw: unknown, field = "acceptance_criteria"): string[] {
  if (!Array.isArray(raw)) throw invalid(`${field} must be an array of strings`);
  assertCount(raw.length, field);
  const texts = raw.map((entry, index) => normalizeCriterionText(entry, `${field}[${index}]`));
  assertDistinct(texts, field);
  return texts;
}

function activeRows(db: Db, itemId: number): CriterionRow[] {
  return db.prepare(
    "SELECT * FROM item_acceptance_criteria WHERE item_id=? AND deleted_at IS NULL ORDER BY position, id",
  ).all(itemId) as CriterionRow[];
}

const stale = (message: string) => new AcceptanceCriteriaError("stale", `${message}. Reload the acceptance criteria and try again.`);

// 一版文字。建标准和改文字时各写一行。
function writeRevision(db: Db, input: { criterionId: number; revision: number; text: string; by: CriterionWriter; at: string }): void {
  db.prepare(
    "INSERT INTO item_acceptance_criterion_revisions (criterion_id, revision, text, written_by, written_at) VALUES (?, ?, ?, ?, ?)",
  ).run(input.criterionId, input.revision, input.text, input.by, input.at);
}

// 现在这次交付：最新的一次交付（最新的成果快照的执行 Run，和 04 的 ensureLatestDeliveryRecorded 一样），而且工单停在
// 待验收或已完成。返工中、没交付时为 null。
function liveDeliveryRun(db: Db, itemId: number): number | null {
  const item = db.prepare("SELECT stage FROM items WHERE id=?").get(itemId) as { stage: string } | undefined;
  if (item?.stage !== "review" && item?.stage !== "done") return null;
  return (db.prepare("SELECT MAX(executor_run_id) AS run_id FROM outcome_snapshots WHERE item_id=?")
    .get(itemId) as { run_id: number | null }).run_id;
}

function assertTask(db: Db, itemId: number): void {
  const item = db.prepare("SELECT kind FROM items WHERE id=?").get(itemId) as { kind: string } | undefined;
  if (!item) throw new AcceptanceCriteriaError("not_found", `item #${itemId} not found`);
  if (item.kind !== "task") throw invalid(`item #${itemId} is a ${item.kind}; only a task has acceptance criteria`);
}

/** 工单的验收标准，按顺序。includeDeleted 时也有删掉的（排在后面）。 */
export function listAcceptanceCriteria(db: Db, itemId: number, options: { includeDeleted?: boolean } = {}): AcceptanceCriterion[] {
  const rows = options.includeDeleted
    ? db.prepare(
        "SELECT * FROM item_acceptance_criteria WHERE item_id=? ORDER BY deleted_at IS NOT NULL, position, id",
      ).all(itemId) as CriterionRow[]
    : activeRows(db, itemId);
  return rows.map(criterionOf);
}

export function getAcceptanceCriterion(db: Db, id: number): AcceptanceCriterion | undefined {
  const row = db.prepare("SELECT * FROM item_acceptance_criteria WHERE id=?").get(id) as CriterionRow | undefined;
  return row ? criterionOf(row) : undefined;
}

/**
 * 写下新的标准，排在现有的后面。建单和拆子工单用，在调用方建工单的同一笔事务里。
 * by 是谁写的；执行 agent 写的带上它的 Run。
 */
export function addAcceptanceCriteria(
  db: Db,
  input: { itemId: number; texts: unknown; by: CriterionWriter; runId?: number | null; now?: Date },
): AcceptanceCriterion[] {
  const texts = normalizeCriterionTexts(input.texts);
  return db.transaction((): AcceptanceCriterion[] => {
    assertTask(db, input.itemId);
    const existing = activeRows(db, input.itemId);
    assertCount(existing.length + texts.length, "acceptance_criteria");
    assertDistinct([...existing.map((row) => row.text), ...texts], "acceptance_criteria");
    const at = (input.now ?? new Date()).toISOString();
    const insert = db.prepare(
      `INSERT INTO item_acceptance_criteria (item_id, position, text, created_by, created_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids = texts.map((text, index) => {
      const id = Number(insert.run(input.itemId, existing.length + index + 1, text, input.by, input.runId ?? null, at, at).lastInsertRowid);
      writeRevision(db, { criterionId: id, revision: 1, text, by: input.by, at });
      return id;
    });
    return ids.map((id) => getAcceptanceCriterion(db, id)!);
  })();
}

export interface AcceptanceCriteriaEditInput {
  itemId: number;
  // 加在最后。
  add?: unknown;
  // 改某一条的文字。和现在一样的文字不算改。revision 是页面看到的版本：给了就要和现在的一样。
  update?: Array<{ id: number; text: unknown; revision?: number }>;
  // 删掉（只标删除，行留着）。revision 同上。
  remove?: Array<{ id: number; revision?: number }>;
  // 保留下来的各条（不含 add）的新顺序：正好是删除以后剩下的那些 id。新加的排在它们后面。
  order?: number[];
  by: CriterionEditor;
  now?: Date;
}

export interface AcceptanceCriteriaEdit {
  // 有没有写下任何改动。什么都没变时为 false，什么都没写。
  changed: boolean;
  criteria: AcceptanceCriterion[];
  added: number[];
  edited: Array<{ id: number; from: string; to: string }>;
  removed: Array<{ id: number; text: string }>;
  reordered: boolean;
  // 因为这次改动结束的确认（id）。
  voided: number[];
}

function distinctIds(ids: number[], field: string): number[] {
  if (new Set(ids).size !== ids.length) throw invalid(`${field} lists the same criterion twice`);
  return ids;
}

/** Lead 或你改验收标准（工单操作 edit_acceptance_criteria）。一笔事务：要么全改，要么什么都不写。 */
export function editAcceptanceCriteria(db: Db, input: AcceptanceCriteriaEditInput): AcceptanceCriteriaEdit {
  const add = input.add === undefined ? [] : normalizeCriterionTexts(input.add, "add");
  const update = (input.update ?? []).map((entry, index) => ({
    id: entry.id, text: normalizeCriterionText(entry.text, `update[${index}].text`), revision: entry.revision,
  }));
  const removeEntries = input.remove ?? [];
  const remove = distinctIds(removeEntries.map((entry) => entry.id), "remove");
  distinctIds(update.map((entry) => entry.id), "update");
  if (!add.length && !update.length && !remove.length && input.order === undefined) {
    throw invalid("give at least one of add, update, remove or order");
  }
  for (const id of remove) {
    if (update.some((entry) => entry.id === id)) throw invalid(`criterion ${id} is in both update and remove`);
  }
  return db.transaction((): AcceptanceCriteriaEdit => {
    assertTask(db, input.itemId);
    const current = activeRows(db, input.itemId);
    const byId = new Map(current.map((row) => [row.id, row]));
    for (const entry of [...update, ...removeEntries]) {
      if (!byId.has(entry.id)) criterionGone(db, input.itemId, entry.id);
      const row = byId.get(entry.id)!;
      if (entry.revision !== undefined && entry.revision !== row.revision) {
        throw stale(`criterion ${entry.id} is at revision ${row.revision}, not ${entry.revision}: someone changed it`);
      }
    }
    const kept = current.filter((row) => !remove.includes(row.id));
    let order = kept.map((row) => row.id);
    if (input.order !== undefined) {
      const wanted = distinctIds(input.order, "order");
      if (wanted.length !== order.length || wanted.some((id) => !order.includes(id))) {
        throw stale(`order must list exactly the criteria that stay, in their new order: ${order.join(", ") || "(none)"}`);
      }
      order = wanted;
    }
    const finalTexts = new Map(kept.map((row) => [row.id, row.text]));
    for (const entry of update) finalTexts.set(entry.id, entry.text);
    assertCount(order.length + add.length, "the edit");
    assertDistinct([...order.map((id) => finalTexts.get(id)!), ...add], "the edit");

    const edited = update
      .filter((entry) => byId.get(entry.id)!.text !== entry.text)
      .map((entry) => ({ id: entry.id, from: byId.get(entry.id)!.text, to: entry.text }));
    const removed = remove.map((id) => ({ id, text: byId.get(id)!.text }));
    const reordered = order.some((id, index) => byId.get(id)!.position !== index + 1);
    if (!add.length && !edited.length && !removed.length && !reordered) {
      return { changed: false, criteria: current.map(criterionOf), added: [], edited: [], removed: [], reordered: false, voided: [] };
    }

    const at = (input.now ?? new Date()).toISOString();
    const voided: number[] = [];
    // 只作废现在这次交付上的确认。更早的交付、返工中的上一次交付是历史（审查 M4）。
    const latestRun = liveDeliveryRun(db, input.itemId);
    const endActive = (criterionId: number, reason: ConfirmationEndReason) => {
      const rows = db.prepare(
        "SELECT id FROM criterion_confirmations WHERE criterion_id=? AND executor_run_id IS ? AND ended_at IS NULL ORDER BY id",
      ).all(criterionId, latestRun) as Array<{ id: number }>;
      for (const row of rows) {
        db.prepare("UPDATE criterion_confirmations SET ended_by=?, ended_at=?, end_reason=? WHERE id=?")
          .run(input.by, at, reason, row.id);
        voided.push(row.id);
      }
    };
    for (const entry of edited) {
      db.prepare(
        `UPDATE item_acceptance_criteria SET text=?, revision=revision+1, edited_by=?, edited_at=?, updated_at=? WHERE id=?`,
      ).run(entry.to, input.by, at, at, entry.id);
      writeRevision(db, { criterionId: entry.id, revision: byId.get(entry.id)!.revision + 1, text: entry.to, by: input.by, at });
      endActive(entry.id, "criterion_edited");
    }
    for (const entry of removed) {
      db.prepare("UPDATE item_acceptance_criteria SET deleted_by=?, deleted_at=?, updated_at=? WHERE id=?")
        .run(input.by, at, at, entry.id);
      endActive(entry.id, "criterion_deleted");
    }
    // 没删的从 1 连续编号。只改位置变了的行。
    order.forEach((id, index) => {
      if (byId.get(id)!.position !== index + 1) {
        db.prepare("UPDATE item_acceptance_criteria SET position=?, updated_at=? WHERE id=?").run(index + 1, at, id);
      }
    });
    const insert = db.prepare(
      `INSERT INTO item_acceptance_criteria (item_id, position, text, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const added = add.map((text, index) => {
      const id = Number(insert.run(input.itemId, order.length + index + 1, text, input.by, at, at).lastInsertRowid);
      writeRevision(db, { criterionId: id, revision: 1, text, by: input.by, at });
      return id;
    });
    return {
      changed: true,
      criteria: activeRows(db, input.itemId).map(criterionOf),
      added, edited, removed, reordered, voided,
    };
  }).immediate();
}

function activeConfirmation(db: Db, criterionId: number, executorRunId: number): ConfirmationRow | undefined {
  return db.prepare(
    "SELECT * FROM criterion_confirmations WHERE criterion_id=? AND executor_run_id=? AND ended_at IS NULL",
  ).get(criterionId, executorRunId) as ConfirmationRow | undefined;
}

// 不是现在的标准：这张工单的、已经删了的，是页面过时了（stale）；不是这张工单的，是没有这一条（not_found）。
function criterionGone(db: Db, itemId: number, criterionId: number): never {
  const row = db.prepare("SELECT item_id FROM item_acceptance_criteria WHERE id=?").get(criterionId) as { item_id: number } | undefined;
  if (row?.item_id === itemId) throw stale(`criterion ${criterionId} has been deleted`);
  throw new AcceptanceCriteriaError("not_found", `criterion ${criterionId} is not an acceptance criterion of item #${itemId}`);
}

function activeCriterionOf(db: Db, itemId: number, criterionId: number): CriterionRow {
  const row = db.prepare("SELECT * FROM item_acceptance_criteria WHERE id=?").get(criterionId) as CriterionRow | undefined;
  if (!row || row.item_id !== itemId || row.deleted_at !== null) criterionGone(db, itemId, criterionId);
  return row;
}

/**
 * 你确认某次交付做到了某一条（工单操作 confirm_criterion）。这一条在这次交付上已经确认过时不另记，changed=false。
 * Lead 代你确认时 by='lead'，onBehalfOf 写明凭哪一轮（表上的 CHECK 也要求这一点）。
 */
export function confirmCriterion(
  db: Db,
  input: {
    itemId: number; criterionId: number; executorRunId: number; deliverySnapshotId: number;
    by: "user" | "lead"; onBehalfOf?: { sourceTurnId: string } | null; now?: Date;
  },
): { confirmation: CriterionConfirmation; changed: boolean } {
  return db.transaction(() => {
    const criterion = activeCriterionOf(db, input.itemId, input.criterionId);
    const snapshot = db.prepare("SELECT item_id, executor_run_id FROM delivery_snapshots WHERE id=?")
      .get(input.deliverySnapshotId) as { item_id: number; executor_run_id: number } | undefined;
    if (!snapshot || snapshot.item_id !== input.itemId || snapshot.executor_run_id !== input.executorRunId) {
      throw invalid(`delivery snapshot ${input.deliverySnapshotId} is not a snapshot of run #${input.executorRunId} of item #${input.itemId}`);
    }
    const existing = activeConfirmation(db, criterion.id, input.executorRunId);
    if (existing) return { confirmation: confirmationOf(existing), changed: false };
    const behalf = input.by === "lead" ? input.onBehalfOf ?? null : null;
    const id = Number(db.prepare(
      `INSERT INTO criterion_confirmations (item_id, criterion_id, criterion_revision, executor_run_id, delivery_snapshot_id,
         confirmed_by, on_behalf_of, source_turn_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.itemId, criterion.id, criterion.revision, input.executorRunId, input.deliverySnapshotId, input.by,
      behalf ? "user" : null, behalf?.sourceTurnId ?? null, (input.now ?? new Date()).toISOString(),
    ).lastInsertRowid);
    const row = db.prepare("SELECT * FROM criterion_confirmations WHERE id=?").get(id) as ConfirmationRow;
    return { confirmation: confirmationOf(row), changed: true };
  }).immediate();
}

/** 取消你在某次交付上对某一条的确认（工单操作 unconfirm_criterion）。没有确认时不写，changed=false。 */
export function unconfirmCriterion(
  db: Db,
  input: { itemId: number; criterionId: number; executorRunId: number; by: CriterionEditor; now?: Date },
): { confirmation: CriterionConfirmation | null; changed: boolean } {
  return db.transaction(() => {
    activeCriterionOf(db, input.itemId, input.criterionId);
    const existing = activeConfirmation(db, input.criterionId, input.executorRunId);
    if (!existing) return { confirmation: null, changed: false };
    db.prepare("UPDATE criterion_confirmations SET ended_by=?, ended_at=?, end_reason='unconfirmed' WHERE id=?")
      .run(input.by, (input.now ?? new Date()).toISOString(), existing.id);
    const row = db.prepare("SELECT * FROM criterion_confirmations WHERE id=?").get(existing.id) as ConfirmationRow;
    return { confirmation: confirmationOf(row), changed: true };
  }).immediate();
}

/** 某次交付上的全部确认，包括结束了的，按先后排。 */
export function listCriterionConfirmations(db: Db, input: { itemId: number; executorRunId: number }): CriterionConfirmation[] {
  return (db.prepare(
    "SELECT * FROM criterion_confirmations WHERE item_id=? AND executor_run_id=? ORDER BY id",
  ).all(input.itemId, input.executorRunId) as ConfirmationRow[]).map(confirmationOf);
}

export interface CriterionRevision {
  criterionId: number;
  revision: number;
  text: string;
  writtenBy: CriterionWriter;
  writtenAt: string;
}

/** 一条标准的每一版文字，从第 1 版起。 */
export function listCriterionRevisions(db: Db, criterionId: number): CriterionRevision[] {
  return (db.prepare(
    "SELECT * FROM item_acceptance_criterion_revisions WHERE criterion_id=? ORDER BY revision",
  ).all(criterionId) as Array<{ criterion_id: number; revision: number; text: string; written_by: CriterionWriter; written_at: string }>)
    .map((row) => ({
      criterionId: row.criterion_id, revision: row.revision, text: row.text, writtenBy: row.written_by, writtenAt: row.written_at,
    }));
}

// ── 执行者看到的版本（审查 M2）──────────────────────────────────────────────────────

export interface ExecutorCriteriaView {
  runId: number;
  itemId: number;
  // 提示里的每一条和它的版本，按编号排。工单当时没有标准时是空数组。
  criteria: Array<{ id: number; revision: number }>;
  seenAt: string;
}

/**
 * 记下执行者这次启动时在提示里看到的标准（engine 的 acceptanceCriteriaPromptSection 写提示的同一刻）。
 * 一个 Run 开新会话重试时再记一次，以最后一次为准：新会话只看到最后那一份提示。
 */
export function recordExecutorCriteriaView(
  db: Db,
  input: { itemId: number; runId: number; criteria: Array<{ id: number; revision: number }>; now?: Date },
): void {
  db.prepare(
    `INSERT INTO executor_criteria_views (run_id, item_id, criteria_json, seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET criteria_json=excluded.criteria_json, seen_at=excluded.seen_at`,
  ).run(
    input.runId, input.itemId, JSON.stringify(input.criteria.map(({ id, revision }) => ({ id, revision }))),
    (input.now ?? new Date()).toISOString(),
  );
}

/** 这个执行 Run 看到的标准。v54 以前的 Run、或者不是执行者的 Run 没有记录，为 undefined。 */
export function getExecutorCriteriaView(db: Db, runId: number): ExecutorCriteriaView | undefined {
  const row = db.prepare("SELECT * FROM executor_criteria_views WHERE run_id=?")
    .get(runId) as { run_id: number; item_id: number; criteria_json: string; seen_at: string } | undefined;
  if (!row) return undefined;
  return {
    runId: row.run_id, itemId: row.item_id, seenAt: row.seen_at,
    criteria: JSON.parse(row.criteria_json) as Array<{ id: number; revision: number }>,
  };
}
