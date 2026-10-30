// 工单详情的「这次交付」（2026-10-20）。用户看着工单验收不了：成果卡只有一段截断的摘要和几行点不开的路径，
// 看不到改了哪些行，不知道改动在哪个分支、合没合并，也没有合并或开 PR 的入口（只有 Lead 的 integrate_workspace）。
// 这里给工单详情一份只读的交付视图，和三个用户操作：
// - ticketDelivery：改了哪些文件（+/− 行数）、改动在哪个分支、要合并到哪、现在能做哪些操作、不能做的原因。
// - ticketDeliveryFile：一个文件的全文或改动，只能读交付列表里的文件。
// - mergeDelivery / openDeliveryPullRequest / abandonDelivery：验收并合并、推到 GitHub 开草稿 PR、放弃改动。
// - ticketDeliveries / ticketDeliverySnapshot：每一次交付，和按交付序号取的某一次交付（交付切换用，工单 04）。
//
// 文件列表和行数读交付快照（delivery-snapshot.ts，工单 04）：交付时由系统存下，worktree 和分支清掉以后还在。
// 打开交付视图不再跑 git diff。分支现在指向哪、用户仓库在哪个分支、能不能合并，仍然现读 git：这些是操作的前提。
// 读 git 都用异步的 execFile（delivery-source.ts）。文件路径先校验（相对路径、没有 ..、在交付列表里），再交给 git。
// 可能含密钥的文件（.env、*.pem、id_rsa……）列出来，但不显示内容。
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import type {
  Db, DeliveryGeneratedKind, DeliverySnapshot, DeliverySnapshotCommit, DeliverySnapshotFile, DeliverySnapshotTriggerKind,
  OutcomeSnapshot,
} from "@pi-lead-child/store";
import {
  activePairedUserTurn, addActivity, getDeliverySnapshotBySequence, getItem, getLatestOutcomeSnapshot,
  getWorkspace, leadDisplayName, listDeliverySnapshotHeaders,
} from "@pi-lead-child/store";
import type { Item, ItemStage, Workspace } from "@pi-lead-child/core";
import { redactSecretText } from "@pi-lead-child/protocol";
import { abandonIsolatedWorkspace, integrateIsolatedWorkspace } from "./workspace.js";
import { worktreeBaseBranch } from "./workspace-remote.js";
import {
  activeRuns, deliveryFileHiddenReason, deliveryWorkspace, execFileAsync, firstLine, git, gitRun, hasGitSegment, latestDecision,
  NETWORK_TIMEOUT_MS, normalizeDeliveryPath, redact, uncommittedFileCount, workspaceHead, worktreePresent,
  type DeliveryFileStatus,
} from "./delivery-source.js";
import {
  currentDeliverySnapshot, DELIVERY_MAX_FILES, deliveryDiff, latestDeliveryCaptureFailure, recordedDeliverySnapshot,
} from "./delivery-snapshot.js";
import { transitionBy, type ActionAttribution } from "../ticket-actions/attribution.js";

export { deliveryFileHiddenReason, normalizeDeliveryPath, type DeliveryFileStatus };

// 预览一个文件最多读这么多字节。再长就截断，界面说明「只显示前 N KB」。
export const DELIVERY_FILE_MAX_BYTES = 400 * 1024;

export type DeliveryFileView = "full" | "diff";

export interface DeliveryFile {
  path: string;
  previousPath: string | null;
  // 执行 agent 在成果里给这个文件写的名字（deliverables 的 label）和改动说明（changes 的 summary）。
  label: string | null;
  note: string | null;
  status: DeliveryFileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  // 能打开的视图。全文：文件现在的内容；改动：相对开工时的 diff。都不能打开时写原因。
  views: DeliveryFileView[];
  hiddenReason: string | null;
}

export type DeliveryIntegration = "unmerged" | "merged" | "abandoned" | "conflict" | "no_changes";

export interface DeliveryWorkspace {
  workspaceId: number;
  branch: string | null;
  // 分支现在指向的提交。合并、开 PR、放弃时客户端带回它（expected.head），分支在用户看过以后变了就拒绝。
  head: string | null;
  // 用户仓库现在所在的分支：合并的目标。分离 HEAD 时为 null。
  target: string | null;
  commits: number;
  uncommittedFiles: number;
  integration: DeliveryIntegration;
  mergedInto: string | null;
  pullRequestUrl: string | null;
}

export interface DeliveryAction {
  available: boolean;
  // 不能做的原因，用户能看懂的一句话。能做时为 null。
  reason: string | null;
}

export interface TicketDelivery {
  ticketId: number;
  attemptId: number | null;
  // isolated：改动在 plc 建的隔离分支上，能算出 diff；shared：直接在用户的目录里改，只能看全文；none：没有可看的交付。
  source: "isolated" | "shared" | "none";
  files: DeliveryFile[];
  // files 只列前 DELIVERY_MAX_FILES（delivery-snapshot.ts）个时为 true。totals 照样算全部文件。
  truncated: boolean;
  totals: { files: number; additions: number; deletions: number } | null;
  workspace: DeliveryWorkspace | null;
  actions: {
    // 工单还在 review 时，合并会先验收：界面上叫「验收并合并」。
    merge: DeliveryAction & { acceptsTicket: boolean };
    openPullRequest: DeliveryAction;
    abandon: DeliveryAction;
  };
}

export interface DeliveryFileContent {
  path: string;
  view: DeliveryFileView;
  language: string;
  text: string;
  truncated: boolean;
  byteLength: number;
}

// stale：交付在用户看过以后变了（分支多了提交，或者用户的仓库换了分支）。客户端刷新以后再让用户决定。
export class DeliveryError extends Error {
  constructor(readonly code: "not_found" | "invalid_request" | "unavailable" | "failed" | "stale", message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

// ── 文件列表 ───────────────────────────────────────────────────────────────────────

// previousPath：改名前的路径。.env 改名成 env.txt 以后内容还是 .env 的，所以旧名字也要查（2026-10-21 审查 M6）。
function fileViews(
  path: string, status: DeliveryFileStatus, binary: boolean, hasDiff: boolean, previousPath: string | null = null,
): Pick<DeliveryFile, "views" | "hiddenReason"> {
  const hidden = deliveryFileHiddenReason(path) ?? (previousPath ? deliveryFileHiddenReason(previousPath) : null);
  if (hidden) return { views: [], hiddenReason: hidden };
  if (binary) return { views: [], hiddenReason: "二进制文件，不能在这里预览。" };
  const views: DeliveryFileView[] = [];
  if (status !== "deleted") views.push("full");
  if (hasDiff && status !== "unchanged") views.push("diff");
  return { views, hiddenReason: views.length ? null : "这个文件已经删除。" };
}

// ── 交付视图 ───────────────────────────────────────────────────────────────────────

function unavailable(reason: string): DeliveryAction { return { available: false, reason }; }
const AVAILABLE: DeliveryAction = { available: true, reason: null };

// 交付视图、它读的那份快照，和读文件内容用的提交（fileSource）。ticketDeliveryFile 用同一份快照里的提交读文件。
interface DeliveryViewResult {
  delivery: TicketDelivery;
  snapshot: DeliverySnapshot | null;
  fileSource: { base: string; head: string } | null;
}

async function deliveryView(db: Db, itemId: number): Promise<DeliveryViewResult> {
  const item = getItem(db, itemId);
  if (!item) throw new DeliveryError("not_found", `工单 #${itemId} 不存在`);
  const workspace = deliveryWorkspace(db, itemId);
  const noActions = (reason: string): TicketDelivery["actions"] => ({
    merge: { ...unavailable(reason), acceptsTicket: false },
    openPullRequest: unavailable(reason),
    abandon: unavailable(reason),
  });

  if (!workspace) {
    const snapshot = await currentDeliverySnapshot(db, item, null);
    const files = snapshot ? snapshot.files.map((file) => snapshotDeliveryFile(item, snapshot, file)) : [];
    return {
      snapshot, fileSource: null,
      delivery: {
        ticketId: itemId, attemptId: attemptOf(db, itemId, snapshot), source: files.length ? "shared" : "none",
        files, truncated: snapshot?.truncated ?? false, totals: null, workspace: null,
        actions: noActions("这张工单直接改在你的目录里，没有单独的分支要合并。"),
      },
    };
  }

  const repo = workspace.repo_root!;
  const head = await workspaceHead(db, workspace);
  const present = worktreePresent(workspace);
  // git status 失败时不知道有几个（null）：视图照旧写 0，快照不拿它比较（审查 L9）。
  const uncommittedCount = await uncommittedFileCount(workspace);
  const uncommittedFiles = uncommittedCount ?? 0;
  // 文件列表读快照。工作区和最新一份不一样时，currentDeliverySnapshot 先存一份新的（工单 04）。
  const snapshot = await currentDeliverySnapshot(db, item, { workspace, head, uncommittedFiles: uncommittedCount });
  const outcome = getLatestOutcomeSnapshot(db, itemId);
  let files = snapshot ? snapshot.files.map((file) => snapshotDeliveryFile(item, snapshot, file)) : [];
  let totals = snapshot?.totals ?? null;
  let fileSource = snapshot?.source === "git" && snapshot.baseSha && snapshot.headSha
    ? { base: snapshot.baseSha, head: snapshot.headSha } : null;
  // 交付以前就取消的工单（审查 M2 的 P2）：没有交付可存，现读分支上的改动，用户放弃之前看得到放弃的是什么。不存快照。
  let abandonProblem: string | null = null;
  if (!snapshot && !outcome && item.stage === "cancelled" && head && workspace.base_ref) {
    try {
      const entries = await deliveryDiff(repo, workspace.base_ref, head);
      files = entries.slice(0, DELIVERY_MAX_FILES).map((entry) => ({
        path: entry.path, previousPath: entry.previousPath, label: null, note: null, status: entry.status,
        additions: entry.additions, deletions: entry.deletions, binary: entry.binary,
        ...fileViews(entry.path, entry.status, entry.binary, true, entry.previousPath),
      }));
      totals = {
        files: entries.length,
        additions: entries.reduce((sum, entry) => sum + (entry.additions ?? 0), 0),
        deletions: entries.reduce((sum, entry) => sum + (entry.deletions ?? 0), 0),
      };
      fileSource = { base: workspace.base_ref, head };
    } catch {
      abandonProblem = `算不出这个分支上有哪些改动，这里不能放弃。可以请 ${leadDisplayName(db)} 处理这个工作区。`;
    }
  }

  const targetResult = await gitRun(["branch", "--show-current"], repo);
  const target = targetResult.ok ? targetResult.stdout.trim() || null : null;
  const commits = head && workspace.merge_status !== "merged"
    ? Number((await gitRun(["rev-list", "--count", `HEAD..${head}`], repo)).stdout.trim() || 0)
    : 0;
  const integrated = workspace.merge_status === "merged"
    ? latestDecision(db, itemId, "workspace_integrated", workspace.id) : null;
  const pr = latestDecision(db, itemId, "workspace_pr_opened", workspace.id);
  const integration: DeliveryIntegration = workspace.merge_status === "merged" ? "merged"
    : workspace.merge_status === "abandoned" ? "abandoned"
      : workspace.merge_status === "conflict" ? "conflict"
        : commits > 0 || uncommittedFiles > 0 ? "unmerged" : "no_changes";

  const deliveryWorkspaceView: DeliveryWorkspace = {
    workspaceId: workspace.id, branch: workspace.branch, head, target, commits, uncommittedFiles, integration,
    mergedInto: integrated?.target ?? null, pullRequestUrl: pr?.url ?? null,
  };

  const actions = await deliveryActions(db, item, workspace, {
    head, target, commits, uncommittedFiles, integration, present, pullRequestUrl: pr?.url ?? null,
    listProblem: listProblem(db, item, { snapshot, outcome: outcome ?? null, head, integration }), abandonProblem,
  });
  return {
    snapshot, fileSource,
    delivery: {
      ticketId: itemId, attemptId: attemptOf(db, itemId, snapshot), source: "isolated", files,
      truncated: snapshot?.truncated ?? false, totals, workspace: deliveryWorkspaceView, actions,
    },
  };
}

// 用户看到的文件列表是快照里的。合并之前要先看到改了什么（审查 M2）：
// - 已交付、还没合并，最新一次交付却没有 git 快照（快照一直存不成，例如改动太大）：列表是空的。
// - 分支在交付以后又变了，新的一份没存成：列表还停在旧的提交上，合并会合进用户没看过的改动。
// 这两种情况合并不可用，原因写清楚，给出开 PR 或打回返工的出路。返回 null 时列表和要合并的提交一致。
function listProblem(
  db: Db, item: Item,
  state: { snapshot: DeliverySnapshot | null; outcome: OutcomeSnapshot | null; head: string | null; integration: DeliveryIntegration },
): string | null {
  if (!["unmerged", "conflict"].includes(state.integration) || !["review", "done"].includes(item.stage)) return null;
  const failure = latestDeliveryCaptureFailure(db, item.id, state.head)?.text ?? null;
  const { snapshot, outcome } = state;
  if (outcome && !(snapshot?.source === "git" && snapshot.executorRunId === outcome.executorRunId)) {
    return `${failure ?? "系统还没算出这次交付的文件列表。"}合并之前要先看到改了什么：可以开 PR 在 GitHub 上看改动，或者打回返工。`;
  }
  if (snapshot?.source === "git" && state.head !== null && snapshot.headSha !== state.head) {
    return `分支在交付以后又有了改动，${failure ?? "系统还没存下新的文件列表。"}现在合并会合进你没看过的改动。`
      + "可以开 PR 在 GitHub 上看改动，或者稍后刷新再试。";
  }
  return null;
}

// 交付属于哪个执行 Run：快照记下的那一个；还没有快照时（没交付过）是最新成果的那一个。
function attemptOf(db: Db, itemId: number, snapshot: DeliverySnapshot | null): number | null {
  return snapshot?.executorRunId ?? getLatestOutcomeSnapshot(db, itemId)?.executorRunId ?? null;
}

export async function ticketDelivery(db: Db, itemId: number): Promise<TicketDelivery> {
  return (await deliveryView(db, itemId)).delivery;
}

async function deliveryActions(
  db: Db, item: Item, workspace: Workspace,
  state: {
    head: string | null; target: string | null; commits: number; uncommittedFiles: number; integration: DeliveryIntegration;
    present: boolean; pullRequestUrl: string | null;
    // 合并不可用的原因：文件列表和要合并的提交对不上（listProblem）。放弃不可用的原因：看不到要放弃的改动。
    listProblem: string | null; abandonProblem: string | null;
  },
): Promise<TicketDelivery["actions"]> {
  const repo = workspace.repo_root!;
  const running = activeRuns(db, workspace.id) > 0;
  const settled = state.integration === "merged" ? "改动已经合并。"
    : state.integration === "abandoned" ? "改动已经放弃。"
      : state.integration === "no_changes" ? "分支上没有新的改动。" : null;

  let merge: DeliveryAction;
  const acceptsTicket = item.stage === "review";
  if (settled) merge = unavailable(settled);
  else if (!["review", "done"].includes(item.stage)) merge = unavailable("交付以后才能合并。");
  else if (running) merge = unavailable("还有 agent 在这个分支上工作，等它结束再合并。");
  else if (state.listProblem) merge = unavailable(state.listProblem);
  else if (state.uncommittedFiles > 0) merge = unavailable(`分支上还有 ${state.uncommittedFiles} 个没提交的文件。先让工单的 agent 提交，或者打回返工。`);
  else if (!state.target) merge = unavailable("你的仓库现在不在任何分支上（分离 HEAD），不知道合并到哪里。");
  else if ((await gitRun(["status", "--porcelain", "--untracked-files=no"], repo)).stdout.trim()) {
    merge = unavailable(`你的仓库在 ${state.target} 上有没提交的改动。先提交或暂存，再合并。`);
  } else if (state.head && !(await gitRun(["merge-tree", "--write-tree", "--quiet", "HEAD", state.head], repo)).ok) {
    merge = unavailable(`这些改动和 ${state.target} 有冲突，不能直接合并。可以开 PR，或者打回返工让 agent 先解决冲突。`);
  } else merge = AVAILABLE;

  let openPullRequest: DeliveryAction;
  if (state.pullRequestUrl) openPullRequest = unavailable("已经开过 PR。");
  else if (state.integration === "merged" || state.integration === "abandoned" || state.integration === "no_changes") openPullRequest = unavailable(settled!);
  else if (!["review", "done"].includes(item.stage)) openPullRequest = unavailable("交付以后才能开 PR。");
  else if (state.uncommittedFiles > 0) openPullRequest = unavailable(`分支上还有 ${state.uncommittedFiles} 个没提交的文件，先让工单的 agent 提交。`);
  else if (state.commits === 0) openPullRequest = unavailable("分支上没有新的提交。");
  else if (!(await gitRun(["remote", "get-url", "origin"], repo)).ok) openPullRequest = unavailable("这个仓库没有名为 origin 的远程仓库，开不了 PR。");
  else openPullRequest = AVAILABLE;

  let abandon: DeliveryAction;
  if (settled && state.integration !== "no_changes") abandon = unavailable(settled);
  else if (!["done", "cancelled"].includes(item.stage)) abandon = unavailable("工单还没结束。不要这些改动时，取消工单。");
  else if (running) abandon = unavailable("还有 agent 在这个分支上工作。");
  else if (state.abandonProblem) abandon = unavailable(state.abandonProblem);
  else if (!state.present && state.integration === "no_changes") abandon = unavailable("没有要放弃的改动。");
  else abandon = AVAILABLE;

  return { merge: { ...merge, acceptsTicket: acceptsTicket && merge.available }, openPullRequest, abandon };
}

// 快照里的一个文件，加上现在能不能看。
// - source=git：按状态和隐藏规则算，和以前现跑 diff 时一样。
// - source=agent、工单有隔离分支：分支已经找不到了，只有执行 agent 报的文件名。
// - source=agent、直接改在用户目录里的工单：没有基线可比，只能看文件现在的全文。
function snapshotDeliveryFile(item: Item, snapshot: DeliverySnapshot, file: DeliverySnapshotFile): DeliveryFile {
  const status = file.status ?? "unchanged";
  const base = {
    path: file.path, previousPath: file.previousPath, label: file.label, note: file.note,
    status, additions: file.additions, deletions: file.deletions, binary: file.binary,
  };
  if (snapshot.source === "git") return { ...base, ...fileViews(file.path, status, file.binary, true, file.previousPath) };
  if (snapshot.workspaceId !== null) {
    return { ...base, views: [], hiddenReason: deliveryFileHiddenReason(file.path) ?? "分支已经不在了，看不到这个文件。" };
  }
  return { ...base, ...sharedFileViews(item, file.path) };
}

function sharedFileViews(item: Item, path: string): Pick<DeliveryFile, "views" | "hiddenReason"> {
  const root = item.workdir;
  const real = root ? containedFile(root, path) : null;
  const hidden = deliveryFileHiddenReason(path) ?? (real ? realFileHiddenReason(root!, real) : null);
  const exists = !hidden && real !== null;
  return { views: exists ? ["full"] : [], hiddenReason: hidden ?? (exists ? null : "找不到这个文件。") };
}

// 符号链接指向的文件也按隐藏规则查：notes.md -> .env 能通过包含检查，内容却是 .env 的（2026-10-21 审查 M6）。
function realFileHiddenReason(root: string, real: string): string | null {
  const hidden = deliveryFileHiddenReason(real);
  if (hidden) return hidden;
  try {
    return hasGitSegment(relative(realpathSync(root), real)) ? "这是 git 的内部文件，不在这里显示。" : null;
  } catch {
    return null;
  }
}

// realpath 以后仍在 root 里面的普通文件。符号链接指到外面时返回 null。
function containedFile(root: string, path: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(resolve(realRoot, path));
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

// ── 一个文件的全文或改动 ───────────────────────────────────────────────────────────

const LANGUAGES: Record<string, string> = {
  ".md": "markdown", ".markdown": "markdown", ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
  ".mjs": "javascript", ".cjs": "javascript", ".json": "json", ".py": "python", ".go": "go", ".rs": "rust",
  ".sh": "bash", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".css": "css", ".html": "html", ".sql": "sql",
  ".java": "java", ".kt": "kotlin", ".swift": "swift", ".rb": "ruby",
};

function clip(text: string): { text: string; truncated: boolean; byteLength: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= DELIVERY_FILE_MAX_BYTES) return { text, truncated: false, byteLength: bytes };
  return { text: Buffer.from(text, "utf8").subarray(0, DELIVERY_FILE_MAX_BYTES).toString("utf8"), truncated: true, byteLength: bytes };
}

export async function ticketDeliveryFile(
  db: Db, itemId: number, rawPath: unknown, rawView: unknown,
): Promise<DeliveryFileContent> {
  const path = normalizeDeliveryPath(rawPath);
  if (!path) throw new DeliveryError("invalid_request", "文件路径不对：只能是仓库里的相对路径。");
  const view: DeliveryFileView = rawView === "diff" ? "diff" : "full";
  const { delivery, fileSource } = await deliveryView(db, itemId);
  const file = delivery.files.find((entry) => entry.path === path);
  if (!file) throw new DeliveryError("not_found", "这个文件不在这次交付里。");
  if (!file.views.includes(view)) {
    throw new DeliveryError("unavailable", file.hiddenReason ?? (view === "diff" ? "这个文件没有改动可看。" : "这个文件没有全文可看。"));
  }
  const language = view === "diff" ? "diff" : LANGUAGES[extname(path).toLowerCase()] ?? "text";

  if (delivery.source === "shared") {
    const item = getItem(db, itemId)!;
    const real = item.workdir ? containedFile(item.workdir, path) : null;
    if (!real) throw new DeliveryError("not_found", "找不到这个文件。");
    const hidden = realFileHiddenReason(item.workdir!, real);
    if (hidden) throw new DeliveryError("unavailable", hidden);
    const raw = readFileSync(real);
    if (raw.subarray(0, 8000).includes(0)) throw new DeliveryError("unavailable", "二进制文件，不能在这里预览。");
    return { path, view, language, ...clip(raw.toString("utf8")) };
  }

  // 读交付时的那个提交（快照的 head），不是分支现在的位置：分支删了以后，提交还在仓库里时照样能看。
  // 交付以前就取消的工单读分支现在的位置（视图现读的那一份）。
  if (!fileSource) throw new DeliveryError("unavailable", "分支已经不在了，看不到这个文件。");
  const { head, base } = fileSource;
  const repo = deliveryWorkspace(db, itemId)!.repo_root!;
  let text: string;
  try {
    text = view === "full"
      ? await git(["show", `${head}:${path}`], repo, { maxBuffer: 32 * 1024 * 1024 })
      : await git(["diff", "-M", base, head, "--", ...(file.previousPath ? [file.previousPath] : []), path], repo, { maxBuffer: 32 * 1024 * 1024 });
  } catch {
    // git 的报错里有仓库的路径，不转给客户端。
    throw new DeliveryError("unavailable", "交付时的提交已经不在仓库里了，看不到这个文件。");
  }
  if (view === "full" && text.slice(0, 8000).includes("\0")) throw new DeliveryError("unavailable", "二进制文件，不能在这里预览。");
  return { path, view, language, ...clip(text) };
}

// ── 每一次交付（交付切换，工单 04、spec D8）───────────────────────────────────────────
// 界面显示最新一次交付，带「第 1 次交付」切换。返工后有第 2 次交付；交付以后工作区又变了，同一次交付有第 2 份。
// 这两个只读快照，不现跑 git：没有快照的最新成果先补存一份。

export interface DeliverySummary {
  sequence: number;
  attemptId: number;
  // 这次交付存了几份（交付以后工作区每变一次多一份）。下面的字段是最新一份的。
  revisions: number;
  reason: DeliverySnapshot["reason"];
  source: DeliverySnapshot["source"];
  backfilled: boolean;
  head: string | null;
  commitCount: number;
  totals: DeliverySnapshot["totals"];
  deliveredAt: string;
  updatedAt: string;
}

export type DeliverySnapshotFileView = Omit<DeliveryFile, "status" | "views"> & {
  status: DeliveryFileStatus | null;
  generated: DeliveryGeneratedKind | null;
};

export interface TicketDeliverySnapshot {
  ticketId: number;
  sequence: number;
  revision: number;
  revisions: number;
  attemptId: number;
  reason: DeliverySnapshot["reason"];
  source: DeliverySnapshot["source"];
  backfilled: boolean;
  triggerAttemptId: number | null;
  triggerKind: DeliverySnapshotTriggerKind | null;
  base: string | null;
  head: string | null;
  commits: DeliverySnapshotCommit[];
  commitCount: number;
  files: DeliverySnapshotFileView[];
  truncated: boolean;
  totals: DeliverySnapshot["totals"];
  uncommittedFiles: number | null;
  capturedAt: string;
}

async function itemWithRecordedDelivery(db: Db, itemId: number): Promise<Item> {
  const item = getItem(db, itemId);
  if (!item) throw new DeliveryError("not_found", `工单 #${itemId} 不存在`);
  await recordedDeliverySnapshot(db, item);
  return item;
}

/** 这张工单的每一次交付，按顺序。 */
export async function ticketDeliveries(db: Db, itemId: number): Promise<DeliverySummary[]> {
  await itemWithRecordedDelivery(db, itemId);
  const bySequence = new Map<number, ReturnType<typeof listDeliverySnapshotHeaders>>();
  for (const header of listDeliverySnapshotHeaders(db, itemId)) {
    bySequence.set(header.sequence, [...(bySequence.get(header.sequence) ?? []), header]);
  }
  return [...bySequence.values()].map((headers) => {
    const first = headers[0]!;
    const latest = headers[headers.length - 1]!;
    return {
      sequence: latest.sequence, attemptId: latest.executorRunId, revisions: headers.length, reason: latest.reason,
      source: latest.source, backfilled: first.backfilled, head: latest.headSha, commitCount: latest.commitCount,
      totals: latest.totals, deliveredAt: first.createdAt, updatedAt: latest.createdAt,
    };
  });
}

/** 第 sequence 次交付。不给 revision 时取这次交付最新的一份。 */
export async function ticketDeliverySnapshot(
  db: Db, itemId: number, sequence: number, revision?: number,
): Promise<TicketDeliverySnapshot> {
  const item = await itemWithRecordedDelivery(db, itemId);
  const snapshot = getDeliverySnapshotBySequence(db, itemId, sequence, revision);
  if (!snapshot) {
    throw new DeliveryError("not_found", revision === undefined
      ? `工单 #${itemId} 没有第 ${sequence} 次交付。`
      : `工单 #${itemId} 的第 ${sequence} 次交付没有第 ${revision} 份。`);
  }
  const revisions = listDeliverySnapshotHeaders(db, itemId).filter((header) => header.sequence === sequence).length;
  return {
    ticketId: itemId, sequence: snapshot.sequence, revision: snapshot.revision, revisions, attemptId: snapshot.executorRunId,
    reason: snapshot.reason, source: snapshot.source, backfilled: snapshot.backfilled, triggerAttemptId: snapshot.triggerRunId,
    triggerKind: snapshot.triggerKind,
    base: snapshot.baseSha, head: snapshot.headSha, commits: snapshot.commits, commitCount: snapshot.commitCount,
    files: snapshot.files.map((file) => {
      const { views: _views, status: _status, ...view } = snapshotDeliveryFile(item, snapshot, file);
      return { ...view, status: file.status, generated: file.generated };
    }),
    truncated: snapshot.truncated, totals: snapshot.totals, uncommittedFiles: snapshot.uncommittedFiles,
    capturedAt: snapshot.createdAt,
  };
}

// ── 用户操作 ───────────────────────────────────────────────────────────────────────

function requireIsolated(db: Db, itemId: number): Workspace {
  const workspace = deliveryWorkspace(db, itemId);
  if (!workspace) throw new DeliveryError("unavailable", "这张工单没有单独的分支。");
  return workspace;
}

// 合并失败时给用户看的话。不转发 git 的原文：它带着 git -C <仓库路径>，协议规定不下发服务器路径（2026-10-21 审查 L2）。
// integrateIsolatedWorkspace 在 git merge 失败时撤回合并，把 merge_status 记成 conflict；其余失败是合并前的检查。
function mergeFailureText(db: Db, workspace: Workspace): string {
  const after = getWorkspace(db, workspace.id);
  if (after?.merge_status === "conflict") {
    return `git 合并失败：有冲突，或者仓库的钩子拒绝了合并提交。已经撤回这次合并，改动还在分支 ${workspace.branch} 上。`;
  }
  return "合并前的检查没有通过（例如你的仓库里有没提交的改动）。刷新后看看现在能不能合并。";
}

// ── 合并、开 PR、放弃的并发（2026-10-21 审查 M2）──────────────────────────────────────
// 同一张工单的这三个操作一次只做一个。以前双击「验收并合并」时，第二次请求在第一次合并之前读交付，检查照样通过，
// 然后去读已经删掉的分支，报「合并没有成功」；双击「开 PR」时第二次 gh 报 already exists。用户的按钮和 Lead 的
// ticket_action（open_pr、merge、abandon）都经过这里。daemon 是单进程，按工单排队就够了。前面没有排队的操作时马上开始。
const deliveryQueues = new Map<number, Promise<void>>();

function oneAtATime<T>(itemId: number, work: () => Promise<T>): Promise<T> {
  const previous = deliveryQueues.get(itemId);
  const run = previous ? previous.then(work) : work();
  const settled = run.then(() => undefined, () => undefined);
  deliveryQueues.set(itemId, settled);
  void settled.then(() => {
    if (deliveryQueues.get(itemId) === settled) deliveryQueues.delete(itemId);
  });
  return run;
}

// 用户看到的交付：分支指向的提交和用户仓库所在的分支（GET delivery 的 workspace.head、workspace.target）。
// 给了就要和现在的一致；不给（旧客户端、Lead 的工具）就不比。
export interface DeliveryExpectation {
  head?: string | null;
  target?: string | null;
}

function assertAsSeen(delivery: TicketDelivery, expected: DeliveryExpectation | undefined): void {
  if (!expected) return;
  const head = delivery.workspace?.head ?? null;
  const target = delivery.workspace?.target ?? null;
  if (expected.head !== undefined && expected.head !== head) {
    throw new DeliveryError("stale", "分支在你看过以后有了新的提交。请刷新，看过新的改动再操作。");
  }
  if (expected.target !== undefined && expected.target !== target) {
    throw new DeliveryError(
      "stale",
      `你的仓库现在在 ${target ?? "分离 HEAD"} 上，不是你看到的 ${expected.target ?? "分离 HEAD"}。请刷新后再操作。`,
    );
  }
}

// 读交付要等 git。这段时间里 Lead 的 integrate_workspace、release_workspace（同步）可能已经合并或放弃了它，返工可能已经开始。
// await 之后、动手之前同步再查一次，不在过时的检查上验收或合并。
function recheckBeforeActing(
  db: Db, itemId: number, workspaceId: number, stages: readonly ItemStage[], stageReason: string,
): Item {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace || workspace.merge_status === "merged") throw new DeliveryError("unavailable", "改动已经合并。");
  if (workspace.merge_status === "abandoned") throw new DeliveryError("unavailable", "改动已经放弃。");
  const item = getItem(db, itemId)!;
  if (!stages.includes(item.stage)) throw new DeliveryError("unavailable", stageReason);
  if (activeRuns(db, workspaceId) > 0) {
    throw new DeliveryError("unavailable", "还有 agent 在这个分支上工作，等它结束再操作。");
  }
  return item;
}

// 工作区的收尾记在谁名下（integrateIsolatedWorkspace、abandonIsolatedWorkspace 的 actor 和 onBehalfOf）。
function workspaceBy(by: ActionAttribution | undefined): {
  actor: "user" | "lead"; onBehalfOf?: { actor: "user"; sourceTurnId: string };
} {
  return transitionBy(by ?? { actor: "user" });
}

/**
 * 验收并合并（工单在 review）或合并（工单已完成）。先确认能合并（没有冲突、两边都干净），再验收：
 * 合并做不成时不把工单标成完成。验收由调用方传入（用户操作服务的 completeItem），这里不绕过它的规则。
 */
export async function mergeDelivery(
  db: Db, itemId: number,
  // by：谁合并（工单操作层的 ActionAttribution）。不给时是你本人。Lead 代你做时，工作区那一行写 actor=lead 和代谁、凭哪一轮。
  input: { accept: () => void; reason: string; expected?: DeliveryExpectation; by?: ActionAttribution },
): Promise<TicketDelivery> {
  return oneAtATime(itemId, async () => {
    const workspace = requireIsolated(db, itemId);
    const delivery = await ticketDelivery(db, itemId);
    // 从这里到合并结束都是同步的：查过的状态不会再变。先按库里现在的状态查，再看读交付时算出的能不能合并。
    const item = recheckBeforeActing(db, itemId, workspace.id, ["review", "done"], "交付以后才能合并。");
    if (!delivery.actions.merge.available) throw new DeliveryError("unavailable", delivery.actions.merge.reason ?? "现在不能合并。");
    assertAsSeen(delivery, input.expected);
    const accepts = item.stage === "review";
    if (accepts) input.accept();
    try {
      integrateIsolatedWorkspace(db, workspace.id, { ...workspaceBy(input.by), reason: input.reason });
    } catch {
      const detail = mergeFailureText(db, workspace);
      throw new DeliveryError("failed", accepts ? `工单已经验收，但合并没有成功：${detail}` : `合并没有成功：${detail}`);
    }
    return ticketDelivery(db, itemId);
  });
}

/** 放弃改动：删掉隔离 worktree。分支保留在用户仓库里，改动还能找回。 */
export async function abandonDelivery(
  db: Db, itemId: number,
  // by：谁放弃（同 mergeDelivery）。Lead 代你做时，放弃的同意写 Lead 给的原因，不写「用户在工单详情里确认」。
  input: { reason: string; expected?: DeliveryExpectation; by?: ActionAttribution },
): Promise<TicketDelivery> {
  return oneAtATime(itemId, async () => {
    const workspace = requireIsolated(db, itemId);
    const delivery = await ticketDelivery(db, itemId);
    recheckBeforeActing(db, itemId, workspace.id, ["done", "cancelled"], "工单还没结束。不要这些改动时，取消工单。");
    if (!delivery.actions.abandon.available) throw new DeliveryError("unavailable", delivery.actions.abandon.reason ?? "现在不能放弃。");
    assertAsSeen(delivery, input.expected);
    abandonIsolatedWorkspace(db, workspace.id, {
      ...workspaceBy(input.by), reason: input.reason,
      userConfirmation: (input.by?.actor ?? "user") === "user" ? "用户在工单详情里确认放弃这些改动" : input.reason,
    });
    return ticketDelivery(db, itemId);
  });
}

// PR 的目标分支：用户仓库现在的分支在远程也有时用它（分支就是从它开出来的，PR 里只有这张工单的提交）；
// 否则用远程的默认分支。
// PR 的 base：worktree 切出来时基于的分支（workspace-remote.ts 记的），没记过时用 origin 的默认分支。
// 不再用用户 checkout 当前停的分支（2026-10-29：#158 的 PR base 成了不相干的功能分支 aishx/task-model-routing）。
async function pullRequestBase(repo: string, baseBranch: string | null): Promise<string> {
  if (baseBranch) {
    const remote = await gitRun(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${baseBranch}`], repo, { timeout: NETWORK_TIMEOUT_MS });
    if (remote.ok && remote.stdout.trim()) return baseBranch;
  }
  const head = await gitRun(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  return head.ok && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, "") : "main";
}

function pullRequestBody(db: Db, itemId: number, item: Item): string {
  const snapshot = getLatestOutcomeSnapshot(db, itemId);
  const lines = [`来自 pi-lead-child 工单 #${itemId}：${item.display_title ?? item.title}`, ""];
  if (snapshot) {
    lines.push("## 做了什么", "", snapshot.summary, "");
    const files = snapshot.changes.filter((change) => change.kind === "file");
    if (files.length) {
      lines.push("## 改动", "", ...files.map((change) => `- \`${change.ref}\`${change.summary ? `：${change.summary}` : ""}`), "");
    }
    if (snapshot.validations.length) {
      const label = { passed: "通过", failed: "失败", not_run: "没运行" } as const;
      lines.push("## 验证", "", ...snapshot.validations.map((validation) => `- ${label[validation.outcome]}：${validation.command}${validation.summary ? `（${validation.summary}）` : ""}`), "");
    }
  }
  return lines.join("\n");
}

export interface PullRequestRunner {
  // 运行 gh。测试注入假的实现；缺省用本机的 gh。
  gh(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

const defaultRunner: PullRequestRunner = {
  async gh(args, cwd) {
    try {
      const { stdout, stderr } = await execFileAsync("gh", args, { cwd, encoding: "utf8", timeout: NETWORK_TIMEOUT_MS });
      return { ok: true, stdout, stderr };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: string; message?: string };
      if (failed.code === "ENOENT") return { ok: false, stdout: "", stderr: "ENOENT" };
      return { ok: false, stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message ?? String(error) };
    }
  },
};

// 谁开 PR。推送和开 PR 是对外发布的操作：用户本人点（HTTP 路由已经认证过用户），Lead，或者系统。
// Lead：在哪一轮都能开（用户 2026-10-28「工单操作让 Lead 自己判断」；2026-10-29 Lead 在交付叫醒的一轮里开不了，
// 要用户去点按钮）。能不能做由工单操作层判（ticket-actions/authority.ts：外部消息叫醒的一轮照旧拦，发确认卡）。
// 在用户本人这一轮里开的记成代用户做。2026-10-21 审查 M3 担心 Lead 误判把代码推到公开仓库；系统交付后本来就自动开
// 草稿 PR（下一行），两条路推的是同一条分支，所以这里不再另设一道。
// system：交付以后系统按固定的条件自己开草稿 PR（auto-pull-request.ts，用户 2026-10-26「默认最后都引导 agent 开 PR」）。
export type PullRequestActor =
  | { actor: "user" }
  | { actor: "lead"; sourceTurnId: string | null }
  | { actor: "system" };

/** 把分支推到 origin，用 gh 开一个草稿 PR，记下 PR 的地址。对外的操作：用户点按钮、Lead 判断要开，或者系统交付后自动开。 */
export async function openDeliveryPullRequest(
  db: Db, itemId: number,
  input: PullRequestActor & { reason: string; runner?: PullRequestRunner; expected?: DeliveryExpectation },
): Promise<TicketDelivery & { pullRequestUrl: string }> {
  // 用户本人这一轮里 Lead 开的，记成代用户做；别的轮次是 Lead 自己判断的。
  let turn: ReturnType<typeof activePairedUserTurn> | null = null;
  if (input.actor === "lead" && input.sourceTurnId) {
    try {
      turn = activePairedUserTurn(db, input.sourceTurnId, "open_pr", "tickets:create");
    } catch {
      turn = null;
    }
  }
  return oneAtATime(itemId, async () => {
    const workspace = requireIsolated(db, itemId);
    const delivery = await ticketDelivery(db, itemId);
    if (!delivery.actions.openPullRequest.available) {
      throw new DeliveryError("unavailable", delivery.actions.openPullRequest.reason ?? "现在不能开 PR。");
    }
    assertAsSeen(delivery, input.expected);
    const repo = workspace.repo_root!;
    const branch = workspace.branch!;
    const base = await pullRequestBase(repo, worktreeBaseBranch(db, workspace));
    const item = recheckBeforeActing(db, itemId, workspace.id, ["review", "done"], "交付以后才能开 PR。");
    const push = await gitRun(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], repo, {
      timeout: NETWORK_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (!push.ok) throw new DeliveryError("failed", `推送分支失败：${redact(firstLine(push.stderr))}`);
    const runner = input.runner ?? defaultRunner;
    const pushedHead = delivery.workspace?.head ?? null;
    // 系统开 PR 之前先看这条分支是不是已经有 PR（例如以前由 child 自己开的 #107）：有就记下它，不开第二个。
    const existing = input.actor === "system" ? await openPullRequestFor(runner, repo, branch) : null;
    if (existing) {
      addActivity(db, {
        itemId, actor: "system", kind: "decision",
        payload: { decision: "workspace_pr_opened", workspaceId: workspace.id, branch, base, url: existing, head: pushedHead, adopted: true, reason: input.reason },
      });
      return { ...(await ticketDelivery(db, itemId)), pullRequestUrl: existing };
    }
    const created = await runner.gh([
      "pr", "create", "--draft", "--head", branch, "--base", base,
      // 标题和正文来自 agent 写的成果，发到 GitHub 之前脱敏（2026-10-21 审查 L3）。
      "--title", redactSecretText(item.display_title ?? item.title), "--body", redactSecretText(pullRequestBody(db, itemId, item)),
    ], repo);
    if (!created.ok) {
      const detail = created.stderr === "ENOENT" ? "这台电脑没有装 GitHub CLI（gh）。分支已经推上去了，可以在 GitHub 上手动开 PR。"
        : `${redact(firstLine(created.stderr))}。分支已经推上去了，可以在 GitHub 上手动开 PR。`;
      throw new DeliveryError("failed", `开 PR 失败：${detail}`);
    }
    const url = created.stdout.split("\n").map((line) => line.trim()).reverse().find((line) => /^https:\/\//.test(line));
    if (!url) throw new DeliveryError("failed", "gh 没有返回 PR 的地址。分支已经推上去了，可以在 GitHub 上查看。");
    addActivity(db, {
      itemId, actor: input.actor, kind: "decision",
      ...(turn ? { sessionCursor: turn.id } : {}),
      payload: {
        decision: "workspace_pr_opened", workspaceId: workspace.id, branch, base, url, head: pushedHead, reason: input.reason,
        ...(turn ? { onBehalfOf: "user", sourceTurnId: turn.id } : {}),
      },
    });
    return { ...(await ticketDelivery(db, itemId)), pullRequestUrl: url };
  });
}

// 这条分支上开着的 PR 的地址。gh 失败时当作没有：之后的 gh pr create 会报出真正的原因。
async function openPullRequestFor(runner: PullRequestRunner, repo: string, branch: string): Promise<string | null> {
  const listed = await runner.gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"], repo);
  const url = listed.ok ? listed.stdout.trim() : "";
  return /^https:\/\//.test(url) ? url : null;
}

/**
 * 返工以后更新已经开着的 PR（用户 2026-10-26）：把分支上新的提交推到同一条远程分支，刷新 PR 描述。
 * 只做快进推送，不强推：远程分支上有本地没有的提交时报错，交给人处理。只由系统调用（auto-pull-request.ts）。
 */
export async function updateDeliveryPullRequest(
  db: Db, itemId: number, input: { reason: string; runner?: PullRequestRunner },
): Promise<TicketDelivery & { pullRequestUrl: string }> {
  return oneAtATime(itemId, async () => {
    const workspace = requireIsolated(db, itemId);
    const delivery = await ticketDelivery(db, itemId);
    const url = delivery.workspace?.pullRequestUrl ?? null;
    if (!url) throw new DeliveryError("unavailable", "这张工单还没有 PR。");
    if (delivery.workspace!.uncommittedFiles > 0) {
      throw new DeliveryError("unavailable", `分支上还有 ${delivery.workspace!.uncommittedFiles} 个没提交的文件，先让工单的 agent 提交。`);
    }
    const repo = workspace.repo_root!;
    const branch = workspace.branch!;
    const item = recheckBeforeActing(db, itemId, workspace.id, ["review", "done"], "交付以后才能更新 PR。");
    const push = await gitRun(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], repo, {
      timeout: NETWORK_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (!push.ok) throw new DeliveryError("failed", `推送分支失败：${redact(firstLine(push.stderr))}`);
    const runner = input.runner ?? defaultRunner;
    const edited = await runner.gh(["pr", "edit", url, "--body", redactSecretText(pullRequestBody(db, itemId, item))], repo);
    if (!edited.ok) {
      const detail = edited.stderr === "ENOENT" ? "这台电脑没有装 GitHub CLI（gh）" : redact(firstLine(edited.stderr));
      throw new DeliveryError("failed", `新的提交已经推上去了，PR 描述没有更新：${detail}。`);
    }
    addActivity(db, {
      itemId, actor: "system", kind: "decision",
      payload: {
        decision: "workspace_pr_updated", workspaceId: workspace.id, branch, url, head: delivery.workspace!.head, reason: input.reason,
      },
    });
    return { ...(await ticketDelivery(db, itemId)), pullRequestUrl: url };
  });
}
