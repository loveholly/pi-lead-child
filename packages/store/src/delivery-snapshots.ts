// 交付快照（v52，工单 04，spec 5.5、D8）。表的说明在 schema.ts 的 DELIVERY_SNAPSHOTS_SCHEMA。
// 这里只管存和取：第几次交付、第几份由这里在一笔事务里定，调用方不传。git diff 由 engine 的 delivery-snapshot.ts 跑。
import type { Db } from "./db.js";

export type DeliverySnapshotReason = "delivered" | "workspace_changed";
export type DeliverySnapshotSource = "git" | "agent";
export type DeliverySnapshotFileStatus = "added" | "modified" | "deleted" | "renamed" | "unchanged";
// 按路径认出来的 lock 文件和生成的文件（engine 的 deliveryGeneratedKind）。界面默认收起它们。
export type DeliveryGeneratedKind = "lock" | "generated";
// 存这一份时刚结束的 Run 是做什么的（工单 04 审查 L3）。
export type DeliverySnapshotTriggerKind = "conversation" | "review" | "execution" | "other";

export interface DeliverySnapshotFile {
  path: string;
  previousPath: string | null;
  // source=agent 时为 null：agent 只报了文件，没有报状态。
  status: DeliverySnapshotFileStatus | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  // 执行 agent 在成果里给这个文件起的名字（deliverables 的 label）和写的说明（changes 的 summary）。
  label: string | null;
  note: string | null;
  generated: DeliveryGeneratedKind | null;
}

export interface DeliverySnapshotCommit {
  sha: string;
  subject: string;
}

export interface DeliverySnapshotTotals {
  files: number;
  additions: number;
  deletions: number;
}

export interface DeliverySnapshot {
  id: number;
  itemId: number;
  sequence: number;
  revision: number;
  executorRunId: number;
  outcomeSnapshotId: number | null;
  reason: DeliverySnapshotReason;
  source: DeliverySnapshotSource;
  backfilled: boolean;
  triggerRunId: number | null;
  triggerKind: DeliverySnapshotTriggerKind | null;
  workspaceId: number | null;
  baseSha: string | null;
  headSha: string | null;
  commits: DeliverySnapshotCommit[];
  commitCount: number;
  files: DeliverySnapshotFile[];
  // source=agent 时为 null：没有行数。
  totals: DeliverySnapshotTotals | null;
  truncated: boolean;
  uncommittedFiles: number | null;
  createdAt: string;
}

// 列表用：不带文件列表和提交列表（一份快照最多 2000 个文件）。
export type DeliverySnapshotHeader = Omit<DeliverySnapshot, "files" | "commits">;

export interface RecordDeliverySnapshotInput {
  itemId: number;
  executorRunId: number;
  outcomeSnapshotId?: number | null;
  reason: DeliverySnapshotReason;
  source: DeliverySnapshotSource;
  backfilled?: boolean;
  triggerRunId?: number | null;
  triggerKind?: DeliverySnapshotTriggerKind | null;
  workspaceId?: number | null;
  baseSha: string | null;
  headSha: string | null;
  commits: DeliverySnapshotCommit[];
  commitCount: number;
  files: DeliverySnapshotFile[];
  totals: DeliverySnapshotTotals | null;
  truncated: boolean;
  uncommittedFiles: number | null;
  now?: Date;
}

export interface RecordDeliverySnapshotResult {
  // 没有存时（见 skipped）是已有的那一份，或者 null。
  snapshot: DeliverySnapshot | null;
  created: boolean;
  // duplicate：这次交付已经有 delivered，或者工作区和最新一份一样；superseded：已经有更新的交付，不再给旧的交付存。
  skipped: "duplicate" | "superseded" | null;
}

interface DeliverySnapshotRow {
  id: number;
  item_id: number;
  sequence: number;
  revision: number;
  executor_run_id: number;
  outcome_snapshot_id: number | null;
  reason: DeliverySnapshotReason;
  source: DeliverySnapshotSource;
  backfilled: number;
  trigger_run_id: number | null;
  trigger_kind: DeliverySnapshotTriggerKind | null;
  workspace_id: number | null;
  base_sha: string | null;
  head_sha: string | null;
  commits_json?: string;
  commit_count: number;
  files_json?: string;
  file_count: number | null;
  additions: number | null;
  deletions: number | null;
  truncated: number;
  uncommitted_files: number | null;
  created_at: string;
}

const HEADER_COLUMNS = `id, item_id, sequence, revision, executor_run_id, outcome_snapshot_id, reason, source, backfilled,
  trigger_run_id, trigger_kind, workspace_id, base_sha, head_sha, commit_count, file_count, additions, deletions, truncated,
  uncommitted_files, created_at`;

function parseJsonArray<T>(text: string | undefined): T[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function headerOf(row: DeliverySnapshotRow): DeliverySnapshotHeader {
  return {
    id: row.id,
    itemId: row.item_id,
    sequence: row.sequence,
    revision: row.revision,
    executorRunId: row.executor_run_id,
    outcomeSnapshotId: row.outcome_snapshot_id,
    reason: row.reason,
    source: row.source,
    backfilled: row.backfilled === 1,
    triggerRunId: row.trigger_run_id,
    triggerKind: row.trigger_kind,
    workspaceId: row.workspace_id,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    commitCount: row.commit_count,
    totals: row.file_count === null
      ? null
      : { files: row.file_count, additions: row.additions ?? 0, deletions: row.deletions ?? 0 },
    truncated: row.truncated === 1,
    uncommittedFiles: row.uncommitted_files,
    createdAt: row.created_at,
  };
}

function snapshotOf(row: DeliverySnapshotRow): DeliverySnapshot {
  return {
    ...headerOf(row),
    commits: parseJsonArray<DeliverySnapshotCommit>(row.commits_json),
    files: parseJsonArray<DeliverySnapshotFile>(row.files_json),
  };
}

export function getDeliverySnapshot(db: Db, id: number): DeliverySnapshot | undefined {
  const row = db.prepare("SELECT * FROM delivery_snapshots WHERE id=?").get(id) as DeliverySnapshotRow | undefined;
  return row ? snapshotOf(row) : undefined;
}

/** 工单最新的一份快照：最后一次交付的最后一份。 */
export function getLatestDeliverySnapshot(db: Db, itemId: number): DeliverySnapshot | undefined {
  const row = db.prepare(
    "SELECT * FROM delivery_snapshots WHERE item_id=? ORDER BY sequence DESC, revision DESC LIMIT 1",
  ).get(itemId) as DeliverySnapshotRow | undefined;
  return row ? snapshotOf(row) : undefined;
}

/** 第 sequence 次交付的一份快照。不给 revision 时取这次交付最新的一份。 */
export function getDeliverySnapshotBySequence(
  db: Db, itemId: number, sequence: number, revision?: number,
): DeliverySnapshot | undefined {
  const row = (revision === undefined
    ? db.prepare(
        "SELECT * FROM delivery_snapshots WHERE item_id=? AND sequence=? ORDER BY revision DESC LIMIT 1",
      ).get(itemId, sequence)
    : db.prepare(
        "SELECT * FROM delivery_snapshots WHERE item_id=? AND sequence=? AND revision=?",
      ).get(itemId, sequence, revision)) as DeliverySnapshotRow | undefined;
  return row ? snapshotOf(row) : undefined;
}

/** 一个执行 Run 交付时存的那一份。 */
export function getDeliveredSnapshotForRun(db: Db, executorRunId: number): DeliverySnapshot | undefined {
  const row = db.prepare(
    "SELECT * FROM delivery_snapshots WHERE executor_run_id=? AND reason='delivered'",
  ).get(executorRunId) as DeliverySnapshotRow | undefined;
  return row ? snapshotOf(row) : undefined;
}

/** 工单的全部快照，按交付和份数排，不带文件列表。 */
export function listDeliverySnapshotHeaders(db: Db, itemId: number): DeliverySnapshotHeader[] {
  return (db.prepare(
    `SELECT ${HEADER_COLUMNS} FROM delivery_snapshots WHERE item_id=? ORDER BY sequence, revision`,
  ).all(itemId) as DeliverySnapshotRow[]).map(headerOf);
}

/**
 * 存一份快照。第几次交付、第几份在同一笔事务里定：
 * - delivered：这个执行 Run 已经有一份时不再存（重放的 ticket_update、交付后 Run 结束时的补查）。
 *   工单已经有更新的交付时也不存：旧的交付不能排到新的后面。
 * - workspace_changed：存进最新一次交付。和这次交付最新的一份比，head 和没提交的文件数都一样时不存。
 *   没提交的文件数有一边不知道（null）时只比 head。
 *   executorRunId 不是最新一次交付时不存（返工已经交付了新的）。
 */
export function recordDeliverySnapshot(db: Db, input: RecordDeliverySnapshotInput): RecordDeliverySnapshotResult {
  return db.transaction((): RecordDeliverySnapshotResult => {
    const latest = getLatestDeliverySnapshot(db, input.itemId);
    let sequence: number;
    let revision: number;
    if (input.reason === "delivered") {
      const existing = getDeliveredSnapshotForRun(db, input.executorRunId);
      if (existing) return { snapshot: existing, created: false, skipped: "duplicate" };
      if (latest && latest.executorRunId > input.executorRunId) return { snapshot: latest, created: false, skipped: "superseded" };
      sequence = (latest?.sequence ?? 0) + 1;
      revision = 1;
    } else {
      if (!latest || latest.executorRunId !== input.executorRunId) {
        return { snapshot: latest ?? null, created: false, skipped: "superseded" };
      }
      const sameCount = latest.uncommittedFiles === null || input.uncommittedFiles === null
        || latest.uncommittedFiles === input.uncommittedFiles;
      if (latest.headSha === input.headSha && sameCount) {
        return { snapshot: latest, created: false, skipped: "duplicate" };
      }
      sequence = latest.sequence;
      revision = latest.revision + 1;
    }
    const id = Number(db.prepare(
      `INSERT INTO delivery_snapshots (
         item_id, sequence, revision, executor_run_id, outcome_snapshot_id, reason, source, backfilled, trigger_run_id,
         trigger_kind, workspace_id, base_sha, head_sha, commits_json, commit_count, files_json, file_count, additions,
         deletions, truncated, uncommitted_files, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.itemId, sequence, revision, input.executorRunId, input.outcomeSnapshotId ?? null, input.reason, input.source,
      input.backfilled ? 1 : 0, input.triggerRunId ?? null, input.triggerKind ?? null, input.workspaceId ?? null,
      input.baseSha, input.headSha,
      JSON.stringify(input.commits), input.commitCount, JSON.stringify(input.files),
      input.totals?.files ?? null, input.totals?.additions ?? null, input.totals?.deletions ?? null,
      input.truncated ? 1 : 0, input.uncommittedFiles, (input.now ?? new Date()).toISOString(),
    ).lastInsertRowid);
    return { snapshot: getDeliverySnapshot(db, id)!, created: true, skipped: null };
  }).immediate();
}
