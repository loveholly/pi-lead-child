import { isAbsolute, dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import type { Db } from "@pi-lead-child/store";
import { getItem, transition } from "@pi-lead-child/store";
import {
  createRun, getRun, markRunStopped, pauseRun, recordRunProfileHash, transitionRunState, updateRun, updateRunEffort,
} from "@pi-lead-child/store";
import { assertRunAllowed, executorRetryBudget } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { createIngestor } from "../pipeline/ingest.js";
import { ensurePullRequestReviewGrant } from "./pr-review-grant.js";
import { EXPRESSION_SECTION } from "@pi-lead-child/core";
import { createRuntimeEventStore, recordSecurityAlert } from "@pi-lead-child/store";
import {
  LEDGER_WRITE_ATTEMPTED_KIND, ledgerWriteAttemptAlertText, redactAndCap, redactKnownValues, secretEnvValues,
} from "@pi-lead-child/protocol";
import { commandOfToolEvent, detectLedgerWrite } from "./ledger-write-detector.js";
import { redactRuntimeEvent, scrubSessionFiles } from "./secret-scrub.js";
import { RuntimeEventSequencer } from "@pi-lead-child/runtime";
import { outputCursorOf, tagOutputCursor, type OutputCursor } from "@pi-lead-child/runtime";
import type {
  AgentRuntime, RuntimeEvent, RuntimeEventInput, RuntimeExit, RuntimeHandle, RuntimeProcess, RuntimeStartRequest,
} from "@pi-lead-child/runtime";
import { stopReattachedLauncher, type AttachableLaunch } from "@pi-lead-child/runtime";
import type { Item, Run, RunPurpose, RuntimeId, Workspace } from "@pi-lead-child/core";
import type { RpcClient } from "@pi-lead-child/runtime";
import { createLearningService } from "../coordinator/learning.js";
import { awaitWorktreeDependencies } from "../coordinator/worktree-dependencies.js";
import { fetchOrigin, refreshFreshWorktree } from "../coordinator/workspace-remote.js";
import { createCoordinator } from "../coordinator/service.js";
import { executionPlanPromptSection } from "../coordinator/execution-plan.js";
import { acceptanceCriteriaPromptSection } from "../coordinator/acceptance-criteria.js";
import { reviewPacketPromptSection } from "../coordinator/review-packet.js";
import { markItemExecutionStarted } from "@pi-lead-child/store";
import { runStartedEvent, runUpdatedEvent } from "@pi-lead-child/store";
import { runEffortFor, runModelFor } from "../coordinator/run-choice.js";
import { reviewerProfileFor } from "../coordinator/reviewer-choice.js";
import {
  attachWorkspaceToRun, createWorkspace, getWorkspace, resolveWorkspace, transitionWorkspace,
} from "@pi-lead-child/store";
import {
  failureCategory, failureNextStep, healthLevel, leadDecides, runtimeDisplayName, runtimeFailureTitle,
  sameTargetRetry, typedFailure, usageLimitLeadNextStep, type SameTargetRetry,
} from "@pi-lead-child/runtime";
import {
  classifyFailure, createLocalRuntime, LOCAL_RUNTIME_ID, runtimeProfileOf,
} from "@pi-lead-child/runtime";
import { resolveRuntimeModel, runtimeProfileHash } from "@pi-lead-child/runtime";
import { raiseBlocker, recordRuntimeHealthFailure } from "@pi-lead-child/store";
import { startAgentToolBridge, type AgentToolBridge } from "../agent-tools/host-bridge.js";
import { agentConnectionHost } from "../agent-tools/connection-host.js";
import { recordUnhandledRunFailure } from "../pipeline/run-failure.js";
import { parseMetadata, recordRegistrationPending, type RegistrationStep } from "../pipeline/run-registration.js";
import { handoffCheckStep, outcomeRecoveryStep } from "../pipeline/registration-steps.js";
import {
  completeOutcomeRepair, recordOutcomeRepairFailure, requestOutcomeRepair,
} from "../pipeline/outcome-repair.js";
import { applyTransientRetry, raiseTransientRetryBlocker } from "../pipeline/transient-retry.js";
import {
  beginReviewWorkspaceCheck, completeReviewWorkspaceCheck, pendingReviewWorkspaceCheck, reviewWorkspacePostFingerprint,
} from "../coordinator/workspace-integrity.js";
import { applyReviewAutomation } from "../coordinator/delegated-review.js";
import { createDispatcher, expireReviewRequestsForNewDelivery } from "../coordinator/dispatch.js";
import {
  automaticReviewNeeded, automaticReviewRequest, automaticReviewRuntime, requiresIndependentReview,
} from "../pipeline/automatic-review.js";
import {
  beginConversationWorkspaceCheck, loadConversationWorkspaceCheck, scheduleConversationWorkspaceCheck,
  type ConversationWorkspaceCheck,
} from "../pipeline/review-currency.js";
import { isDeliveryRun } from "../pipeline/delivery-run.js";
import { scheduleDeliveryRefreshAfterRun } from "../coordinator/delivery-snapshot.js";
import {
  disposeEndedRunCheckout, prepareRunWorkspace, pullRequestReviewTarget, runDirectory, sameWorkdirOwner,
  sharedWorkspaceReason, type RunWorkspacePreparation,
} from "../coordinator/workspace-policy.js";
import { isDisposableCheckout } from "../coordinator/workspace.js";

export interface RunOpts {
  dbPath: string;
  dataDir?: string;
  prompt: string;
  sessionDir: string;
  runtime?: AgentRuntime;
  runtimeId?: RuntimeId;
  model?: string;
  // 推理强度。没有时按 run-choice.ts 的规则沿用上一个同类 Run 的选择，再没有就不传。
  effort?: string;
  mcpServer?: { command: string; args: string[]; env?: Record<string, string> };
  resumeSessionId?: string;
  // 续接的是哪个 Run 的会话（runs.resumed_from_run_id）。只在这里建 Run 时用（没给 runId）。
  resumedFromRunId?: number;
  // 在 resumeSessionId 的副本上开始，原 session 不变（RuntimeStartRequest.forkSession）。
  forkSession?: boolean;
  // resume 或 fork 的会话已经不存在时（CLI 按保留期删了它的记录，工单 #66 的 Run #71），
  // 内核在同一个 Run 里开一个新会话，用这个函数给的提示启动它。只开一次。
  // 新会话不记得原来的对话，所以提示要带上工单的上下文（expiredSessionContext）。
  // 不给时不开新会话，这个 Run 按会话不存在失败。
  freshSessionPrompt?: () => string;
  purpose?: RunPurpose;
  runId?: number;
  piBin?: string;
  piArgs?: string[];
  extraPiArgs?: string[];
  env?: Record<string, string>;
  onEvent?: (event: RuntimeEvent, context: { itemId: number; runId: number }) => void;
  lingerMs?: number;
  role?: "executor" | "reviewer";
  // 这个 Run 结束、工单进了 review 时，自动核查用哪个 runtime（automatic-review.ts）。
  // 不给时与 orchestrator 的缺省相同。
  reviewerRuntime?: RuntimeId;
  // daemon 重启后接管这个 Run（spec D7，工单 15）。runId 必须给出。
  // 接管不经过闸门，不改工单的 stage，不新开尝试：Run 已经在跑，只是换了一个 daemon 看管。
  adopt?: { launch: AttachableLaunch };
}

export interface RunItemResult {
  runId: number;
  // daemon 正常停机时分离了这个 Run（工单 15）。Run 没有结束，重启后的 daemon 接管它。
  detached?: boolean;
}

// 这里曾有一份 RUNNABLE / validateSpawn，与 store/run-gate.ts 的 assertRunAllowed 逐条重复。
// 两份实现只要有一份漏改，就会出现"闸门放行但 spawn 拒绝"或更糟的反向情况，而且不会报错。
// 现在只剩一处规则：store/run-gate.ts（spec §6.5）。

export interface LiveChild {
  handle?: RuntimeHandle;
  toolBridge?: AgentToolBridge;
  rpc?: RpcClient;
  proc?: RuntimeProcess;
  runId: number;
  streaming: boolean;
  lingerTimer?: NodeJS.Timeout;
  // 已经处理了终止事件：Run 结束了，进程可能还在停留（例如 pi 等下一条 prompt）。
  settled?: boolean;
  // 垫片启动的进程才有：daemon 不再读它，进程继续运行（工单 15）。
  detach?: () => void;
}

const live = new Map<number, LiveChild>();
export function liveChildren(): Map<number, LiveChild> { return live; }

const RUN_STARTED_AS = "run_started_as";

/**
 * 这个 Run 实际按什么用途跑。现在每条启动路径都按库里的 purpose 跑 Run（工单消息另起 conversation Run，
 * 恢复控制按 Run 原来的用途续接），所以新的 Run 不会有不同的记录。旧版本会把暂停的执行 Run 按 conversation
 * 续接，并记下 run_started_as。daemon 重启后接管这种 Run 时，要按它当时实际的用途跑（lead 的 adoptRunChild）。
 * 这样的 Run 以后再按自己的用途启动时，recordEffectiveRunPurpose 记一条新的，把旧记录盖掉。
 */
export function effectiveRunPurpose(db: Db, run: Pick<Run, "id" | "purpose">): RunPurpose {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.purpose') AS purpose FROM activities
     WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')=?
     ORDER BY id DESC LIMIT 1`,
  ).get(run.id, RUN_STARTED_AS) as { purpose: RunPurpose | null } | undefined;
  return row?.purpose ?? run.purpose;
}

/** Run 每次启动时调用。只在实际用途和库里不同、或者以前记过不同的用途时才记一条活动。 */
export function recordEffectiveRunPurpose(
  db: Db,
  input: { itemId: number; runId: number; purpose: RunPurpose; stored: RunPurpose },
): void {
  if (effectiveRunPurpose(db, { id: input.runId, purpose: input.stored }) === input.purpose) return;
  addActivity(db, {
    itemId: input.itemId, runId: input.runId, actor: "system", kind: "decision",
    payload: { decision: RUN_STARTED_AS, purpose: input.purpose },
  });
}

export function killIdleChildren(): void {
  for (const child of live.values()) {
    if (child.streaming) continue;
    if (child.handle) void child.handle.interrupt("daemon shutdown");
    else child.proc?.kill();
  }
}

// daemon 正常停机（spec D7，工单 15）：垫片启动、还没结束的 Run 不停止。daemon 只是不再读它们，
// 重启后的 daemon 接管它们。之后才启动好的 Run 也一样分离，直到 acceptRunningChildren。
// 没有垫片的 Run 无法接管，仍按原来的方式处理：空闲的被中断，正在执行的等它结束。
let detaching = false;

export function detachRunningChildren(): number {
  detaching = true;
  let detached = 0;
  for (const child of [...live.values()]) {
    if (child.settled || !child.detach) continue;
    child.detach();
    detached += 1;
  }
  return detached;
}

// daemon 启动时调用：之后启动的 Run 照常看管。
export function acceptRunningChildren(): void {
  detaching = false;
}

function waitForProcess(proc?: RuntimeProcess): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    proc.once("exit", done);
    proc.once("error", done);
  });
}

// 调用方没有给 runtime 实例时，只有本地 runtime 能直接创建：它不需要 daemon 的配置。
// piBin、piArgs、extraPiArgs 是本地 runtime 的启动参数（例如测试的 fake pi）。
function defaultRuntime(opts: RunOpts): AgentRuntime {
  if (opts.runtimeId && opts.runtimeId !== LOCAL_RUNTIME_ID) {
    throw new Error(`runtime '${opts.runtimeId}' requires a configured runtime registry`);
  }
  return createLocalRuntime({
    bin: opts.piBin,
    prefixArgs: opts.piArgs,
    additionalArgs: opts.extraPiArgs,
    env: opts.env,
  });
}

function workspaceForRun(
  db: Db, item: Item, itemId: number,
  input: { role: "executor" | "reviewer"; purpose: RunPurpose; existingRunId?: number },
): RunWorkspacePreparation {
  // 运行前只解析一次 workspace。恢复已有 Run 时，Run 上已经捕获的 workspace
  // 优先于 item.workdir 和当前树解析，避免恢复跑到另一目录。
  if (input.existingRunId !== undefined) {
    const existingRun = getRun(db, input.existingRunId);
    if (!existingRun || existingRun.item_id !== itemId) {
      throw new Error(`run #${input.existingRunId} does not belong to item #${itemId}`);
    }
    if (existingRun.workspace_id !== null) {
      const existingWorkspace = getWorkspace(db, existingRun.workspace_id);
      if (!existingWorkspace) throw new Error(`run #${input.existingRunId} workspace is missing`);
      return { workspace: existingWorkspace };
    }
  }
  // 编码工单在隔离 worktree 里跑，PR 评审在临时检出里跑，由系统按事实判定（workspace-policy.ts）。
  const prepared = prepareRunWorkspace(db, itemId, {
    role: input.role, purpose: input.purpose,
    ...(input.existingRunId !== undefined ? { runId: input.existingRunId } : {}),
  });
  if (prepared.workspace || prepared.checkout) return prepared;

  // Legacy/new explicit workdir compatibility: materialize only the nearest same-path
  // ancestor as the owner, so a child that merely inherits its parent's path does not
  // accidentally become a second workspace owner. A child with a distinct explicit path
  // remains an explicit owner.
  if (item.workdir && isAbsolute(item.workdir)) {
    const owner = sameWorkdirOwner(db, item);
    return {
      workspace: createWorkspace(db, {
        ownerItemId: owner.id, mode: "shared", kind: "primary", path: owner.workdir!,
        projectId: owner.project_id, state: "requested",
      }),
    };
  }
  if (item.workflow_kind === "coding") {
    throw new Error(`coding item #${itemId} has no resolved workspace`);
  }
  return { workspace: null };
}

// 写进 child 提示词的工作区说明。只说系统已经定下的事实。
// 沙箱里没有 git 的凭证（2026-10-29）：child 不知道系统已经替它 fetch 过、交付后由系统推分支，就会卡成阻塞，请用户去终端里跑 git。
const SANDBOX_GIT_NOTE = "\nYour commands run in a sandbox without git credentials, so you cannot fetch, clone or push. "
  + "Before this run started, the system fetched origin for you: origin/* refs are current, so merge or rebase onto "
  + "origin/<branch> directly. For commits pushed after that, call the git_fetch tool. For content on GitHub (other repositories, pull requests, comments) use the call_connection_tool tool. "
  + "After delivery the system pushes the branch and opens a draft pull request. If something is still missing, say exactly what "
  + "with ticket_update; do not ask the user to run git in a terminal.";

function workspaceSection(db: Db, itemId: number, workspace: Workspace, role: "executor" | "reviewer"): string {
  const section = workspaceSectionBody(db, itemId, workspace, role);
  return isDisposableCheckout(workspace) ? section : `${section}${SANDBOX_GIT_NOTE}`;
}

function workspaceSectionBody(db: Db, itemId: number, workspace: Workspace, role: "executor" | "reviewer"): string {
  if (isDisposableCheckout(workspace)) {
    const target = pullRequestReviewTarget(db, itemId);
    return `\n## Pull request checkout\nYou review pull request #${target?.number ?? "?"} in a temporary detached checkout `
      + `at ${workspace.path} (commit ${workspace.base_ref ?? "n/a"}). It is deleted when this run ends, so nothing you `
      + "write here is kept. Do not fetch, check out or create branches in any other directory, and do not push.";
  }
  if (workspace.mode === "isolated" && workspace.git_worktree && role === "reviewer") {
    return `\n## Coding workspace\nThe work under review is in workspace #${workspace.id}, an isolated git worktree at `
      + `${workspace.path} on branch ${workspace.branch ?? "n/a"} (base ${workspace.base_ref ?? "n/a"}). Review it there `
      + "without changing any file, and do not switch branches.";
  }
  if (workspace.mode === "isolated" && workspace.git_worktree) {
    return `\n## Coding workspace\nYou work in workspace #${workspace.id}, an isolated git worktree at ${workspace.path} `
      + `on branch ${workspace.branch ?? "n/a"} (base ${workspace.base_ref ?? "n/a"}). The user's own checkout is not touched. `
      + "Commit your work on this branch. After the ticket is accepted, the branch is merged into the user's checkout "
      + "when the user agrees; nothing you leave uncommitted is merged. "
      + "Do not switch branches, do not push, and do not edit outside this worktree. Dependencies (for example "
      + "node_modules) are not installed in a new worktree: install them here when you need to build or run tests.";
  }
  const reason = sharedWorkspaceReason(db, workspace);
  return `\n## Coding workspace\nWorkspace #${workspace.id} is the shared checkout at ${workspace.path}`
    + `${reason ? ` (shared on purpose: ${reason})` : ""}.\n`
    + `Do not switch branches or edit outside this workspace. Base ref: ${workspace.base_ref ?? "n/a"}.`;
}

// 这个 Run 已经结束、被停下或暂停：之后进程报的失败不是这个 Run 的失败。
const QUIET_RUN_STATES: readonly Run["state"][] = ["finished", "failed", "stopped", "paused"];

function quietRun(db: Db, runId: number): boolean {
  return QUIET_RUN_STATES.includes(getRun(db, runId)?.state ?? "starting");
}

// 这个 Run 换过的模型和强度（工单 08 的 set_run_profile）：跑着的时候换的（in_run），或者暂停时换、继续时用的（on_resume），
// 取最近的一次。没换过时为 null。
function currentRunProfile(db: Db, runId: number): { model: string | null; effort: string | null } | null {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.to.model') AS model, json_extract(payload, '$.to.effort') AS effort FROM activities
     WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')='run_profile_changed'
       AND json_extract(payload, '$.applied') IN ('in_run', 'on_resume')
     ORDER BY id DESC LIMIT 1`,
  ).get(runId) as { model: string | null; effort: string | null } | undefined;
  return row ?? null;
}

// 换上的模型的 CLI 写法。换的时候已经核对过（run-profile.ts）；这里在记失败的事务里，万一换不了就照原样用，不让记账失败。
function cliModel(runtime: RuntimeId, model: string | null): string | undefined {
  try {
    return resolveRuntimeModel(runtime, model);
  } catch {
    return model ?? undefined;
  }
}

// 启动在开始之前就被拒绝：同一张工单已有 live 的 Run，或闸门不放行。这个 Run 没有开始，拒绝不是它的失败。
class RunStartRefusedError extends Error {}

export async function runItem(
  db: Db,
  itemId: number,
  opts: RunOpts,
): Promise<RunItemResult> {
  let trackedRunId = opts.runId;
  try {
    const result = await runItemLifecycle(db, itemId, opts, (runId) => { trackedRunId = runId; });
    // PR 评审的临时检出只属于这个 Run：Run 结束（成功、失败、停止）就删。分离的 Run 还在跑，不删。
    if (!result.detached) disposeEndedRunCheckout(db, result.runId);
    return result;
  } catch (error) {
    if (error instanceof RunStartRefusedError && !opts.adopt) {
      if (trackedRunId !== undefined) settleRefusedStart(db, { itemId, runId: trackedRunId, reason: error.message });
      throw error;
    }
    if (trackedRunId !== undefined) {
      recordUnhandledRunFailure(db, { itemId, runId: trackedRunId, error });
    }
    // 只清理这个 Run 自己的 live 条目。live 表里别的 Run（例如这次启动撞上的那个）不能删，更不能中断。
    const entry = live.get(itemId);
    const child = entry && entry.runId === trackedRunId ? entry : undefined;
    if (child?.lingerTimer) clearNodeTimeout(child.lingerTimer);
    if (child) live.delete(itemId);
    try { await child?.handle?.interrupt("unhandled run exception"); } catch { /* best effort */ }
    try { await child?.toolBridge?.close(); } catch { /* best effort */ }
    // 接管在开始看管之前就出错时，Run 已经记为失败。CLI 不能没人看管地继续跑。
    if (opts.adopt?.launch.state === "alive" && !child?.handle) stopReattachedLauncher(opts.adopt.launch);
    if (trackedRunId !== undefined) disposeEndedRunCheckout(db, trackedRunId);
    throw error;
  }
}

// 被拒绝的启动不能让 Run 停在 starting 或 running：恢复的 Run（恢复控制已把它翻成 running）回到 paused，
// 新建的 Run 记为 stopped。两种都不升起 blocker，也不扣重试额度。原因记在一条活动里。
function settleRefusedStart(db: Db, input: { itemId: number; runId: number; reason: string }): void {
  db.transaction(() => {
    const state = getRun(db, input.runId)?.state;
    if (state === "running") {
      pauseRun(db, input.runId);
    } else if (state === "starting") {
      markRunStopped(db, input.runId, { errorCode: "run_start_refused", errorMessage: input.reason.slice(0, 1_000) });
    } else {
      return;
    }
    addActivity(db, {
      itemId: input.itemId, runId: input.runId, actor: "system", kind: "decision",
      payload: { decision: "run_start_refused", reason: input.reason.slice(0, 200), state: getRun(db, input.runId)?.state },
    });
  }).immediate();
}

async function runItemLifecycle(
  db: Db,
  itemId: number,
  opts: RunOpts,
  onRunKnown: (runId: number) => void,
): Promise<RunItemResult> {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  if (live.has(itemId)) throw new RunStartRefusedError(`item #${itemId} already has a live runtime`);
  const adopt = opts.adopt;
  if (adopt && opts.runId === undefined) throw new Error("adopting a run requires its run id");
  const role = opts.role ?? "executor";
  const purpose = opts.purpose ?? (role === "reviewer" ? "review" : item.purpose ?? "execution");
  // 闸门必须在这里显式跑一遍，而不是只依赖下面的 createRun：调用方可以传 opts.runId
  // 复用一个已建好的 Run，那条路径根本不经过 createRun。
  // 接管的 Run 已经在跑，闸门管的是启动，所以不再跑一遍。
  if (!adopt) {
    // 已经建好的修复回合（恢复、认领）也核对它的来源 Run（发布评审 run-resume F6）。
    const existing = opts.runId === undefined ? undefined : getRun(db, opts.runId);
    try {
      assertRunAllowed(db, {
        itemId, role, purpose,
        ...(purpose === "outcome_repair" && existing ? { sourceRunId: existing.resumed_from_run_id, repairRunId: existing.id } : {}),
      });
    } catch (error) {
      throw new RunStartRefusedError(error instanceof Error ? error.message : String(error));
    }
  }
  const runtime = opts.runtime ?? defaultRuntime(opts);
  if (adopt && !runtime.attach) throw new Error(`runtime '${runtime.id}' cannot adopt a running CLI`);
  // 接管时沿用 Run 上记下的模型，不再按当前配置解析。其他情况按 run-choice.ts 的同一条规则选：
  // 核查和工单对话不再拿执行者的模型。
  const existingRun = opts.runId === undefined ? undefined : getRun(db, opts.runId);
  // 核查 Run 用这张工单现在的核查员（reviewer-choice.ts，按能不能用换过的）的模型和推理强度。
  const reviewer = adopt ? null : reviewerProfileFor(db, itemId, role);
  const model = adopt ? opts.model : runModelFor({ explicit: opts.model, role, runtime: runtime.id, item, reviewer });
  const effort = adopt
    ? opts.effort ?? existingRun?.effort ?? undefined
    : opts.effort ?? existingRun?.effort ?? runEffortFor(db, { itemId, role, purpose, runtime: runtime.id, model, reviewer });
  // Resolve/provision the workspace only after runtime/model preflight, but before changing
  // item stage or creating a Run. This avoids a failed model selection leaving a workspace row.
  const preparation = workspaceForRun(db, item, itemId, {
    role, purpose, ...(opts.runId !== undefined ? { existingRunId: opts.runId } : {}),
  });
  let workspace = preparation.workspace;
  // 判定可能把工单标成了 coding（workspace-policy.ts）：后面的提示和环境变量按判定后的值写。
  const workflowKind = getItem(db, itemId)?.workflow_kind ?? item.workflow_kind;
  if (workspace && ["released", "cleaning", "cleaned", "archived", "failed", "blocked"].includes(workspace.state)) {
    throw new Error(`workspace #${workspace.id} is not launchable in state ${workspace.state}`);
  }
  if (!adopt && role === "executor" && purpose === "execution") {
    // 开跑是编排机器的动作，不是 lead 的工具调用（spec §6.4：ready → active 只有 user/system）。
    if (item.stage === "ready") {
      transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    } else if (item.stage === "blocked") {
      transition(db, { itemId, to: "active", actor: "system", reason: "retry run" });
    }
  }

  // 每个 Run 记录它用的 profile hash（工单 05）。
  const profileHash = runtimeProfileHash(runtimeProfileOf(runtime));
  const runId = opts.runId ?? createRun(db, {
    itemId, role, runtime: runtime.id, purpose, model, effort, workspaceId: workspace?.id, runtimeProfileHash: profileHash,
    ...(opts.resumedFromRunId !== undefined ? { resumedFromRunId: opts.resumedFromRunId } : {}),
  });
  if (opts.runId !== undefined && effort && !existingRun?.effort) updateRunEffort(db, runId, effort);
  onRunKnown(runId);
  recordRunProfileHash(db, runId, profileHash);
  // 用户本人要的 PR 评审：评审 Run 的写入只限这个 PR（pr-review-grant.ts）。在 child 起来以前建好，第一次调用就按它查。
  ensurePullRequestReviewGrant(db, { itemId, runId, role, purpose });
  // 新一次交付开始：之前排着的核查请求都作废（dispatch.ts）。
  if (!adopt && isDeliveryRun({ role, purpose })) expireReviewRequestsForNewDelivery(db, { itemId, runId });
  let run = getRun(db, runId);
  if (!run || run.item_id !== itemId) throw new Error(`run #${runId} does not belong to item #${itemId}`);
  // 记下这次实际按什么用途跑，daemon 重启后接管时读回（effectiveRunPurpose）。
  if (!adopt) recordEffectiveRunPurpose(db, { itemId, runId, purpose, stored: run.purpose });
  // PR 评审的临时检出要 fetch：Run 建好以后再等它（workspace-policy.ts）。失败时这个 Run 按宿主出错记下。
  if (preparation.checkout) workspace = await preparation.checkout(runId);
  if (workspace && run.workspace_id === null) {
    attachWorkspaceToRun(db, { runId, workspaceId: workspace.id });
    run = getRun(db, runId)!;
  }
  if (run.workspace_id !== null && workspace && run.workspace_id !== workspace.id) {
    throw new Error(`run #${runId} workspace #${run.workspace_id} disagrees with resolved workspace #${workspace.id}`);
  }
  // 沙箱里的 child 没有 git 的凭证：daemon 先在沙箱外替它 fetch 一次 origin（workspace-remote.ts，2026-10-29），返工和核查
  // 一开始就看得到最新的远端；新切的 worktree 还没有提交时快进到最新的 origin。失败不挡启动。
  // 放在建 Run 之后：启动闸门、建 Run、工单从 blocked 回到 active 要同步做完。daemon 重启接管孤儿时，紧接着的补发
  // blocker 按工单状态判断；这之前 await 一次，它会把正在重派的工单当成阻塞，多补一条 blocker。
  if (!adopt && purpose !== "lookup") {
    const fetched = await fetchOrigin(workspace?.path ?? item.workdir);
    if (fetched.fetched && workspace) workspace = refreshFreshWorktree(db, workspace) ?? workspace;
  }
  const dataDir = opts.dataDir ?? dirname(dirname(opts.sessionDir));
  // 已知密钥的值（2026-10-19 审查）：child 继承 daemon 的全部环境，`env | grep` 会把它们打进事件。
  // 事件进 ingest、落库、写 runtime-events 之前盖掉；工具桥开好以后再加上它的 token。
  let secretValues = secretEnvValues({ ...process.env, ...opts.env });
  const eventStore = createRuntimeEventStore(db, { dataDir, redact: (payload) => redactKnownValues(payload, secretValues) });
  const learning = createLearningService(db, { dataDir });
  const ingestor = createIngestor(db, { itemId, runId });
  const synthetic = new RuntimeEventSequencer(runId);
  // 内核自己产生的失败事件（启动出错、进程退出却没有终止事件）接在已经落库的事件后面。
  // 恢复的 Run 已经有事件，从 1 编号会和它们撞 seq，INSERT OR IGNORE 就把这个事件丢了。
  const syntheticEvent = (input: RuntimeEventInput): RuntimeEvent =>
    ({ ...synthetic.event(input), seq: Number(getRun(db, runId)?.event_cursor ?? 0) + 1 }) as RuntimeEvent;
  const lifecycleCoordinator = (at: Date) => createCoordinator({ db, now: () => at });

  const recordRunStarted = (event: Extract<RuntimeEvent, { type: "run.started" }>) => {
    const at = new Date(event.occurredAt);
    db.transaction(() => {
      ingestor.onEvent(event);
      if (role === "executor" && purpose === "execution") markItemExecutionStarted(db, itemId, at);
      lifecycleCoordinator(at).recordSystemCheckpoint({
        itemId,
        runId,
        kind: "progress",
        title: "Run started",
        summary: `${event.runtime} run #${runId} started${event.model ? ` with ${event.model}` : ""}.`,
        nextStep: purpose === "conversation"
          ? "Answer the ticket-scoped conversation without changing the task lifecycle."
          : purpose === "lookup"
            ? "Answer the read-only lookup and submit its result; the lookup launcher closes the ticket."
          : purpose === "outcome_repair"
            ? `Resubmit the outcome of run #${run.resumed_from_run_id ?? "-"} without changing the task lifecycle.`
            : "Continue the assigned execution phase.",
        idempotencyKey: `run-start:${runId}`,
        precedingEvents: [runStartedEvent(itemId, runId)],
      });
    }).immediate();
  };

  const recordRunCrash = (event: Extract<RuntimeEvent, { type: "run.failed" }>) => {
    if (quietRun(db, runId)) return;
    const at = new Date(event.occurredAt);
    db.transaction(() => {
      if (quietRun(db, runId)) return;
      updateRun(db, runId, {
        exitCode: event.exitCode,
        errorCode: event.errorCode,
        errorMessage: event.error,
      });
      ingestor.onEvent(event);
      const failure = event.failure;
      const asksLead = leadDecides(failure);
      addActivity(db, {
        itemId,
        runId,
        actor: "system",
        kind: "decision",
        payload: {
          decision: "runtime_failure_classified",
          scope: failure.scope,
          retry: failure.retry,
          needs: failure.needs,
          code: failure.code,
          category: failureCategory(failure),
          leadDecides: asksLead,
          errorCode: event.errorCode,
        },
      });
      // 账号和配置故障记在健康账本上（spec D2）。同一次故障只通知一次。
      // 内核为失败的 Run 排一个重试请求。目标不可用，所以这个请求挂起。
      // 恢复后，请求用同一个 runtime 接着做。session 已有进展时，它 resume 这个 session。
      // 工单对话不重试。
      // 代查（lookup）的失败不进健康账本：它用自己的 profile 身份，失败只交回通道 hub，不挂起派发、不通知、不排重试。
      const ledgerFailure = purpose !== "lookup" && healthLevel(failure) !== null;
      // 换模型或换 runtime 是 Lead 的决定（2026-10-15 用户决定）：内核只记下故障、通知一次、排这个默认的重试。
      // Lead 读到故障说明后可以用 recover_ticket_run 换一个；之后的 Run 会让这个重试作废（dispatch.ts 的 supersededRetry）。
      // 例外是用量额度用完（runtime 的 sameTargetRetry）：探针看不到额度，重试等故障关闭就放回同一个用完的模型，
      // 工单 #117 就这样连着失败五次。报错里写了重置时间时，重试不早于那个时间；没写时不排，工单交给 Lead（下面的 blocker）。
      // 核查照旧排：认领时派发器自动换一个能用的核查员（dispatch.ts 的 switchReviewer），不会回到这个用完的模型。
      let notRetried: SameTargetRetry | null = null;
      if (ledgerFailure) {
        // 这个 Run 换过模型和强度（工单 08：跑着时不停进程换，或者暂停时换）：故障出在现在的模型上，重试也用现在的。
        // 换上的模型按 runModelFor 的同一条规则换成 CLI 的写法（例如 Codex 去掉 openai/ 前缀）：故障账本和派发 gate 按这个写法查。
        const switched = currentRunProfile(db, runId);
        const failedModel = switched ? cliModel(runtime.id, switched.model) : model;
        const failedEffort = switched ? switched.effort ?? undefined : effort;
        const retries = purpose === "execution" || purpose === "review" || purpose === "integration";
        const retry: SameTargetRetry = !retries
          ? { queue: false }
          : role === "reviewer" ? { queue: true, notBefore: null } : sameTargetRetry(failure, at);
        recordRuntimeHealthFailure(db, {
          profile: runtimeProfileOf(runtime), model: failedModel, failure, itemId, runId, at,
          ...(failure.code === "usage_limited" ? { leadNextStep: usageLimitLeadNextStep({ itemId, runId, role, retry }) } : {}),
        });
        if (retries && retry.queue) {
          const failedRun = getRun(db, runId)!;
          createDispatcher(db).request({
            itemId, role, purpose, runtime: runtime.id, model: failedModel, effort: failedEffort,
            resumeFromRunId: failedRun.external_session_id ? runId : undefined,
            retryOfRunId: runId,
            ...(retry.notBefore ? { notBefore: retry.notBefore.toISOString() } : {}),
            trigger: "runtime-health-retry",
            idempotencyKey: `runtime-health-retry:${runId}`,
          });
        } else if (retries) {
          notRetried = retry;
        }
      }
      // 瞬时失败（spec D5，工单 06）：内核退避后自动重试，session 已有进展时 resume 它。
      // 到上限时，工单转为 blocked，profile 标成 degraded。唯一的 blocker 在下面的检查点之后升起。
      const transientRetry = applyTransientRetry(db, {
        runId, failure, at, resume: runtime.capabilities.resume, profile: runtimeProfileOf(runtime),
      });
      const retrying = transientRetry?.kind === "retry";
      // ingestor 刚刚把这次失败计入重试预算，所以这里读到的就是结算后的预算。
      // 预算用尽时 nextStep 必须改口：还在那儿写"retry"，就是在指使 lead 去撞闸门，
      // 而这张检查点是 leadVisible 的——它读到的下一步不能和系统的决定相反。
      // 只有 task 和 unknown 请 lead 参与（spec D1）。其他作用域的"下一步"只做说明，
      // 不让 lead 去调恢复工具；用户明确要求时，lead 仍然可以手动恢复。
      // 修复回合失败：原来的 blocker 保留，不再写「Run crashed」这类 blocked 检查点（spec D4）。
      if (purpose === "outcome_repair") {
        const reason = failure.code === "session_not_found" ? "session_expired" : "run_failed";
        recordOutcomeRepairFailure(db, { repairRunId: runId, reason, detail: event.error, at });
        return;
      }
      // 工单对话失败不写「Run crashed」这类 blocked 检查点：工单没有受阻。
      // 会话里那条带着失败原因的回执就是这次失败的记录（#66 的一次失败曾经出现四次）。
      if (purpose === "conversation") return;
      // 代查失败也不写 blocked 检查点：工单没有受阻，结果交回通道 hub（slack-takeover spec D5）。
      if (purpose === "lookup") return;
      const budget = executorRetryBudget(db, itemId);
      const runModel = getRun(db, runId)?.model ?? "默认模型";
      const agentName = runtimeDisplayName(runtime.id);
      const recorded = lifecycleCoordinator(at).recordSystemCheckpoint({
        itemId,
        runId,
        // 内核排了退避重试时，工单没有受阻。检查点只记下这次失败和接下来会发生什么。
        kind: retrying ? "progress" : "blocked",
        title: asksLead ? "Run crashed" : runtimeFailureTitle(runtime.id, failure),
        summary: asksLead
          ? `Run #${runId} crashed (${event.errorCode}): ${event.error.slice(0, 1_600)}`
          : `${agentName} · Run #${runId} · ${event.error.slice(0, 1_600)}`,
        nextStep: !asksLead
          ? failureNextStep(runtime.id, failure, transientRetry ?? undefined)
          : budget.exhausted
            ? `Retries are exhausted (${budget.failures}/${budget.retryLimit}); dispatch is halted. `
              + "Do not retry or open a second item — put the failure to the user and let them decide."
            : "Inspect the runtime failure, adjust the execution path if needed, and retry.",
        keyFacts: [
          { label: "Agent", value: agentName },
          { label: "Runtime", value: runtime.id },
          { label: "Model", value: runModel },
          { label: "Failure category", value: failureCategory(failure) },
          { label: "Failure scope", value: failure.scope },
          { label: "Needs", value: failure.needs },
          { label: "Error code", value: event.errorCode },
        ],
        idempotencyKey: `run-crash:${runId}`,
        // 账本上的故障，lead 的说明是故障的那一条 inbox 说明。检查点只留在工单时间线上，不再给 lead 一张卡片。
        // 退避重试也一样：lead 的说明是 transient-retry 写的那一条 inbox 说明（工单 06）。
        leadVisible: !ledgerFailure && !retrying,
        precedingEvents: [runUpdatedEvent(itemId, runId)],
      });
      if (transientRetry?.kind === "exhausted") {
        raiseTransientRetryBlocker(db, {
          runId, failure, note: transientRetry, checkpointId: recorded.checkpoint.id, at,
        });
      }
      // 内核没有排重试（额度用完、看不出什么时候恢复）：没有别的东西会让这张工单接着走，所以交给 Lead。
      // 一条只给 Lead 的 blocker（和崩溃同一个键，daemon 重启时的补发认得它），工单进 blocked；
      // Lead 用 recover_ticket_run 换 runtime 时，工单回到 active（runItem）。
      if (notRetried) {
        raiseBlocker(db, {
          needsUser: false,
          itemId,
          runId,
          code: failure.code,
          title: runtimeFailureTitle(runtime.id, failure),
          summary: `${agentName} · Run #${runId} · ${event.error.slice(0, 1_400)}`,
          nextStep: failureNextStep(runtime.id, failure),
          leadNextStep: usageLimitLeadNextStep({ itemId, runId, role, retry: notRetried }),
          source: "structural",
          dedupKey: `run-crash:${runId}`,
          evidence: {
            errorCode: event.errorCode,
            failure: { scope: failure.scope, retry: failure.retry, needs: failure.needs, code: failure.code },
          },
          at,
        });
        if (getItem(db, itemId)?.stage === "active") {
          transition(db, {
            itemId, to: "blocked", actor: "system", runId,
            reason: `${runtimeFailureTitle(runtime.id, failure)}：系统不在这个模型上自动重试，等 Lead 换 runtime`,
          });
        }
      }
    }).immediate();
  };

  // 登记的每一步各自提交（spec D3）。某一步抛错时，Run 保持 finished，记下登记待处理，
  // 后面的步骤不再执行。连登记待处理都记不下时，原异常交给 runItem 的兜底边界。
  let registrationPending = false;
  const registrationStep = <T>(step: RegistrationStep, at: Date, work: () => T): T | undefined => {
    if (registrationPending) return undefined;
    try {
      return work();
    } catch (error) {
      registrationPending = true;
      if (!recordRegistrationPending(db, { itemId, runId, step, error, at })) throw error;
      return undefined;
    }
  };

  const recordRunCompleted = (event: Extract<RuntimeEvent, { type: "run.completed" }>) => {
    const at = new Date(event.occurredAt);
    // 第一笔事务只写退出事实：退出码、finished 和结束时间。
    // 终止事件和最后一条助手消息在处理前已经写进 runtime_events。
    // 后续步骤出错时，这些事实都不会回滚。
    db.transaction(() => {
      updateRun(db, runId, { state: "finished", endedAt: true, exitCode: event.exitCode });
    }).immediate();
    if (purpose === "outcome_repair") {
      // 修复回合（spec D4）不走成果恢复和交接检查。它的成果登记在来源 Run 上。
      // 这里出错时不记登记待处理，也不升起新的 blocker：修复失败，来源 Run 原来的 blocker 保留。
      try {
        db.transaction(() => ingestor.onEvent(event)).immediate();
      } catch (error) {
        recordOutcomeRepairFailure(db, { repairRunId: runId, reason: "host_error", detail: String(error), at });
        return;
      }
      completeOutcomeRepair(db, { repairRunId: runId, at });
      return;
    }
    const outcome = registrationStep("ingest", at, () => db.transaction(() => ingestor.onEvent(event)).immediate());
    // 成果恢复和交接检查与启动时的重新登记（工单 08）共用同一份代码。
    registrationStep("outcome_recovery", at, () => db.transaction(() => {
      outcomeRecoveryStep(db, { itemId, runId, at });
    }).immediate());
    registrationStep("handoff_check", at, () => db.transaction(() => {
      handoffCheckStep(db, { itemId, runId, at, ingest: outcome });
    }).immediate());
  };

  // 接管的 Run 不是一次新的尝试。原来的 attempt_start 已经记下，结束时照常记 attempt_end。
  if (!adopt) {
    addActivity(db, {
      itemId, runId, actor: "system", kind: "attempt_start",
      payload: { runtime: runtime.id, model: model ?? null, effort: effort ?? null },
    });
  }
  db.prepare("UPDATE items SET last_activity_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
    .run(itemId);

  let handle: RuntimeHandle;
  // 这个 Run 从什么时候开始写会话文件：收尾时只清这之后改过的（scrubSessionFiles）。
  const runStartedAtMs = Date.now();
  let toolBridge: AgentToolBridge | null = null;
  let conversationCheck: ConversationWorkspaceCheck | null = null;
  const runWorkspace = run.workspace_id === null ? workspace : getWorkspace(db, run.workspace_id);
  if (run.workspace_id !== null && !runWorkspace) throw new Error(`run #${runId} workspace is missing`);
  const workdir = runWorkspace ? runDirectory(db, runWorkspace) : item.workdir ?? process.cwd();
  const codingSkill = runWorkspace && (workflowKind === "coding" || runWorkspace.git_worktree)
    ? workspaceSection(db, itemId, runWorkspace, role)
    : "";
  // 启动 runtime 的请求。resume 或 fork 的会话不存在时，同一个 Run 不带 resume、不 fork、换一个提示再启动一次
  // （startFreshSession）。工具桥在第一次启动之前建好，两次启动用同一个。
  // 新会话的第一条提示末尾带上表达规则（core/expression.ts）。续接和 fork 的会话里已经有它，不重复发。
  // 执行者每次启动都带上现在的执行计划（工单 06 审查 H1）：换 runtime 的恢复、不续接的派发、会话过期都会开新会话，
  // 新会话不记得原计划。在启动的那一刻读，开新会话重试时读到的是最新的一版。核查员不带（spec 5.2：它对照验收标准）。
  // 修复回合只补交成果，代查不是工单的工作，都不带。
  const planSection = () => role === "executor" && purpose !== "outcome_repair" && purpose !== "lookup"
    ? executionPlanPromptSection(db, itemId)
    : "";
  // 结构化验收标准（工单 05）：和计划一样，执行者每次启动都带上逐条编号的现在这一版（返工前 Lead 或用户可能改过），
  // 同时记下它看到的版本，之后判断「执行者做的不是现在这一版」（审查 M2）。核查员看的是核查包（下面的 packetSection）。
  const criteriaSection = () => role === "executor" && purpose !== "outcome_repair" && purpose !== "lookup"
    ? acceptanceCriteriaPromptSection(db, itemId, { runId })
    : "";
  // 核查包（工单 10，spec 5.7）：核查员每次启动都带上，由系统拼好，不经过模型。在启动 runtime 之前准备好（要先补存交付快照），
  // 一个核查 Run 一份，开新会话重试时用同一份。
  let packetSection = "";
  const startRequest = (prompt: string, resumeSessionId: string | undefined, forkSession: boolean): RuntimeStartRequest => ({
    itemId, runId, role, purpose,
    prompt: [
      `${prompt}${codingSkill}`, packetSection, criteriaSection(), planSection(), resumeSessionId ? "" : EXPRESSION_SECTION,
    ].filter(Boolean).join("\n\n"),
    workdir, sessionDir: opts.sessionDir,
    // 启动垫片的文件放在数据目录里（工单 14），daemon 重启后还能找到（工单 15）。
    launchDir: join(dataDir, "launches"),
    model, resumeSessionId,
    ...(effort ? { effort } : {}),
    ...(resumeSessionId && forkSession ? { forkSession: true } : {}),
    env: {
      ...opts.env,
      PLC_DB: opts.dbPath,
      PLC_TICKET_ID: String(itemId),
      PLC_ATTEMPT_ID: String(runId),
      // 这次 Run 的 runtime 和模型（2026-10-19）：PR 评审的评论要注明执行模型（lead 的 templates/pr-review.ts）。
      // 模型为空表示 CLI 用自己的默认模型。
      PLC_RUN_RUNTIME: runtime.id,
      PLC_RUN_MODEL: model ?? "",
      PLC_WORKFLOW_KIND: workflowKind,
      PLC_DATA_DIR: dataDir,
      ...(runWorkspace ? {
        PLC_WORKSPACE_ID: String(runWorkspace.id),
        PLC_WORKSPACE_PATH: runWorkspace.path,
        PLC_WORKSPACE_MODE: runWorkspace.mode,
        PLC_WORKSPACE_KIND: runWorkspace.kind,
        ...(runWorkspace.branch ? { PLC_WORKSPACE_BRANCH: runWorkspace.branch } : {}),
        ...(runWorkspace.base_ref ? { PLC_WORKSPACE_BASE_REF: runWorkspace.base_ref } : {}),
      } : {}),
      ...(toolBridge ? {
        PLC_AGENT_TOOL_SOCKET: toolBridge.socketPath,
        PLC_AGENT_TOOL_TOKEN: toolBridge.token,
      } : {}),
    },
    mcpServer: opts.mcpServer ? {
      ...opts.mcpServer,
      env: {
        ...(opts.mcpServer.env ?? {}),
        PLC_DB: opts.dbPath,
        PLC_TICKET_ID: String(itemId),
        PLC_ATTEMPT_ID: String(runId),
        ...(runWorkspace ? {
          PLC_WORKSPACE_ID: String(runWorkspace.id),
          PLC_WORKSPACE_PATH: runWorkspace.path,
          PLC_WORKSPACE_MODE: runWorkspace.mode,
          PLC_WORKSPACE_KIND: runWorkspace.kind,
          ...(runWorkspace.branch ? { PLC_WORKSPACE_BRANCH: runWorkspace.branch } : {}),
          ...(runWorkspace.base_ref ? { PLC_WORKSPACE_BASE_REF: runWorkspace.base_ref } : {}),
        } : {}),
        PLC_AGENT_TOOL_SOCKET: toolBridge!.socketPath,
        PLC_AGENT_TOOL_TOKEN: toolBridge!.token,
      },
    } : undefined,
  });
  // 在调用 runtime 之前，内核自己准备 Run：工作区、工作目录、工具桥。这一段失败时，runtime 没有启动，
  // 故障在宿主，不在 runtime。按 runtime 启动失败分类会挂起整个 profile，别的工单也派不出去（run 66）。
  let runtimeStarting = false;
  try {
    // 接管的 reviewer 已经在启动时开始了工作区检查，再开始一次会覆盖评审前的哈希。
    // 只有真正的核查（purpose=review）才锁工作区、记核查前的哈希。和 reviewer agent 的对话
    // （purpose=conversation）不是核查：它不能把工作区锁成 review_hold，也不能留下一条核查记录。
    if (!adopt && role === "reviewer" && purpose === "review" && runWorkspace) {
      if (runWorkspace.state === "requested") {
        transitionWorkspace(db, runWorkspace.id, "provisioning");
        transitionWorkspace(db, runWorkspace.id, "active");
      } else if (runWorkspace.state === "provisioning") {
        transitionWorkspace(db, runWorkspace.id, "active");
      }
      if (["active", "idle"].includes(runWorkspace.state)) transitionWorkspace(db, runWorkspace.id, "review_hold");
      await beginReviewWorkspaceCheck(db, runId, getWorkspace(db, runWorkspace.id)!);
    }
    if (!adopt && role === "reviewer") packetSection = await reviewPacketPromptSection(db, { itemId, runId, purpose });
    mkdirSync(workdir, { recursive: true });
    // 工单对话自己改了工作区，核查结论才过期（review-currency.ts）：runtime 启动之前，先在这个 Run
    // 自己的工作区上记下指纹。接管的 Run 早已开始：读回它启动时记下的指纹。
    conversationCheck = adopt
      ? loadConversationWorkspaceCheck(db, { itemId, runId, purpose })
      : await beginConversationWorkspaceCheck(db, {
          itemId, runId, purpose,
          // PR 的临时检出在 Run 结束时就删了，它的指纹说明不了什么。
          path: runWorkspace && isDisposableCheckout(runWorkspace)
            ? null
            : runWorkspace?.path ?? (item.workdir && isAbsolute(item.workdir) ? item.workdir : null),
        });
    if (adopt) {
      toolBridge = await restoreToolBridge(db, { itemId, runId, workdir, dataDir, env: opts.env, launch: adopt.launch });
    } else if (purpose !== "lookup" && (opts.mcpServer || agentConnectionHost())) {
      // 代查跑在 daemon 进程里，工具是自己的受限工具（lead 的 lookup/），不开工具桥。
      // 没有 MCP 的 runtime（pi）也开工具桥：连接的工具只在 daemon 进程里，pi 的扩展经这个桥调用它们。
      toolBridge = await startAgentToolBridge({
        db,
        itemId,
        runId,
        workdir,
        dataDir,
        env: opts.env,
      });
    }
    if (toolBridge) secretValues = secretEnvValues({ ...process.env, ...opts.env, PLC_AGENT_TOOL_TOKEN: toolBridge.token });
    // 新建的隔离 worktree 在后台克隆依赖（coordinator/worktree-dependencies.ts）：先等它做完，执行者一开始就能跑测试。
    if (!adopt) await awaitWorktreeDependencies(workdir);
    runtimeStarting = true;
    handle = adopt ? await runtime.attach!({
      itemId, runId, role, purpose, workdir, model,
      toolChannel: opts.mcpServer !== undefined,
      resumeSessionId: opts.resumeSessionId,
      launch: adopt.launch,
    }) : await runtime.start(startRequest(opts.prompt, opts.resumeSessionId, opts.forkSession === true));
  } catch (error) {
    await toolBridge?.close();
    // 接管出错时，不把它当成启动失败：交给 runItem 的兜底边界，Run 记为宿主出错，CLI 被停止。
    if (adopt) throw error;
    // Run 没有启动时，requested 的工作区保持原样：它是用户自己的目录，内核没有为它准备任何东西。
    // 标成 failed 会让这张工单再也启动不了 Run，故障恢复后的重试也一样（工单 79）。
    const currentWorkspace = workspace ? getWorkspace(db, workspace.id) : undefined;
    if (currentWorkspace?.state === "provisioning") transitionWorkspace(db, currentWorkspace.id, "failed");
    // runtime.start 抛错时没有 adapter 给出的类型，由内核按同一张映射表兜底分类。
    // 准备阶段的失败是宿主的失败（spec D1：host / never / code_fix），只阻塞这张工单。
    const errorCode = runtimeStarting ? "spawn_error" : "run_setup_failed";
    const failed = syntheticEvent({
      type: "run.failed", exitCode: null, errorCode, error: String(error),
      failure: runtimeStarting
        ? classifyFailure(runtime.id, { errorCode, message: String(error) })
        : typedFailure("host_exception", { errorCode, message: String(error) }),
    });
    if (failed.type !== "run.failed") throw new Error("synthetic spawn failure event is invalid");
    eventStore.persist(failed);
    recordRunCrash(failed);
    opts.onEvent?.(failed, { itemId, runId });
    addActivity(db, {
      itemId, runId, actor: "system", kind: "attempt_end",
      payload: { finalItemStage: getItem(db, itemId)?.stage, runtime: runtime.id },
    });
    return { runId };
  }

  // 垫片的身份记在 Run 上（工单 14），工单 15 重启后据此认出还活着的垫片。
  // 工具桥的路径和 token 也记在这里，接管时在同一处重建它。
  // 每次启动有自己的输出文件，所以输出游标从头开始。接管的 Run 身份和游标都不变。
  // seqBase：这个进程的事件接在哪个 seq 后面（见下面 seqBase 的说明）。
  const recordLaunch = (seqBase: number): void => {
    const launcher = handle.process?.launcher;
    updateRun(db, runId, {
      pid: handle.pid ?? undefined,
      ...(launcher ? {
        launcher: {
          ...launcher,
          ...(toolBridge ? { toolBridge: { socketPath: toolBridge.socketPath, token: toolBridge.token } } : {}),
          ...(seqBase > 0 ? { seqBase } : {}),
        },
        outputCursor: null,
      } : {}),
    });
  };
  // 这个进程的事件从哪个 seq 往后编号。adapter 每次启动都从 1 编号。
  // - 新的 Run：0。
  // - 恢复一个暂停的 Run（同一个 Run，新进程）：接在这个 Run 已经落库的事件后面（event_cursor）。
  //   以前从 1 编号，前 event_cursor 个事件撞上已经落库的 seq，被丢掉，Run 可能一直停在 running。
  // - 接管：沿用启动时记在垫片身份里的偏移。
  // 同一个 Run 开新会话时（startFreshSession）也一样，接在已经落库的事件后面。
  let processedSeq = Number(run.event_cursor ?? 0);
  let seqBase = adopt ? adopt.launch.identity.seqBase ?? 0 : processedSeq;
  if (!adopt) recordLaunch(seqBase);
  const child: LiveChild = {
    handle,
    toolBridge: toolBridge ?? undefined,
    proc: handle.process,
    runId,
    // 接管的 Run 已经处理过 run.started 时，它正在执行。
    streaming: adopt !== undefined && run.state === "running",
  };
  // 分离（工单 15）结束下面的事件循环。每次等事件时只挂一个唤醒函数，长 Run 不会积累回调。
  let isDetached = false;
  let wakeDetached: (() => void) | null = null;
  let events!: AsyncIterator<RuntimeEvent>;
  let processDone!: Promise<void>;
  // 看管 handle 这个进程：暂停、停止和分离都作用于它。同一个 Run 开了新会话时，换成新进程再调用一次。
  const watchHandle = (): void => {
    const proc = handle.process;
    child.handle = handle;
    child.proc = proc;
    child.detach = proc?.detach ? () => {
      if (isDetached) return;
      isDetached = true;
      if (live.get(itemId) === child) live.delete(itemId);
      proc.detach!();
      wakeDetached?.();
    } : undefined;
    events = handle.events[Symbol.asyncIterator]();
    processDone = waitForProcess(proc);
  };
  watchHandle();
  const nextEvent = (): Promise<IteratorResult<RuntimeEvent> | "detached"> => new Promise((resolve, reject) => {
    if (isDetached) return resolve("detached");
    wakeDetached = () => resolve("detached");
    events.next().then(
      (result) => { wakeDetached = null; resolve(result); },
      (error: unknown) => { wakeDetached = null; reject(error); },
    );
  });
  live.set(itemId, child);
  if (detaching) child.detach?.();
  // 进程启动（await runtime.start）的这段时间里用户暂停或停止了 Run：那时 live 表里还没有这个 child，暂停杀不到进程。
  // 进程一挂进 live 表就再看一次状态，已暂停或停止就中断它，事件循环按用户的动作收尾（和下面开新会话时同一条规则）。
  if (!adopt) {
    const stateAfterStart = getRun(db, runId)?.state;
    if (stateAfterStart !== "starting" && stateAfterStart !== "running") {
      await handle.interrupt("run paused or stopped while its process was starting").catch(() => {});
    }
  }
  const lingerMs = opts.lingerMs ?? Number(process.env.PLC_CHILD_LINGER_MS ?? 300_000);
  let failureCaptured = false;
  // 这个进程的终止事件处理完以后 Run 的状态（finished 或 failed）。进程退出时 Run 必须仍是它（见收尾处）。
  let settledState: Run["state"] | null = null;
  let storedCursor: OutputCursor | undefined = adopt ? parseOutputCursor(run.output_cursor) : undefined;
  // 开了新会话以后，记下过期的会话。新会话也失败时，错误文本先说明这件事。
  let freshSession: { expiredSessionId: string } | null = null;
  // 第一个进程已经说过话或者调用过工具。这时它的会话显然存在，失败不是会话过期，不开新会话。
  let progressed = false;
  const failurePrefix = (): string | null =>
    freshSession === null ? null : freshSessionFailure(runtime.id, freshSession);

  // resume 的会话已经不存在（工单 #66 的 Run #71）：Claude Code 和 Codex 都会按保留期删掉旧会话的记录。
  // 这时在同一个 Run 里开一个新会话，用调用方给的提示（带工单的上下文）启动它，只开一次。
  // 同一个 Run 的好处：工单对话的轮次、activate_ticket_run 的授权都按 Run 记，用户看到的仍是这一轮的回答。
  // 失败事件不落库，也不交给调用方：这次失败能自己恢复，不是崩溃，不该有「Run crashed」和 blocker。
  // 返回 started 时，事件循环接着读新进程的事件。declined 时，失败照常处理。
  const startFreshSession = async (
    failed: Extract<RuntimeEvent, { type: "run.failed" }>,
  ): Promise<"started" | "declined" | "detached"> => {
    const freshPrompt = opts.freshSessionPrompt;
    const expiredSessionId = opts.resumeSessionId;
    if (adopt || !freshPrompt || !expiredSessionId || freshSession !== null || progressed) return "declined";
    if (failed.failure.code !== "session_not_found") return "declined";
    // 旧进程这时已经失败。确保它退出，垫片写完退出记录，再开新进程。
    await handle.interrupt("runtime session expired");
    await processDone;
    if (isDetached) return "detached";
    // 用户在这期间暂停或停止了 Run：不再开新会话，失败按用户的动作收尾。
    const state = getRun(db, runId)?.state;
    if (state !== "starting" && state !== "running") return "declined";
    // 先拼好提示再记账：拼提示出错是宿主的缺陷，交给 runItem 的兜底边界，不留下"开了新会话"的记录。
    const prompt = freshPrompt();
    const agent = runtimeDisplayName(runtime.id);
    db.transaction(() => {
      // 这个 Run 不再声称拥有那个会话。新会话报告自己的 id 以后，下一次续接就用它。
      updateRun(db, runId, { sessionId: null, externalSessionId: null });
      addActivity(db, {
        itemId, runId, actor: "system", kind: "decision",
        payload: {
          decision: "runtime_session_expired",
          expiredSessionId,
          runtime: runtime.id,
          errorCode: failed.errorCode,
          reason: `${agent} 原来的会话 ${expiredSessionId} 已经不存在（CLI 按保留期删除了它的记录）。`
            + "这个 Run 开了一个新会话，并附上了工单的上下文。",
        },
      });
    }).immediate();
    freshSession = { expiredSessionId };
    // 失败事件没有落库，新进程的事件接在已经落库的事件后面。
    seqBase = processedSeq;
    try {
      handle = await runtime.start(startRequest(prompt, undefined, false));
      recordLaunch(seqBase);
    } catch (error) {
      // 新会话没能启动。和第一次启动失败一样由 adapter 的映射表分类，交给事件循环按失败处理。
      handle = failedStart(runId, runtime.id, String(error));
    }
    storedCursor = undefined;
    watchHandle();
    if (detaching) child.detach?.();
    // 新进程启动（await runtime.start）的这段时间里用户暂停或停止了 Run：暂停那一刻中断的是已经退出的旧进程，
    // 新进程没人管，库里是 paused，进程却接着跑（过期会话的发布评审 L1）。马上中断它，事件循环按用户的动作收尾。
    const stateAfterStart = getRun(db, runId)?.state;
    if (stateAfterStart !== "starting" && stateAfterStart !== "running") {
      await handle.interrupt("run paused or stopped while the runtime session restarted").catch(() => {});
    }
    return "started";
  };
  // 接管时，adapter 从输出文件的开头重放。seq 不超过 event_cursor 的事件已经落库，跳过。
  // 例外：事件落库以后、处理之前 daemon 崩溃了。这时生命周期事件按 Run 的状态补做，否则 Run 一直停在 running。
  const lifecycleEventPending = (event: RuntimeEvent): boolean => {
    if (!adopt) return false;
    const state = getRun(db, runId)?.state;
    if (event.type === "run.started") return state === "starting";
    if (event.type === "run.completed" || event.type === "run.failed") return state === "starting" || state === "running";
    return false;
  };
  // 进程退出时，终止事件已经把 Run 记为 finished 或 failed，这一行却又是 starting 或 running：有人在停留期间
  // 绕过内核改了它（2026-10-19 工单 #93 的 Run #106：agent 的交接工具因为 Run 已结束被拒，它用 sqlite3 把 state 改回
  // running）。这两个终态没有合法的出边，进程也已经退出，所以把 Run 改回终态事件留下的状态，并记下这次纠正。
  // 不然这一行一直是 running：工单对话显示「正在执行」，直到 daemon 重启接管时才收尾。
  // 登记和交接检查在终止事件那一刻已经做过，这里不再做。结束时间被清掉时才重新记。
  const reconcileStateAtExit = (): void => {
    if (settledState === null) return;
    const target = settledState;
    db.transaction(() => {
      const current = getRun(db, runId);
      if (!current || (current.state !== "starting" && current.state !== "running")) return;
      transitionRunState(db, runId, target, { endedAt: current.ended_at === null });
      addActivity(db, {
        itemId, runId, actor: "system", kind: "decision",
        payload: {
          decision: "run_state_reconciled_at_exit", runId, from: current.state, to: target,
          reason: `Run #${runId} 的进程已经退出，它的终止事件已经处理过，这一行却是 ${current.state}。`
            + `内核把它改回 ${target}。`,
        },
      });
    }).immediate();
  };

  for (;;) {
    const next = await nextEvent();
    if (next === "detached") {
      // daemon 正常停机（工单 15）：Run 保持原来的状态，工具桥关闭，重启后在同一处重建。
      await toolBridge?.close();
      return { runId, detached: true };
    }
    if (next.done) break;
    if (next.value.runId !== runId) {
      throw new Error(`runtime event belongs to run #${next.value.runId}, expected #${runId}`);
    }
    const event = redactRuntimeEvent(shiftEvent(next.value, seqBase, failurePrefix()), secretValues);
    // child 直接写账本或配置（2026-10-19 审查）：写库会被写入守卫拦住，这里让用户知道它试过。
    // 接管时重放的旧事件不再报：同一个事件只记一条（sourceRef）。
    const command = commandOfToolEvent(event as { type: string; args?: unknown });
    const ledgerWrite = command ? detectLedgerWrite(command, { dbPath: opts.dbPath, dataDir }) : null;
    if (ledgerWrite) {
      try {
        const shown = redactAndCap(command!, 500).text;
        const text = ledgerWriteAttemptAlertText({ itemId, runId, target: ledgerWrite.target, command: shown });
        recordSecurityAlert(db, {
          kind: LEDGER_WRITE_ATTEMPTED_KIND, entityKey: `run:${runId}`, sourceRef: `ledger-write:${runId}:${event.seq}`,
          title: text.title, body: text.body,
          rootCause: {
            code: "ledger_write_attempted", scope: "run", evidence: shown,
            next_step: "看这个 agent 为什么要直接改；改设置走 daemon 的 API（设置页）",
          },
          payload: { runId, itemId, target: ledgerWrite.target, command: shown },
        });
      } catch {
        // 记不上报警不影响 Run：写库本身已经被守卫拦住。
      }
    }
    if (event.type === "run.failed") {
      const recovery = await startFreshSession(event);
      if (recovery === "started") continue;
      if (recovery === "detached") {
        await toolBridge?.close();
        return { runId, detached: true };
      }
    } else if (event.type.startsWith("message.") || event.type.startsWith("tool.")) {
      progressed = true;
    }
    eventStore.persist(event);
    // 事件落库以后，存下它的输出游标（工单 14）。游标只在事件落库之后前进，所以只会落后，不会超前。
    // 接管时从头重放，游标不往回退。
    const cursor = outputCursorOf(event);
    if (cursor && (storedCursor === undefined || cursor.offset > storedCursor.offset)) {
      updateRun(db, runId, { outputCursor: cursor });
      storedCursor = cursor;
    }
    if (event.seq <= processedSeq && !lifecycleEventPending(event)) {
      // 上一个 daemon 已经处理过这个事件。接管时只重建 ingestor 积累的状态，不再写库。
      if (adopt) ingestor.restore(event);
      continue;
    }
    processedSeq = Math.max(processedSeq, event.seq);
    if (event.type === "session.updated") {
      updateRun(db, runId, {
        sessionId: event.externalSessionId,
        externalSessionId: event.externalSessionId,
        runtimeVersion: event.runtimeVersion,
      });
    } else if (event.type === "run.started") {
      const currentWorkspace = workspace ? getWorkspace(db, workspace.id) : undefined;
      if (currentWorkspace?.state === "requested") {
        transitionWorkspace(db, currentWorkspace.id, "provisioning");
        transitionWorkspace(db, currentWorkspace.id, "active");
      }
      child.streaming = true;
      if (child.lingerTimer) {
        clearNodeTimeout(child.lingerTimer);
        child.lingerTimer = undefined;
      }
      if (event.model) updateRun(db, runId, { model: event.model });
      recordRunStarted(event);
    } else if (event.type === "run.completed" || event.type === "run.failed") {
      child.streaming = false;
      child.settled = true;
      if (event.type === "run.failed") {
        // 和启动抛错一样：runtime 没有报告启动就失败时，requested 的工作区保持原样，重试还能用它。
        const currentWorkspace = workspace ? getWorkspace(db, workspace.id) : undefined;
        if (currentWorkspace?.state === "provisioning") {
          transitionWorkspace(db, currentWorkspace.id, "failed");
        } else if (currentWorkspace?.state === "active" || currentWorkspace?.state === "review_hold") {
          // The process has started, so the workspace itself is still reusable; only the
          // attachment must be released. Do not leave a failed Run masquerading as active work.
          transitionWorkspace(db, currentWorkspace.id, "idle");
        }
        // 先看 Run 是不是已经停下、暂停或结束：被停下的 CLI 也报 run.failed（例如 Claude Code 的 claude_interrupted）。
        // 那不是一次失败，不进失败经验：换模型（工单 08）每停一次就记一次，两次就建出一张「沉淀失败经验」工单（08 审查 1）。
        const quiet = quietRun(db, runId);
        recordRunCrash(event);
        if (!quiet && !failureCaptured) {
          failureCaptured = true;
          learning.captureFailure({
            projectId: latestProjectId(db, itemId), itemId, runId,
            kind: "runtime", errorCode: event.errorCode, summary: event.error,
            // 按根因去重（learning.ts 的 failureFingerprint，2026-10-19 审查）：402 这类同一个根因的失败，
            // 措辞不同、出在不同项目里，以前各算一类（#23、#24、#28）。
            // 录下来的旧事件可能没有 failure：按错误码和原文现分类。
            rootCause: event.failure?.code ?? classifyFailure(runtime.id, { errorCode: event.errorCode, message: event.error }).code,
          });
        }
      } else {
        recordRunCompleted(event);
      }
      const state = getRun(db, runId)?.state;
      settledState = state === "finished" || state === "failed" ? state : null;
    } else {
      ingestor.onEvent(event);
    }
    opts.onEvent?.(event, { itemId, runId });
  }

  const exit = await handle.wait();
  const latest = getItem(db, itemId)!;
  // 能 steer 的 runtime（例如 pi）的执行 Run 没有交接时会停留，lead 可以 steer 它。
  // 修复回合（工单 09）等停留结束、runItem 收尾时才排，
  // 所以两者不冲突：steer 之后交接成功，就不再需要修复回合。修复回合自己不停留。
  const immediate = lingerMs === 0 || !runtime.capabilities.steering || purpose === "conversation" || purpose === "lookup" ||
    role === "reviewer" || purpose === "integration" || purpose === "outcome_repair" ||
    latest.stage === "done" || latest.stage === "cancelled" ||
    latest.plan_state === "waiting" || latest.plan_state === "integrating" ||
    (requiresIndependentReview(latest) && latest.stage === "review");
  if (handle.process && handle.process.exitCode === null && handle.process.signalCode === null) {
    if (immediate) {
      await handle.interrupt("runtime turn complete");
    } else {
      const timer = setNodeTimeout(() => void handle.interrupt("linger timeout"), lingerMs) as unknown as NodeJS.Timeout;
      child.lingerTimer = timer;
      timer.unref();
    }
    await processDone;
  }
  // 用户主动结束的 Run（paused / stopped）不得被这条尾巴改写成崩溃：暂停时我们刚刚
  // 亲手杀掉了进程，exit.ok 当然是 false，但那是预期内的。少了这两个状态，
  // 一次暂停会同时写下 "Run crashed" 检查点和一条 blocker。
  const finalState = getRun(db, runId)?.state;
  if (!exit.ok && finalState !== "failed" && finalState !== "paused" && finalState !== "stopped") {
    const failed = syntheticEvent({
      type: "run.failed", exitCode: exit.exitCode,
      errorCode: exit.errorCode ?? "runtime_exit",
      error: `${failurePrefix() ?? ""}${exit.errorMessage ?? "runtime failed"}`,
      failure: classifyFailure(runtime.id, {
        errorCode: exit.errorCode ?? "runtime_exit", message: exit.errorMessage ?? "runtime failed",
      }),
    });
    if (failed.type !== "run.failed") throw new Error("synthetic runtime failure event is invalid");
    eventStore.persist(failed);
    recordRunCrash(failed);
    opts.onEvent?.(failed, { itemId, runId });
  }
  reconcileStateAtExit();
  if (child.lingerTimer) clearNodeTimeout(child.lingerTimer);
  // 只删自己的条目：恢复控制可能已经在同一张工单上启动了下一段 Run。
  if (live.get(itemId) === child) live.delete(itemId);
  if (role === "reviewer" && purpose === "review" && runWorkspace) {
    // 交了结论以后被暂停的核查 Run，暂停那一段收尾时已经登记了结论（review_verdicts 以 run_id 为主键）。
    // 恢复后这一段收尾不再登记，也不再走一遍托管验收（发布评审 reliability-backlog）。
    const verdictRegistered = Boolean(db.prepare("SELECT 1 FROM review_verdicts WHERE run_id=?").get(runId));
    // 核查后的工作区指纹异步、有时限地算，在登记步骤和事务之外，期间不持有写锁，也不卡住 daemon。
    let postHash: string | null = null;
    if (!registrationPending && !verdictRegistered) {
      try { postHash = await reviewWorkspacePostFingerprint(db, runId); }
      catch (error) { registrationStep("review_automation", new Date(), () => { throw error; }); }
    }
    if (!verdictRegistered) registrationStep("review_automation", new Date(), () => {
      const check = db.prepare("SELECT verdict, evidence FROM review_workspace_checks WHERE run_id=?")
        .get(runId) as { verdict: "pass" | "fail" | null; evidence: string | null } | undefined;
      if (!check?.verdict || !check.evidence || postHash === null) return;
      const { verdict, evidence } = check;
      const result = completeReviewWorkspaceCheck(db, runId, { verdict, evidence, postHash });
      db.transaction(() => {
        // 工单已经离开 review（不等核查直接验收、取消、打回返工）：暂存的结论不再算数。不登记，也不走托管自动化，
        // 否则会给已经完成的工单发「核查不通过，等你决定」（工单 11 审查第 6 条，终态不被派生状态改写）。
        // 没有工作区的核查在交结论时就查了 stage（dispatch.ts 的 submitReviewVerdict）。
        const stage = getItem(db, itemId)?.stage;
        if (stage !== "review") {
          addActivity(db, {
            itemId, runId, actor: "system", kind: "decision",
            payload: { decision: "review_verdict_discarded", verdict, reason: `工单已经离开 review（现在是 ${stage ?? "missing"}），这次核查的结论不登记。` },
          });
        } else if (result.accepted) {
          db.prepare("INSERT INTO review_verdicts (run_id, item_id, verdict, evidence, pre_hash, post_hash) VALUES (?, ?, ?, ?, ?, ?)")
            .run(runId, itemId, verdict, evidence, result.preHash, result.postHash);
          applyReviewAutomation(db, { run: getRun(db, runId)!, verdict, evidence,
            now: new Date(), requestRework: (request) => { createDispatcher(db).request(request); } });
        } else {
          updateRun(db, runId, { errorCode: "review_workspace_drift", errorMessage: "review workspace changed during review" });
        }
        createDispatcher(db).completeRun(runId);
      }).immediate();
    });
    const currentWorkspace = getWorkspace(db, runWorkspace.id);
    if (currentWorkspace?.state === "review_hold") transitionWorkspace(db, currentWorkspace.id, "idle");
  }
  await toolBridge?.close();
  // pi 的会话文件在数据目录里：盖掉这个 Run 期间写进去的密钥值。
  scrubSessionFiles(opts.sessionDir, secretValues, runStartedAtMs);
  addActivity(db, {
    itemId, runId, actor: "system", kind: "attempt_end",
    payload: { finalItemStage: getItem(db, itemId)?.stage, runtime: runtime.id },
  });
  requestOutcomeRepairAfterRun(db, { itemId, runId, role, purpose, resume: runtime.capabilities.resume });
  requestAutomaticReviewAfterRun(db, { itemId, runId, reviewerRuntime: opts.reviewerRuntime });
  // 对话 Run 结束后再记一次指纹，和启动前不一样就是这个 Run 改了工作区（review-currency.ts）。
  // 放到后台、在 Run 释放之后算：算指纹期间用户可以接着发消息或开始执行。
  // 改过时，要求独立核查的工单由那里重新排核查，不在这里排：这里不等指纹算完。
  scheduleConversationWorkspaceCheck(db, conversationCheck, { reviewerRuntime: opts.reviewerRuntime });
  // 交付快照（工单 04）：成果是从输出里恢复的、没有在 ticket_update 时存的，这里补上；Run 结束时工作区和
  // 最新一份快照不一样（对话改了代码），再存一份。同样放到后台，在 Run 释放之后跑。
  scheduleDeliveryRefreshAfterRun(db, { itemId, runId });
  return { runId };
}

/**
 * 交付 Run 结束、工单停在 review 时，请求自动独立核查（automatic-review.ts）。
 * 不管 Run 是认领来的还是用户「开始执行」直接启动的，都在这里请求一次；认领来的 Run
 * orchestrator 也会用同一个幂等键请求，只建一条请求。
 * 和修复回合一样放在最后：live 表已经清空，reviewer 不会撞上还在收尾的同一张工单。
 */
function requestAutomaticReviewAfterRun(
  db: Db,
  input: { itemId: number; runId: number; reviewerRuntime?: RuntimeId },
): void {
  const item = getItem(db, input.itemId);
  const run = getRun(db, input.runId);
  if (!item || !run || !automaticReviewNeeded(db, item, run)) return;
  try {
    createDispatcher(db).request(
      automaticReviewRequest(input.itemId, input.runId, automaticReviewRuntime(db, input.itemId, input.reviewerRuntime)),
    );
  } catch (error) {
    // 排不上核查时，控制面把这张工单投影成"独立核查未派发"，用户仍然可以手动派发。这里只留一条记录。
    try {
      addActivity(db, {
        itemId: input.itemId, runId: input.runId, actor: "system", kind: "decision",
        payload: {
          decision: "automatic_review_request_failed",
          error: String(error).split(/\r?\n/)[0]!.slice(0, 200),
        },
      });
    } catch {
      // 连记录都写不进去时，投影仍然会把它显示为"未派发"。
    }
  }
}

/**
 * 执行 Run 或修复回合结束后，来源 Run 的成果仍然没有登记时，排一个修复回合（spec D4）。
 * 条件和额度由 planOutcomeRepair 判定。修复额度用完时不排，来源 Run 原来的 blocker 保留。
 * 这一步放在 runItem 的最后。这时 live 表已经清空，派发不会撞上还在收尾的同一张工单。
 */
function requestOutcomeRepairAfterRun(
  db: Db,
  input: { itemId: number; runId: number; role: "executor" | "reviewer"; purpose: RunPurpose; resume: boolean },
): void {
  if (input.role !== "executor") return;
  const run = getRun(db, input.runId);
  let sourceRunId: number | null = null;
  if (input.purpose === "execution") {
    sourceRunId = input.runId;
  } else if (input.purpose === "outcome_repair") {
    // 宿主登记出错的修复回合不再排下一个：它的信封还在，宿主修好后由启动时的重新登记补上（spec D3）。
    // 来源 Run 的会话不存在时也不排：下一个修复回合 resume 的还是那个会话。
    const outcome = parseMetadata(run?.metadata ?? "{}").outcomeRepair as { reason?: string } | undefined;
    if (outcome?.reason !== "host_error" && outcome?.reason !== "session_expired") {
      sourceRunId = run?.resumed_from_run_id ?? null;
    }
  }
  if (sourceRunId === null) return;
  try {
    requestOutcomeRepair(db, { sourceRunId, resume: input.resume });
  } catch (error) {
    // 排不上修复回合时，来源 Run 原来的 blocker 保留，人仍然可以处理。这里只留一条记录。
    try {
      addActivity(db, {
        itemId: input.itemId, runId: sourceRunId, actor: "system", kind: "decision",
        payload: {
          decision: "outcome_repair_request_failed",
          sourceRunId,
          error: String(error).split(/\r?\n/)[0]!.slice(0, 200),
        },
      });
    } catch {
      // 连记录都写不进去时，原来的 blocker 仍然在。
    }
  }
}

// 接管时重建工具桥（工单 15）：在原来的路径、用原来的 token。CLI 的 plc MCP 服务器每次调用都重新连接，
// 所以重建以后 agent 的工具调用恢复正常。启动时没有工具桥，或者旧版本没有记下它时，不重建。
// 重建失败不影响接管：agent 的工具调用会失败，成果缺失时由修复回合补交（spec D4）。
async function restoreToolBridge(
  db: Db,
  input: {
    itemId: number; runId: number; workdir: string; dataDir: string; env?: Record<string, string>;
    launch: AttachableLaunch;
  },
): Promise<AgentToolBridge | null> {
  const stored = input.launch.identity.toolBridge;
  if (!stored) return null;
  try {
    return await startAgentToolBridge({
      db, itemId: input.itemId, runId: input.runId, workdir: input.workdir, dataDir: input.dataDir,
      env: input.env, reuse: stored,
    });
  } catch (error) {
    addActivity(db, {
      itemId: input.itemId, runId: input.runId, actor: "system", kind: "decision",
      payload: { decision: "tool_bridge_restore_failed", error: String(error).split(/\r?\n/)[0]!.slice(0, 200) },
    });
    return null;
  }
}

// 同一个 Run 的第二个进程从 1 编号（startFreshSession），这里把它接在第一个进程的事件后面。
// 输出游标跟着事件走，它的 seq 也要加上同一个数。prefix 加在失败的错误文本前面。
function shiftEvent(event: RuntimeEvent, seqBase: number, prefix: string | null): RuntimeEvent {
  const prefixed = prefix !== null && event.type === "run.failed";
  if (seqBase === 0 && !prefixed) return event;
  const shifted = {
    ...event,
    seq: event.seq + seqBase,
    ...(prefixed ? { error: `${prefix}${event.error}` } : {}),
  } as RuntimeEvent;
  const cursor = outputCursorOf(event);
  if (cursor) tagOutputCursor(shifted, { offset: cursor.offset, seq: cursor.seq + seqBase });
  return shifted;
}

// 新会话也失败时，错误文本先说明原来的会话不存在、系统开了新会话，再给新会话自己的失败原因。
function freshSessionFailure(runtime: RuntimeId, fresh: { expiredSessionId: string }): string {
  return `${runtimeDisplayName(runtime)} 原来的会话 ${fresh.expiredSessionId} 已经不存在。`
    + "系统开了一个新会话，新会话也失败了：";
}

// runtime.start 抛错时的 handle：只有一个失败事件。分类和第一次启动抛错相同（spawn_error）。
function failedStart(runId: number, runtime: RuntimeId, error: string): RuntimeHandle {
  const errorCode = "spawn_error";
  const failed = new RuntimeEventSequencer(runId).event({
    type: "run.failed", exitCode: null, errorCode, error,
    failure: classifyFailure(runtime, { errorCode, message: error }),
  });
  const exit: RuntimeExit = {
    ok: false, exitCode: null, signal: null, externalSessionId: null, errorCode, errorMessage: error,
  };
  return {
    pid: null,
    events: (async function* () { yield failed; })(),
    interrupt: async () => {},
    wait: async () => exit,
  };
}

function parseOutputCursor(text: string | null): OutputCursor | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<OutputCursor>;
    return Number.isInteger(value.offset) && Number.isInteger(value.seq) ? value as OutputCursor : undefined;
  } catch {
    return undefined;
  }
}

function latestProjectId(db: Db, itemId: number): number | undefined {
  return getItem(db, itemId)?.project_id ?? undefined;
}
