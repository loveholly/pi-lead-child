// 交付快照（工单 04，spec 5.5、D8）。交付视图以前每次打开都跑 git diff：worktree 和分支清掉以后，文件列表就没了。
// 现在由系统在这几个时刻跑 diff，存进工单（store 的 delivery_snapshots）：
// - 交付：执行 agent 调 ticket_update(status='review') 被接受的那一刻（recordDeliveryAtHandoff）。diff 由系统跑，
//   不用 agent 报的文件：agent 报的可能漏或错，git 的结果是确定的。工具只等几秒，钉住分支头和没提交的文件数，
//   diff 按钉住的提交在后台跑（审查 M1：以前等满 30 秒，正好是 agent 调宿主工具的时限，git 一慢 agent 就报交付失败）。
// - Run 结束时再查一次：成果是从输出里恢复的（没有调 ticket_update）时，这里补上（refreshDeliveryAfterRun）。
// - 交付以后工作区又变了：Run 结束、或者打开交付视图时，发现分支头或没提交的文件数和最新一份不一样，
//   同一次交付再存一份，原因记为 workspace_changed。比的是 git 的事实（分支头、git status），不依赖 review-currency
//   的指纹：那边只在有当前核查结论时才量，没有结论或者工单已完成时，对话改了工作区，文件列表也要跟上。
// - 补存：最新的成果没有快照时（v52 以前的交付，或者交付时没存成），打开交付视图或者别的 Run 结束时补存一份，
//   标成 backfilled：那时的分支头可能已经包含交付以后的改动（审查 M3）。
// 工作区不是隔离分支的工单：没有基线可比，只记执行 agent 报的文件（source=agent）。
//
// 同一张工单的快照一次只抓一份（serial）：两次抓取不会交错写入，打开交付视图时也等正在抓的那一份（审查 L1、L2）。
// git 算不出文件列表时（改动太大、超时、出错），按分支头记一条失败。同一个分支头不马上重试：改动太大时不再重试，
// 超时和别的错误 10 分钟以后再试（审查 M4）。交付视图按这条记录写合并为什么不可用。
//
// 排序：执行 agent 列过的文件（有名字或说明的）排在前面，按它给的顺序；其余按 git 的顺序；lock 文件和生成的文件排在最后。
// lock 文件和生成的文件只按一份固定的路径规则认（deliveryGeneratedKind），不看文件内容，也不判断自然语言。
import type {
  DeliveryGeneratedKind, DeliverySnapshot, DeliverySnapshotCommit, DeliverySnapshotFile, DeliverySnapshotTriggerKind,
  OutcomeSnapshot, RecordDeliverySnapshotResult, Db,
} from "@pi-lead-child/store";
import {
  addActivity, getDeliveredSnapshotForRun, getItem, getLatestDeliverySnapshot, getLatestOutcomeSnapshot,
  getOutcomeSnapshotForRun, getRun, isDeliveryRun, recordDeliverySnapshot,
} from "@pi-lead-child/store";
import type { Item, ItemStage, Workspace } from "@pi-lead-child/core";
import { redactSecretText } from "@pi-lead-child/protocol";
import {
  activeRuns, deliveryWorkspace, diffEntries, firstLine, GitCommandError, gitRun, normalizeDeliveryPath, redact,
  uncommittedFileCount, workspaceHead, type DiffEntry, type GitFailureKind,
} from "./delivery-source.js";

// 交付最多列这么多文件（协议的 files maxItems）。再多就截断：客户端严格校验，多一个文件整个交付页都加载不出来
// （2026-10-21 审查 L1）。成果里列的文件排在前面，不会被截掉。
export const DELIVERY_MAX_FILES = 2000;
// 快照里最多记这么多个提交。commitCount 照样数全部。
export const DELIVERY_MAX_COMMITS = 200;
const COMMIT_SUBJECT_MAX = 300;
// 交付时钉住分支头和没提交的文件数，每条 git 命令最多等这么久。要远小于 agent 调宿主工具的时限
// （agent-tools/tool-timeouts.ts 的 HOST_AGENT_TOOL_TIMEOUT_MS），测试核对这一条。
export const HANDOFF_PIN_BUDGET_MS = 5_000;
// 超时和别的 git 错误，同一个分支头隔这么久再试。改动太大时不再试，分支头变了才再算。
const FAILURE_RETRY_MINUTES = 10;

// 给用户看的失败原因。git 的原文只记在活动里（去掉服务器路径）。
export const DELIVERY_CAPTURE_FAILURE_TEXT: Record<GitFailureKind, string> = {
  too_large: "改动太大，系统算不出文件列表。",
  timeout: "git 算文件列表超时了。",
  error: "git 算文件列表时出错了。",
};

// ── lock 文件和生成的文件：固定的路径规则 ─────────────────────────────────────────────

// 包管理器的 lock 文件，按文件名（小写）认。
const LOCK_FILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "deno.lock",
  "cargo.lock", "gemfile.lock", "poetry.lock", "pipfile.lock", "pdm.lock", "uv.lock", "pixi.lock", "composer.lock",
  "go.sum", "go.work.sum", "mix.lock", "podfile.lock", "pubspec.lock", "flake.lock", "packages.lock.json",
  "gradle.lockfile", "package.resolved", "cartfile.resolved",
]);
// 构建产物、依赖和测试快照的目录，路径里任何一段是它就算（小写）。
const GENERATED_DIRECTORIES = new Set([
  "dist", "build", "out", "coverage", "node_modules", "vendor", ".next", ".nuxt", ".svelte-kit", ".turbo", ".expo",
  "__generated__", "generated", "__snapshots__",
]);
// 生成的文件的文件名结尾（小写）。
const GENERATED_SUFFIXES = [
  ".min.js", ".min.css", ".map", ".snap", ".pb.go", "_pb2.py", "_pb2_grpc.py", ".pb.h", ".pb.cc", ".g.dart",
  ".freezed.dart", ".designer.cs",
];
// 文件名里带这一段的（例如 schema.generated.ts、api.gen.ts）。
const GENERATED_INFIXES = [".generated.", ".gen."];

/** lock 文件和生成的文件只按路径认。都不是时返回 null。 */
export function deliveryGeneratedKind(path: string): DeliveryGeneratedKind | null {
  const segments = path.toLowerCase().split("/");
  const name = segments[segments.length - 1] ?? "";
  if (LOCK_FILE_NAMES.has(name)) return "lock";
  if (segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))) return "generated";
  if (GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "generated";
  if (GENERATED_INFIXES.some((infix) => name.includes(infix))) return "generated";
  return null;
}

// ── 执行 agent 对文件写的名字和说明 ─────────────────────────────────────────────────

interface AgentFileNotes {
  labels: Map<string, string>;
  notes: Map<string, string>;
  // 执行 agent 列过的文件，按它给的顺序：先 deliverables，再 changes 里没出现过的。
  order: string[];
}

function agentFileNotes(outcome: OutcomeSnapshot | null): AgentFileNotes {
  const labels = new Map<string, string>();
  const notes = new Map<string, string>();
  const order: string[] = [];
  for (const deliverable of outcome?.deliverables ?? []) {
    const path = deliverable.kind === "path" || deliverable.kind === "artifact" ? normalizeDeliveryPath(deliverable.ref) : null;
    if (!path) continue;
    if (!labels.has(path)) order.push(path);
    labels.set(path, deliverable.label);
  }
  for (const change of outcome?.changes ?? []) {
    const path = change.kind === "file" ? normalizeDeliveryPath(change.ref) : null;
    if (!path) continue;
    if (change.summary) notes.set(path, change.summary);
    if (!labels.has(path) && !order.includes(path)) order.push(path);
  }
  return { labels, notes, order };
}

/** 列过的文件按执行 agent 给的顺序排在前面；其余按原来的顺序；lock 文件和生成的文件排在最后。 */
export function orderDeliveryFiles<T extends { path: string; generated: DeliveryGeneratedKind | null }>(
  files: T[], agentOrder: string[],
): T[] {
  const rank = (file: T) => {
    const index = agentOrder.indexOf(file.path);
    if (index !== -1) return index;
    return file.generated ? agentOrder.length + 1 : agentOrder.length;
  };
  return files.map((file, index) => ({ file, index }))
    .sort((left, right) => rank(left.file) - rank(right.file) || left.index - right.index)
    .map(({ file }) => file);
}

// ── 抓一份快照 ─────────────────────────────────────────────────────────────────────

type SnapshotContent = Pick<
  Parameters<typeof recordDeliverySnapshot>[1],
  "source" | "workspaceId" | "baseSha" | "headSha" | "commits" | "commitCount" | "files" | "totals" | "truncated" | "uncommittedFiles"
>;

// 名字和说明是 agent 写的：存之前脱敏，和提交说明一样（审查 L6）。
function snapshotFile(entry: Pick<DiffEntry, "path" | "previousPath" | "additions" | "deletions" | "binary">
  & { status: DeliverySnapshotFile["status"] }, notes: AgentFileNotes): DeliverySnapshotFile {
  const label = notes.labels.get(entry.path);
  const note = notes.notes.get(entry.path);
  return {
    path: entry.path, previousPath: entry.previousPath, status: entry.status,
    additions: entry.additions, deletions: entry.deletions, binary: entry.binary,
    label: label === undefined ? null : redactSecretText(label), note: note === undefined ? null : redactSecretText(note),
    generated: deliveryGeneratedKind(entry.path),
  };
}

// 执行 agent 报的文件：不是隔离分支的工单，或者隔离分支已经找不到了。
function agentContent(outcome: OutcomeSnapshot | null, workspaceId: number | null): SnapshotContent {
  const notes = agentFileNotes(outcome);
  const files = notes.order.map((path) => snapshotFile(
    { path, previousPath: null, status: null, additions: null, deletions: null, binary: false }, notes,
  ));
  return {
    source: "agent", workspaceId, baseSha: null, headSha: null, commits: [], commitCount: 0,
    files: files.slice(0, DELIVERY_MAX_FILES), totals: null, truncated: files.length > DELIVERY_MAX_FILES,
    uncommittedFiles: null,
  };
}

async function commitList(repo: string, base: string, head: string): Promise<{ commits: DeliverySnapshotCommit[]; count: number }> {
  const [log, count] = await Promise.all([
    gitRun(["log", "-z", `--max-count=${DELIVERY_MAX_COMMITS}`, "--format=%H%x1f%s", `${base}..${head}`], repo),
    gitRun(["rev-list", "--count", `${base}..${head}`], repo),
  ]);
  const commits = log.ok
    ? log.stdout.split("\0").filter(Boolean).map((record) => {
        const [sha = "", subject = ""] = record.replace(/^\n/, "").split("\x1f");
        // 提交说明是 agent 写的：存之前脱敏，截短。
        return { sha, subject: redactSecretText(subject).slice(0, COMMIT_SUBJECT_MAX) };
      }).filter((commit) => /^[0-9a-f]{40,64}$/.test(commit.sha))
    : [];
  return { commits, count: count.ok ? Number(count.stdout.trim()) || commits.length : commits.length };
}

let diff: typeof diffEntries = diffEntries;

/** 测试用：换掉算文件列表的 diff，例如让它卡住或者报「改动太大」。不传参数时恢复默认。 */
export function setDeliveryDiffForTesting(replacement?: typeof diffEntries): void {
  diff = replacement ?? diffEntries;
}

/** 算 base..head 的文件列表（diffEntries；测试可以换掉）。交付视图给交付以前就取消的工单现读时也用它。 */
export function deliveryDiff(repo: string, base: string, head: string): ReturnType<typeof diffEntries> {
  return diff(repo, base, head);
}

// 隔离分支上的交付：base..head 的 diff。算不出来时抛 GitCommandError。
async function gitContent(
  workspace: Workspace, outcome: OutcomeSnapshot | null, head: string, uncommittedFiles: number | null,
): Promise<SnapshotContent> {
  const base = workspace.base_ref!;
  const repo = workspace.repo_root!;
  const notes = agentFileNotes(outcome);
  const [entries, commits] = await Promise.all([diff(repo, base, head), commitList(repo, base, head)]);
  const files = entries.map((entry) => snapshotFile(entry, notes));
  // 列为交付物、但这次没有改的文件（例如引用的现有文档）：能看全文，没有改动可看。
  for (const path of notes.order) {
    if (files.some((file) => file.path === path)) continue;
    if (!(await gitRun(["cat-file", "-e", `${head}:${path}`], repo)).ok) continue;
    files.push(snapshotFile({ path, previousPath: null, status: "unchanged", additions: null, deletions: null, binary: false }, notes));
  }
  const ordered = orderDeliveryFiles(files, notes.order);
  const changed = ordered.filter((file) => file.status !== "unchanged");
  return {
    source: "git", workspaceId: workspace.id, baseSha: base, headSha: head,
    commits: commits.commits, commitCount: commits.count,
    files: ordered.slice(0, DELIVERY_MAX_FILES), truncated: ordered.length > DELIVERY_MAX_FILES,
    totals: {
      files: changed.length,
      additions: changed.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: changed.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
    uncommittedFiles,
  };
}

// ── 失败的记录 ─────────────────────────────────────────────────────────────────────

export interface DeliveryCaptureFailure {
  kind: GitFailureKind;
  head: string | null;
  // 给用户看的原因（DELIVERY_CAPTURE_FAILURE_TEXT）。
  text: string;
}

// git 的报错里可能有服务器上的路径：换成占位符。
function scrubbed(db: Db, itemId: number, error: unknown): string {
  const workspace = deliveryWorkspace(db, itemId);
  let text = redact(firstLine(String(error instanceof Error ? error.message : error)));
  for (const [path, placeholder] of [[workspace?.path, "<worktree>"], [workspace?.repo_root, "<repo>"]] as const) {
    if (path) text = text.split(path).join(placeholder);
  }
  return text.slice(0, 300);
}

const FAILURE_SQL = `SELECT payload, created_at FROM activities
  WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='delivery_snapshot_failed'
    AND json_extract(payload, '$.head') IS ?`;

// 算不出文件列表：按分支头记一条。它自己从不抛错。
function recordGitFailure(
  db: Db, input: { itemId: number; executorRunId: number; reason: string; head: string; error: GitCommandError },
): void {
  try {
    addActivity(db, {
      itemId: input.itemId, runId: input.executorRunId, actor: "system", kind: "decision",
      payload: {
        decision: "delivery_snapshot_failed", reason: input.reason, head: input.head, kind: input.error.kind,
        error: scrubbed(db, input.itemId, input.error),
      },
    });
  } catch { /* 库已经关了：没有地方可记。 */ }
}

// 别的意外（例如写库失败）：记一条，不当成这个分支头算不出来，下次照常再试。它自己从不抛错。
function recordUnexpectedFailure(db: Db, input: { itemId: number; runId?: number; reason: string; error: unknown }): void {
  try {
    addActivity(db, {
      itemId: input.itemId, ...(input.runId ? { runId: input.runId } : {}), actor: "system", kind: "decision",
      payload: { decision: "delivery_snapshot_error", reason: input.reason, error: scrubbed(db, input.itemId, input.error) },
    });
  } catch { /* 库已经关了：没有地方可记。 */ }
}

function failureOf(row: { payload: string } | undefined, head: string | null): DeliveryCaptureFailure | null {
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload) as { kind?: GitFailureKind };
    const kind: GitFailureKind = payload.kind === "too_large" || payload.kind === "timeout" ? payload.kind : "error";
    return { kind, head, text: DELIVERY_CAPTURE_FAILURE_TEXT[kind] };
  } catch {
    return null;
  }
}

/** 这个分支头最近一次算不出文件列表的原因。没有时为 null。交付视图用它写合并为什么不可用。 */
export function latestDeliveryCaptureFailure(db: Db, itemId: number, head: string | null): DeliveryCaptureFailure | null {
  return failureOf(db.prepare(`${FAILURE_SQL} ORDER BY id DESC LIMIT 1`).get(itemId, head) as { payload: string } | undefined, head);
}

/**
 * 某一次交付（执行 Run）最近一次算不出文件列表的原因。没有时为 null。验收标准的确认用它写为什么还不能对照这次交付
 * （工单 05 审查 M5）：交付视图按分支头查，这里按交付查，不用读 git。
 */
export function deliveryCaptureFailureForRun(db: Db, itemId: number, executorRunId: number): DeliveryCaptureFailure | null {
  const row = db.prepare(
    `SELECT payload FROM activities
     WHERE item_id=? AND run_id=? AND kind='decision' AND json_extract(payload, '$.decision')='delivery_snapshot_failed'
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, executorRunId) as { payload: string } | undefined;
  if (!row) return null;
  const head = (() => {
    try { return (JSON.parse(row.payload) as { head?: string | null }).head ?? null; } catch { return null; }
  })();
  return failureOf(row, head);
}

// 这个分支头现在不该再算：改动太大，或者 10 分钟内超时、出错过。
function failureBlocksRetry(db: Db, itemId: number, head: string): boolean {
  return Boolean(db.prepare(
    `${FAILURE_SQL} AND (json_extract(payload, '$.kind')='too_large' OR created_at >= datetime('now', ?)) LIMIT 1`,
  ).get(itemId, head, `-${FAILURE_RETRY_MINUTES} minutes`));
}

// ── 抓 ─────────────────────────────────────────────────────────────────────────────

// 存这一份时刚结束的那个 Run 是做什么的（审查 L3）。
function triggerKindOf(db: Db, runId: number): DeliverySnapshotTriggerKind {
  const run = getRun(db, runId);
  if (!run) return "other";
  if (run.purpose === "conversation") return "conversation";
  if (run.purpose === "review") return "review";
  return isDeliveryRun(run) ? "execution" : "other";
}

export interface CaptureDeliverySnapshotInput {
  itemId: number;
  executorRunId: number;
  reason: "delivered" | "workspace_changed";
  triggerRunId?: number | null;
  backfilled?: boolean;
  // 交付时钉住的分支头和没提交的文件数。不给时现读。
  pinned?: { head: string; uncommittedFiles: number | null };
}

/**
 * 跑一次 diff，存一份快照。git 算不出来时不存，按分支头记一条失败，返回 null。
 * 这个分支头最近已经失败过时不再跑（failureBlocksRetry），也返回 null。别的错误（例如写库失败）往外抛。
 * 只在 serial 里面调用。
 */
async function captureDeliverySnapshot(
  db: Db, input: CaptureDeliverySnapshotInput,
): Promise<RecordDeliverySnapshotResult | null> {
  const outcome = getOutcomeSnapshotForRun(db, input.executorRunId) ?? null;
  const workspace = deliveryWorkspace(db, input.itemId);
  const record = (content: SnapshotContent) => recordDeliverySnapshot(db, {
    itemId: input.itemId, executorRunId: input.executorRunId, outcomeSnapshotId: outcome?.id ?? null,
    reason: input.reason, backfilled: input.backfilled ?? false, triggerRunId: input.triggerRunId ?? null,
    triggerKind: input.triggerRunId ? triggerKindOf(db, input.triggerRunId) : null, ...content,
  });
  if (!workspace) return record(agentContent(outcome, null));
  const head = input.pinned?.head ?? await workspaceHead(db, workspace);
  if (!head || !workspace.base_ref) {
    // 隔离分支已经找不到了：工作区变了也无从比较；补存时退一步，只记执行 agent 报的文件。
    return input.reason === "delivered" ? record(agentContent(outcome, workspace.id)) : null;
  }
  if (failureBlocksRetry(db, input.itemId, head)) return null;
  let content: SnapshotContent;
  try {
    const uncommittedFiles = input.pinned ? input.pinned.uncommittedFiles : await uncommittedFileCount(workspace);
    content = await gitContent(workspace, outcome, head, uncommittedFiles);
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;
    recordGitFailure(db, { itemId: input.itemId, executorRunId: input.executorRunId, reason: input.reason, head, error });
    return null;
  }
  return record(content);
}

// ── 什么时候抓 ─────────────────────────────────────────────────────────────────────

// 交付以后的阶段。active、blocked 时工作区属于正在进行的返工，变了也不记到上一次交付上。
const DELIVERED_STAGES: readonly ItemStage[] = ["review", "done", "cancelled"];

function delivered(item: Item | undefined): boolean {
  return Boolean(item && DELIVERED_STAGES.includes(item.stage));
}

// 还在跑的快照。测试和停机可以等它们。
const pending = new Set<Promise<unknown>>();

function track(work: Promise<unknown>): void {
  const settled = work.catch(() => undefined);
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
}

// 同一张工单的抓取排队，一次只做一个（审查 L1、L2）。daemon 是单进程，按工单排队就够了。
const queues = new Map<number, Promise<void>>();

function serial<T>(itemId: number, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(itemId);
  const run = previous ? previous.then(work) : work();
  const settled = run.then(() => undefined, () => undefined);
  queues.set(itemId, settled);
  track(settled);
  void settled.then(() => {
    if (queues.get(itemId) === settled) queues.delete(itemId);
  });
  return run;
}

/**
 * 执行 agent 的 ticket_update(status='review') 被接受以后、工具返回之前调用。只等几秒：钉住分支头和没提交的文件数，
 * diff 按钉住的提交在后台跑（审查 M1）。agent 交付以后又提交了，快照记的仍然是交付时的那个提交；Run 结束时
 * 再比一次，另存一份。不是交付 Run、工单没有进 review 时什么都不做。出错不往外抛：交付已经登记，
 * 快照没存成时 Run 结束和打开交付视图时会补。
 */
export async function recordDeliveryAtHandoff(db: Db, input: { itemId: number; runId: number }): Promise<void> {
  try {
    const run = getRun(db, input.runId);
    if (!run || !isDeliveryRun(run) || getItem(db, input.itemId)?.stage !== "review") return;
    if (!getOutcomeSnapshotForRun(db, input.runId) || getDeliveredSnapshotForRun(db, input.runId)) return;
    const workspace = deliveryWorkspace(db, input.itemId);
    const [head, uncommittedFiles] = workspace
      ? await Promise.all([
          workspaceHead(db, workspace, { timeout: HANDOFF_PIN_BUDGET_MS }),
          uncommittedFileCount(workspace, { timeout: HANDOFF_PIN_BUDGET_MS }),
        ])
      : [null, null];
    void serial(input.itemId, () => captureDeliverySnapshot(db, {
      itemId: input.itemId, executorRunId: input.runId, reason: "delivered",
      ...(head ? { pinned: { head, uncommittedFiles } } : {}),
    })).catch((error: unknown) => {
      recordUnexpectedFailure(db, { itemId: input.itemId, runId: input.runId, reason: "delivered", error });
    });
  } catch (error) {
    recordUnexpectedFailure(db, { itemId: input.itemId, runId: input.runId, reason: "delivered", error });
  }
}

// 最新的成果还没有快照时补存一份：v52 以前的交付，或者交付时没存成（git 出错、成果是从输出里恢复的）。
async function ensureLatestDeliveryRecorded(
  db: Db, item: Item, options: { backfilled: boolean; triggerRunId: number | null },
): Promise<DeliverySnapshot | null> {
  const latest = getLatestDeliverySnapshot(db, item.id) ?? null;
  if (!delivered(item)) return latest;
  const outcome = getLatestOutcomeSnapshot(db, item.id);
  if (!outcome || getDeliveredSnapshotForRun(db, outcome.executorRunId)) return latest;
  if (latest && latest.executorRunId > outcome.executorRunId) return latest;
  const result = await captureDeliverySnapshot(db, {
    itemId: item.id, executorRunId: outcome.executorRunId, reason: "delivered", backfilled: options.backfilled,
    triggerRunId: options.triggerRunId,
  });
  return result?.snapshot ?? latest;
}

export interface LiveWorkspaceState {
  workspace: Workspace;
  head: string | null;
  // git status 失败时为 null：不拿它比较（审查 L9）。
  uncommittedFiles: number | null;
}

// 交付以后工作区又变了：分支头或没提交的文件数和最新一份不一样。有 Run 正在这个工作区里工作时不比：它还没做完。
// 只比最新一次交付：最新的成果还没有快照（补存没成功）时，最新一份属于更早的交付，变化不能记到它上面。
async function recordWorkspaceChange(
  db: Db, item: Item, latest: DeliverySnapshot | null, live: LiveWorkspaceState, triggerRunId: number | null,
): Promise<DeliverySnapshot | null> {
  if (!latest || latest.source !== "git" || !delivered(item)) return latest;
  const outcome = getLatestOutcomeSnapshot(db, item.id);
  if (outcome && outcome.executorRunId !== latest.executorRunId) return latest;
  const { workspace } = live;
  if (latest.workspaceId !== workspace.id || ["merged", "abandoned"].includes(workspace.merge_status ?? "")) return latest;
  if (live.head === null || activeRuns(db, workspace.id) > 0) return latest;
  const countChanged = live.uncommittedFiles !== null && latest.uncommittedFiles !== null
    && live.uncommittedFiles !== latest.uncommittedFiles;
  if (live.head === latest.headSha && !countChanged) return latest;
  const result = await captureDeliverySnapshot(db, {
    itemId: item.id, executorRunId: latest.executorRunId, reason: "workspace_changed", triggerRunId,
    pinned: { head: live.head, uncommittedFiles: live.uncommittedFiles },
  });
  return result?.snapshot ?? latest;
}

/**
 * 交付视图读快照之前调用（delivery.ts 的 ticketDelivery）。live 是视图已经读到的工作区现状（分支头、没提交的文件数），
 * 这里不再为比较多跑 git；只有要补存、或者工作区确实变了时才跑 diff。
 * 写快照出错（例如库忙）时不让交付视图失败：退回读最新的一份（审查 L1）。
 */
export async function currentDeliverySnapshot(db: Db, item: Item, live: LiveWorkspaceState | null): Promise<DeliverySnapshot | null> {
  try {
    return await serial(item.id, async () => {
      const latest = await ensureLatestDeliveryRecorded(db, item, { backfilled: true, triggerRunId: null });
      return live ? recordWorkspaceChange(db, item, latest, live, null) : latest;
    });
  } catch (error) {
    recordUnexpectedFailure(db, { itemId: item.id, reason: "read", error });
    return getLatestDeliverySnapshot(db, item.id) ?? null;
  }
}

/** 交付切换和 Lead 读快照之前调用：只补存，不比较工作区（不跑 git status）。出错时退回读最新的一份。 */
export async function recordedDeliverySnapshot(db: Db, item: Item): Promise<DeliverySnapshot | null> {
  try {
    return await serial(item.id, () => ensureLatestDeliveryRecorded(db, item, { backfilled: true, triggerRunId: null }));
  } catch (error) {
    recordUnexpectedFailure(db, { itemId: item.id, reason: "read", error });
    return getLatestDeliverySnapshot(db, item.id) ?? null;
  }
}

/**
 * 一个 Run 结束、释放以后调用。
 * - 最新的成果还没有快照时存一份。成果属于刚结束的这个 Run（成果是从输出里恢复的）时，这就是交付时的那一份；
 *   属于别的 Run（v52 以前的交付、成果修复回合登记到来源 Run 上）时，分支头可能已经包含交付以后的改动，
 *   标成补存，记下是哪个 Run 结束时补的（审查 M3）。
 * - 结束时工作区和最新一份不一样（对话改了代码，或者执行 agent 交付以后又提交了），再存一份。
 */
export async function refreshDeliveryAfterRun(db: Db, input: { itemId: number; runId: number }): Promise<void> {
  await serial(input.itemId, async () => {
    const item = getItem(db, input.itemId);
    if (!item || !delivered(item)) return;
    const fromThisRun = getLatestOutcomeSnapshot(db, item.id)?.executorRunId === input.runId;
    const latest = await ensureLatestDeliveryRecorded(db, item, {
      backfilled: !fromThisRun, triggerRunId: fromThisRun ? null : input.runId,
    });
    const workspace = deliveryWorkspace(db, item.id);
    if (!workspace || !latest || latest.source !== "git") return;
    const [head, uncommittedFiles] = await Promise.all([workspaceHead(db, workspace), uncommittedFileCount(workspace)]);
    // 算的这段时间里工单可能变了（返工开始了）：比之前再读一次。
    const current = getItem(db, input.itemId);
    if (!current) return;
    await recordWorkspaceChange(db, current, getLatestDeliverySnapshot(db, item.id) ?? null, { workspace, head, uncommittedFiles }, input.runId);
  });
}

/** Run 释放以后在后台跑 refreshDeliveryAfterRun。出错只记一条活动，不往外抛。 */
export function scheduleDeliveryRefreshAfterRun(db: Db, input: { itemId: number; runId: number }): void {
  track(refreshDeliveryAfterRun(db, input).catch((error) => {
    recordUnexpectedFailure(db, { itemId: input.itemId, runId: input.runId, reason: "after_run", error });
  }));
}

/** 等后台还在跑的快照都结束。 */
export async function deliverySnapshotsSettled(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
