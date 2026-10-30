// coordinatord：真正的常驻宿主（DESIGN §2 的完整形态，M5）。
// 持有 lead session、child 托管、事件管道、watchdog、inbox 投递、心跳巡检。
// 客户端（companion、plc）走 paired 网关。数据目录里的 plc.sock（Unix socket + LF-JSONL）
// 只做本机自举和运维，见下面 createServer 处的说明。
import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  clearInterval as clearNodeInterval, clearTimeout as clearNodeTimeout, setInterval as setNodeInterval, setTimeout as setNodeTimeout,
} from "node:timers";
import { getChannelCard, getChannelLookup, openDb, recordLeadCompactionFailed, recordLeadModelSwitched, type Db } from "@pi-lead-child/store";
import {
  createLeadSession, DEFAULT_LOOKUP_ROOTS, findPullRequestRef, isExternalTextTool, LEAD_QUIET_TOOLS, leadSystemEvent, leadUserMessage,
  listLookupCandidates, withExternalContent, type LeadSystemEventKind, type LeadTurnOrigin,
} from "@pi-lead-child/lead";
import {
  assertConfiguredLeadModel, leadModelCatalog, loadLeadModelConfig, setLeadModelChainInConfig, setLeadModelInConfig, type LeadCatalogModel,
} from "@pi-lead-child/lead";
import { overflowLimits, overflowReached, overflowReminder, queueNotice, queueNoticeMs, waitingText, type WaitingConversation } from "@pi-lead-child/lead";
import { isSummaryTokenCapError, leadCompactionInstructions, LEAD_COMPACTION_BUDGETS } from "@pi-lead-child/lead";
import { contextUsageLine, leadContextUsage, type LeadContextUsage } from "@pi-lead-child/lead";
import { userMessagePlacement } from "./user-placement.js";
import { createLeadInput, defaultDigestBatch, isReminderFireEvent, type DigestBatchPolicy } from "./lead-input.js";
import { compactionEndOutcome, createLeadHealthTracker, isEmptyLengthStop, leadContextFullError } from "./lead-health.js";
import { dnsProbe, NetworkMonitor, type NetworkProbe } from "./network.js";
import { DEFAULT_MODEL_CATALOG_REFRESH_MS, startModelCatalogWatch } from "./model-catalog-watch.js";
import { recordRunFinished, recordRunFinishedAtTerminalEvent } from "./run-finished.js";
import { recordConnectionAttention } from "./connection-attention.js";
import { startTriageShadow, type TriageShadowDaemonOptions } from "./triage-shadow.js";
import { loadChannelsConfig, startChannelMemory, startChannels, stopChannels, type ChannelDaemonOptions } from "./channels.js";
import { ChannelSettings } from "./channel-settings.js";
import { contextObjectStatus, localGh } from "./context-objects.js";
import { reclaimLookupRun, recoverLookupsAfterRestart } from "./lookup.js";
import { recordAgentWrite } from "./agent-writes.js";
import {
  createAgentTaskDispatcher, recoverAgentTasksAfterRestart, type AgentTaskDispatcherOptions, type DaemonAgentTaskDispatcher,
} from "./agent-tasks.js";
import {
  CHANNEL_CARDS_SNAPSHOT_RESOURCE, CHANNEL_SETTINGS_SNAPSHOT_RESOURCE, EVENT_SOURCES, LEAD_QUEUE_RESOURCE, type GrantLocalRepo, type LeadQueue,
} from "@pi-lead-child/protocol";
import {
  DAEMON_ENTITY_KEY, DAEMON_STARTED_KIND, isUserActionRequest, LEAD_WAIT_EXPIRED_KIND, type UserActionRequest,
} from "@pi-lead-child/protocol";
import { leadModelSpec, MODEL_SETTINGS_RESOURCE, parseLeadModelSpec, SETUP_RESOURCE, type LeadModelChoice } from "@pi-lead-child/protocol";
import { ModelSettings } from "./model-settings.js";
import { loadDecisionModels } from "./decision-models.js";
import { LEAD_AVATAR_RESOURCE, parseFairyEyeCommand } from "@pi-lead-child/protocol";
import type { ChannelHub, ChannelLookupCandidate, ChannelOwnerMessage } from "@pi-lead-child/engine";
import {
  autoReplyDisclosure, disclosureAssistantName, disclosureOwnerName, fairyEyeReply, leadAvatarSlackEmoji, setLeadAvatarFairyEye,
  slackEmojiPreview,
} from "@pi-lead-child/engine";
import { outageStart, outageStep, restoreOutages, type OpenOutage, type OutageItem } from "./lead-outage.js";
import type { LeadDaemonEnvironment, LeadEngine, LeadEngineFactoryResult } from "@pi-lead-child/lead";
import { channelPolicy, coreMemoryRefreshPrefix } from "@pi-lead-child/store";
import { createSetupTracker, type SetupTracker } from "./setup-status.js";
import {
  adoptRunChild, childRuntimeProfile, liveTicketMessagePrompt, releaseSettledChild, resumeItemChild, routeTicketMessageToAgentRun,
  runningChildren, spawnClaimedItem, spawnItemChild, type LeadDeps,
} from "@pi-lead-child/lead";
import { createTicketReplyActionsJudge, type TicketReplyActionsJudge } from "./ticket-reply-actions.js";
import {
  acceptRunningChildren, CHANNEL_TASK_CALLBACK, conversationWorkspaceChecksSettled, deliverySnapshotsSettled, detachRunningChildren, effectiveRunPurpose,
  killIdleChildren, liveChildren, UiActionError, type DecisionModelCredentials, type FollowUpEntry, type LeadModelService, type UiActionServices,
} from "@pi-lead-child/engine";
import { attachJsonlReader, listenOwnerOnly } from "@pi-lead-child/runtime";
import { appendBody, getItem, transition } from "@pi-lead-child/store";
import { activeRun, getRun, updateRun } from "@pi-lead-child/store";
import { repairNonBudgetRetryExhaustion } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { insertChatImages, listChatImageRefs, listTurnChatImages } from "@pi-lead-child/store";
import {
  addInbox, appendEvent, escalateLeadBacklog, expireLeadWaits, flushCommittedEvents, listInbox, listLeadBacklog,
  purgeLeadWaits, recordDueLeadFollowUps, recordUserRequestExpired, subscribeCommittedEvents,
} from "@pi-lead-child/store";
import { addNotification, getNotification, listNotifications, markNotificationDelivered } from "@pi-lead-child/store";
import { installLedgerGuards, ledgerGuardsEnabled, ledgerGuardTriggers, missingLedgerGuards, recordSecurityAlert } from "@pi-lead-child/store";
import { loadLastPatrolAt, saveLastPatrolAt } from "@pi-lead-child/store";
import { repairMissingBlockerAlerts } from "@pi-lead-child/store";
import { pendingApprovals, getApproval, isStandingOrderProposal, pendingApprovalLine } from "@pi-lead-child/store";
import { blockerHasConversationRecord } from "@pi-lead-child/store";
import { recordLeadTurnResponding, type EventRecord, type ReminderPush } from "@pi-lead-child/store";
import { createWatchdog } from "@pi-lead-child/engine";
import { agentConnectionHost, setAgentConnectionHost, type AgentConnectionHost } from "@pi-lead-child/engine";
import { createScheduler } from "@pi-lead-child/engine";
import {
  createWatchRunner, createWidgetSourceRunner, sandboxedBashOperations, sandboxWatchCommand, sandboxWidgetCommand,
} from "@pi-lead-child/engine";
import { createWatchLightTask, leadSandboxPolicy, leadScratchDir } from "@pi-lead-child/lead";
import { watchAgentChoice } from "@pi-lead-child/store";
import { envConfigPath, loadPlcConfig, localIso, projectRoot } from "@pi-lead-child/core";
import { createConfigWatch } from "./config-watch.js";
import {
  contextUsageRatio, createLeadModelFailover, createTurnUserActions, nextWeeklyReset, PRECIPITATE_PROMPT, PRECIPITATE_RATIO,
  type LeadModelQuotaReset,
} from "@pi-lead-child/lead";
import { AishAdapter, type AishTimeouts, type StreamHandle } from "@pi-lead-child/gateway";
import { PairedCommandError, startPairedServer, type PairedBridge } from "@pi-lead-child/gateway";
import { defaultWebRoot, gatewayBaseUrl } from "@pi-lead-child/gateway";
import { bindingScopes, channelOwnerBinding, createCliBinding, getBinding } from "@pi-lead-child/store";
import {
  classifyLeadModelError, isLeadRestartInterruption, isLeadTransportFailure, isLocalSocketCommand, isSystemTurnOrigin, LEAD_DRAIN_TIMEOUT_MS,
  LEAD_RESTART_INTERRUPTED_ERROR, leadOutageCause, leadOutageHeadline, markUpstreamFailure,
  partialUiSurface,
  PRESENCE_IDLE_MS, QUIET_REPLY, redactAndCap, redactSecretText, userFacingBacklogText,
  stripQuietReply,
  SYSTEM_TURN_ORIGINS,
  isOnBehalfOwnerActionNotification, isOwnerActionNotificationKind, ownerActionRecordText, ownerActionRefOfNotification, ownerActionTurnId,
  CONNECTION_SETTINGS_TAMPERED_KIND, connectionSettingsTamperAlertText, describeConnectionSettings,
  CONFIG_CHANGED_OUTSIDE_API_KIND, configChangedAlertText, SECURITY_ALERT_NOTIFICATION_KIND,
  LEDGER_GUARD_REMOVED_KIND, ledgerGuardRemovedAlertText,
  type AdminTokenResponse, type CliCredentialResponse, type DaemonDrainResult, type DaemonLocalStatus, type GatewayExposureStatus,
  type LocalSocketCommand,
  type LeadModelFailureKind, type SystemTurnOrigin, type TicketSummary, type TurnPlacement,
  type ChatSendMode, type FollowUpActionResult,
} from "@pi-lead-child/protocol";
import {
  ExposureListener, isWildcardHost, listenWithFallback, resolveGatewayListen, wildcardExposure,
} from "./gateway-listen.js";
import { createControlPlaneService, isLeadActivityEvent } from "@pi-lead-child/gateway";
import { createUserActionService } from "@pi-lead-child/gateway";
import {
  activeLeadGrant, activePairedUserTurn, grantLeadCapability, revokeLeadCapability,
  type LeadCapability, type LeadGrant, type LeadGrantChannel,
} from "@pi-lead-child/store";
import { assistantMessageText, projectToolEvent } from "@pi-lead-child/gateway";
import {
  persistLeadToolConversationEvent, repairStuckLeadToolOperations,
} from "@pi-lead-child/gateway";
import {
  getAishAuthFailure, loadAishConn, loadLastAishOrigin, markAishAuthFailed, saveAishConn, saveLastAishOrigin,
  upsertAishBinding,
} from "@pi-lead-child/store";
import { leadDisplayName } from "@pi-lead-child/store";
import { listRecordedOwnerActions, maxEventSeq } from "@pi-lead-child/store";
import {
  appendAssistantDelta,
  completeTurn,
  createTurn, listQueuedTicketTurns, startQueuedTurn,
  reopenTurn,
  EMPTY_ASSISTANT_REPLY_ERROR,
  failTurn,
  restartTurnForRetry,
  reopenPausedTurn,
  rememberPausedTurn,
  takePausedTurn,
  settleRetryAsSteered,
  waitTurnForRetry,
  markTurnSteered,
  markTurnInserted,
  settleTurnAnsweredWith,
  settleTurnCancelled,
  listUnfinishedLeadTurns,
  repairEmptyCompletedTurns,
  restoreQuietSystemTurns,
  type ChannelTurnRow,
} from "@pi-lead-child/store";
import { publishGatewayEvent, runUpdatedEvent, type PublishGatewayEventInput } from "@pi-lead-child/store";
import { createDefaultRuntimeRegistry, LOCAL_RUNTIME_ID, type RuntimeRegistry } from "@pi-lead-child/runtime";
import type { RuntimeEvent } from "@pi-lead-child/runtime";
import { typedFailure } from "@pi-lead-child/runtime";
import { parseLauncherIdentity, retainChildrenOnHostExit } from "@pi-lead-child/runtime";
import {
  applyRestartRecovery, chargeRestartRecovery, crashLoopBudget, planRestartRecovery, restartDispatchOf,
  stopUntrackedLaunchers, sweepLaunchDirectories, type CrashLoopBudget,
} from "@pi-lead-child/engine";
import { createOrchestrator, type Orchestrator } from "@pi-lead-child/engine";
import { createCoordinator, type Coordinator } from "@pi-lead-child/engine";
import { daemonFileOpener, type FileOpener } from "@pi-lead-child/engine";
import { NotesMemory } from "@pi-lead-child/engine";
import { MemoryController, type MemoryControllerHooks } from "./memory-controller.js";
import { hindsightProgram, summaryModels } from "./memory-backend.js";
import { markAutoPullRequestRollout, reconcileWorkspaces, sweepWorkspaces, syncAutoPullRequests } from "@pi-lead-child/engine";
import { loadArtifactStorageConfig } from "@pi-lead-child/core";
import {
  repairArtifactStorage,
  type ArtifactRepairOptions,
} from "@pi-lead-child/store";
import { repairTerminalHandoffFailures } from "@pi-lead-child/engine";
import { repairStoppedRunCrashCheckpoints } from "@pi-lead-child/engine";
import { repairOutcomeSnapshots } from "@pi-lead-child/engine";
import { reregisterFinishedRuns } from "@pi-lead-child/engine";
import { claimInstanceLock, daemonLockPath, readKeychainSecret, supervisorRequest } from "@pi-lead-child/supervisor";
import type { InstanceLock, MaintenanceRequest } from "@pi-lead-child/supervisor";
import {
  ConnectionError,
  ConnectionHub,
  defaultKeySource,
  fileKeySource,
  ghCliTokenSource,
  lazyVault,
  loadConnectionsConfig,
  type FetchLike,
  type GhTokenSource,
  type VaultKeySource,
} from "@pi-lead-child/connections";
import { DAEMON_ONLY_ENV_NAMES } from "@pi-lead-child/core";
import { childRuntimeAdapter } from "@pi-lead-child/lead";
import { RuntimeSettings } from "./runtime-settings.js";
import {
  createHealthRecovery, parseRecheckRuntime, recoveryIntervalMs, startHealthRecoveryLoop, type RecheckResult,
} from "@pi-lead-child/engine";
import { createRuntimePreflight } from "@pi-lead-child/engine";
import {
  leadModelSwitchStatusMessage,
  shouldFailEmptyLeadTurn,
  type LeadModelSwitchRequest,
} from "@pi-lead-child/lead";

// 用户暂停工单对话 Run 时，它上面那一轮记下的错误。恢复时按它找回那一轮（reattachPausedTicketTurn）。
const PAUSED_TICKET_TURN_ERROR = "Run 已暂停，这一轮回答没有完成。";

// 单实例守卫拒绝启动时抛出的专用错误类型：main.ts 用 instanceof 判定是否要 exit(0)
// （而不是靠正则匹配 message——message 是人话文案，不应作为控制流契约）。
export class DaemonAlreadyRunningError extends Error {}

export function loopbackAutoPairEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = env.PLC_ALLOW_LOOPBACK_AUTO_PAIR?.trim().toLowerCase();
  if (explicit !== undefined) return ["1", "true", "yes", "on"].includes(explicit);
  return env.PLC_DEV === "1";
}

export function childRuntimeControlEvent(
  itemId: number,
  runId: number,
  event: RuntimeEvent,
): PublishGatewayEventInput | null {
  // 线上事件名/scope/payload 键均由 protocol 冻结；内部 item/run 到线上 ticket/attempt
  // 的映射见 src/wire-vocabulary.ts 的说明。
  const common = { requiredScope: "tickets:view" as const, itemId };
  if (event.type === "run.started" || event.type === "run.completed" || event.type === "run.failed") {
    return null;
  }
  if (event.type === "message.completed") {
    return { ...common, type: "ticket.updated", payload: { attemptId: runId, snapshotRequired: true } };
  }
  const childToolTypes: Record<string, "child.tool.started" | "child.tool.updated" | "child.tool.completed" | "child.tool.failed"> = {
    "tool.started": "child.tool.started",
    "tool.updated": "child.tool.updated",
    "tool.completed": "child.tool.completed",
    "tool.failed": "child.tool.failed",
  };
  const type = childToolTypes[event.type];
  return type ? { ...common, type, payload: { attemptId: runId, ...projectToolEvent(event) } } : null;
}

function recordSystemCheckpointIfMissing(
  db: Db,
  coordinator: Coordinator,
  input: Parameters<Coordinator["recordSystemCheckpoint"]>[0],
): boolean {
  const exists = db.prepare("SELECT 1 FROM checkpoints WHERE idempotency_key=?")
    .get(input.idempotencyKey);
  if (exists) return false;
  return !coordinator.recordSystemCheckpoint(input).deduplicated;
}

export function repairDaemonStartupState(
  db: Db,
  now = new Date(),
): {
  approvals: number; decisions: number; runStarts: number;
  reregistered: number; reregistrationErrors: number; outcomes: number; handoffs: number;
} {
  const coordinator = createCoordinator({ db, now: () => now });
  const repaired = coordinator.repairLegacyInterventions();
  const runs = db.prepare(
    "SELECT id, item_id FROM runs WHERE state IN ('starting','running') ORDER BY id",
  ).all() as Array<{ id: number; item_id: number }>;
  let runStarts = 0;
  for (const run of runs) {
    if (recordSystemCheckpointIfMissing(db, coordinator, {
      itemId: run.item_id,
      runId: run.id,
      kind: "progress",
      title: "Run active after daemon startup",
      summary: `Run #${run.id} is active for item #${run.item_id}.`,
      idempotencyKey: `run-start:${run.id}`,
    })) {
      runStarts++;
    }
  }
  // 重新登记（工单 08）必须先跑：登记待处理的 Run 归它处理。
  // 后面两项修复只看结果，不看这个 Run 是在哪一步停下的。
  const reregistration = reregisterFinishedRuns(db, { at: now });
  const outcomes = repairOutcomeSnapshots(db, now);
  const handoffs = repairTerminalHandoffFailures(db, now);
  return {
    ...repaired,
    runStarts,
    reregistered: reregistration.registered,
    reregistrationErrors: reregistration.errors,
    outcomes,
    handoffs,
  };
}

// daemon 重启恢复（DESIGN §9 + spec §C1）：孤儿 child 的 stdio 无法重挂——杀掉如实标 crash。
// 垫片启动的 Run 先由接管处理（工单 15，pipeline/restart-adoption.ts）。接管不了的才走到这里（孤儿回收）。
// 自动重派限每工单 1 次（判据持久化在 auto_redispatch 决策 activity，崩溃循环第二次重启必然收敛到 blocked）。
// 交回队列的请求受崩溃循环额度约束（工单 15）：budget 给出时，同一个请求恢复太多次就判为失败，不再交回队列。
// 故意复用 kind='decision'（activities.kind 有 CHECK 约束，SQLite 无法 ALTER CHECK，新 kind 会炸老库）。
function autoRedispatchCount(db: Db, itemId: number): number {
  const r = db.prepare(
    `SELECT COUNT(*) AS c FROM activities
     WHERE item_id = ? AND kind = 'decision' AND json_extract(payload, '$.decision') = 'auto_redispatch'`,
  ).get(itemId) as { c: number };
  return r.c;
}

export function recoverOrphans(
  db: Db,
  opts?: {
    redispatch?: (itemId: number) => boolean;
    // 只处理这些 Run。没有给出时处理全部活动的 Run。
    runIds?: ReadonlySet<number>;
    budget?: CrashLoopBudget;
    now?: Date;
  },
): number {
  const coordinator = createCoordinator({ db });
  const orphans = (db.prepare(
    "SELECT id, item_id, pid, launcher, purpose FROM runs WHERE state IN ('starting','running')",
  ).all() as Array<{ id: number; item_id: number; pid: number | null; launcher: string | null; purpose: string }>)
    .filter((orphan) => !opts?.runIds || opts.runIds.has(orphan.id));
  for (const o of orphans) {
    // 代查（slack-takeover 工单 03）是 daemon 进程里的会话，没有进程可杀：记成失败，工单进 cancelled，
    // 不打成 blocked、不重新派发、不叫醒 Lead（lookup.ts）。启动时 recoverLookupsAfterRestart 已经先处理过一遍。
    if (o.purpose === "lookup") {
      reclaimLookupRun(db, o.id, opts?.now);
      continue;
    }
    const dispatch = restartDispatchOf(db, o.id);
    // 没有垫片的旧 Run：CLI 是旧 daemon 的子进程，照旧停止它。
    // 垫片启动的 Run 走到这里，说明核对不到它的垫片（工单 15）。记下的 pid 可能已经被别的进程复用，所以不发信号。
    // 核对过身份、还活着的垫片由接管那一步停止。
    if (o.pid && !parseLauncherIdentity(o.launcher)) {
      try { process.kill(o.pid); } catch { /* 已死 */ }
    }
    let crashLoop = false;
    const reclaimed = db.transaction(() => {
      const current = getRun(db, o.id);
      if (!current || !["starting", "running"].includes(current.state)) return false;
      if (opts?.budget && !chargeRestartRecovery(db, {
        run: current, dispatch, action: "reclaim", budget: opts.budget, now: opts.now ?? new Date(),
      })) {
        crashLoop = true;
        return true;
      }
      // daemon 重启打断的是这次尝试，不是任务（spec D1：attempt）。它不扣工单的重试额度。
      updateRun(db, o.id, {
        state: "failed", endedAt: true,
        failure: typedFailure("run_interrupted", { errorCode: null, message: "daemon restart: orphaned run reclaimed" }),
      });
      addActivity(db, {
        itemId: o.item_id, runId: o.id, actor: "system", kind: "crash",
        payload: {
          reason: "daemon restart: orphaned run reclaimed",
          pid: o.pid,
          dispatchRequestId: dispatch?.requestId ?? null,
        },
      });
      recordSystemCheckpointIfMissing(db, coordinator, {
        itemId: o.item_id,
        runId: o.id,
        kind: "blocked",
        title: "Run reclaimed after daemon restart",
        summary: `Run #${o.id} was reclaimed because the daemon restarted while it was active.`,
        nextStep: "Recover or redispatch the interrupted item.",
        idempotencyKey: `run-crash:${o.id}`,
        leadVisible: true,
        precedingEvents: [runUpdatedEvent(o.item_id, o.id)],
      });
      const status = getItem(db, o.item_id)?.stage;
      // 成果修复回合（工单 09）不改变工单的 stage。daemon 重启回收它时也一样。
      const preservePurposeState = dispatch?.role === "reviewer" || dispatch?.purpose === "integration"
        || dispatch?.purpose === "outcome_repair";
      if (!preservePurposeState && status === "active") {
        transition(db, {
          itemId: o.item_id, to: "blocked", actor: "system",
          reason: "daemon restart reclaimed orphaned run", runId: o.id,
        });
      }
      if (dispatch) {
        db.prepare("DELETE FROM dispatch_claims WHERE run_id=?").run(o.id);
        db.prepare(
          "UPDATE dispatch_requests SET state='pending', updated_at=datetime('now') WHERE id=?",
        ).run(dispatch.requestId);
        addInbox(db, {
          itemId: o.item_id, severity: "attention", source: "structural",
          summary: `工单 #${o.item_id} 的 run #${o.id} 因 daemon 重启中断，已交回调度队列`,
        });
      }
      return true;
    }).immediate();
    if (!reclaimed || crashLoop) continue;
    if (dispatch) continue;
    // 有限次自动重派：非终态 + 未派过 + 有派发能力。计数决策先落账（spawn 挂死也能收敛）。
    // 边界：review 态孤儿（reviewer 死了）转 blocked 失败留 review，不满足 executor 闸门的 stage 集合，
    // redispatch 抛错→返回 false→走 blocker 现行为，交 lead 心跳裁决。可接受，不专门处理。
    const after = getItem(db, o.item_id)?.stage;
    const terminal = after === "done" || after === "cancelled";
    if (!terminal && opts?.redispatch && autoRedispatchCount(db, o.item_id) === 0) {
      // 决策 activity 必须先于 spawn 落账——它是崩溃循环收敛的判据（spawn 挂死/二次孤儿据此不再重派）。
      addActivity(db, {
        itemId: o.item_id, runId: o.id, actor: "system", kind: "decision",
        payload: { decision: "auto_redispatch", fromRun: o.id },
      });
      // 但正文交接语只在 spawn 成功后写——否则 review 态孤儿（闸门必失败）的正文
      // 会永久谎称"已重派续做"。诚实优先：失败走下方 blocker 分支，正文不留假承诺。
      if (opts.redispatch(o.item_id)) {
        const recoveredRunId = activeRun(db, o.item_id)?.id;
        if (recoveredRunId && recoveredRunId !== o.id) {
          recordSystemCheckpointIfMissing(db, coordinator, {
            itemId: o.item_id,
            runId: recoveredRunId,
            kind: "progress",
            title: "Run recovered after daemon restart",
            summary: `Run #${recoveredRunId} resumed item #${o.item_id} after run #${o.id} was reclaimed.`,
            idempotencyKey: `run-recovered:${o.id}:${recoveredRunId}`,
            leadVisible: true,
          });
        }
        appendBody(db, o.item_id,
          `【系统】run #${o.id} 因 daemon 重启中断，已自动重派新 run 续做（前次进展见上文与 activities）。`);
        addInbox(db, {
          itemId: o.item_id, severity: "attention", source: "structural",
          summary: `工单 #${o.item_id} 的 run #${o.id} 因 daemon 重启中断，已自动重派续做`,
        });
        continue;
      }
    }
    // 先交给 Lead：它可以再跑一次（recover_ticket_run），处理不了时 daemon 升级给用户。
    addInbox(db, {
      itemId: o.item_id, severity: "blocker", source: "structural",
      summary: `工单 #${o.item_id} 的 run #${o.id} 因 daemon 重启被回收（标记 crash）`,
      payload: { kind: "orphan_run_reclaimed", runId: o.id, needsUser: false },
    });
  }
  return orphans.length;
}

// 多久没有动静的工单在 Lead 的当前局面里折叠成一行（2026-10-19，lead-input.ts 的 ticketIsIdle）。
// config.json 的 lead.situation.idleTicketHours 优先，其次环境变量 PLC_LEAD_IDLE_TICKET_HOURS。不合法时写一行日志，用缺省值。
function idleTicketOption(dataDir: string, log: (line: string) => void): { idleTicketMs?: number } {
  let hours: unknown = process.env.PLC_LEAD_IDLE_TICKET_HOURS;
  try {
    const configured = loadPlcConfig(dataDir).lead?.situation?.idleTicketHours;
    if (configured !== undefined) hours = configured;
  } catch (error) {
    log(`reading lead.situation.idleTicketHours failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (hours === undefined || hours === "") return {};
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0 || value > 24 * 365) {
    log(`lead.situation.idleTicketHours=${String(hours)} is not a positive number of hours; using the default`);
    return {};
  }
  return { idleTicketMs: Math.round(value * 3_600_000) };
}

// 交给 Lead 的一条事件里还没做的「需要用户做什么」：等待超时（lead.wait_expired）里的，和 inbox 说明（例如连接授权失效，
// payload.payload.userAction）里的。等待了结（lead.wait_satisfied）里的那一件用户已经做完了，不算（2026-10-19 审查：
// 用户授权完成以后叫醒 Lead 的那一轮，没有控件的卡片被退回，还提示 Lead 再放一次授权按钮）。
function pendingUserActionOfEvent(event: EventRecord): UserActionRequest | null {
  if (event.kind === LEAD_WAIT_EXPIRED_KIND) {
    return isUserActionRequest(event.payload.userAction) ? event.payload.userAction : null;
  }
  if (!event.kind.startsWith("inbox.")) return null;
  const inner = event.payload.payload;
  const nested = inner && typeof inner === "object" ? (inner as { userAction?: unknown }).userAction : undefined;
  return isUserActionRequest(nested) ? nested : null;
}

// 这条事件要不要告诉用户：写入方标了 mustTell（等待的 mustTell，store 的 lead-waits.ts；模型切换）。
function eventMustBeTold(event: EventRecord): boolean {
  return event.payload.mustTell === true;
}

// 额度用尽时在重置以前跳过的模型（model-failover.ts）存在 kv 的这一项里。
const LEAD_MODEL_QUOTA_KEY = "lead.model_quota_blocked";

// config.json 的 lead.quotaResets（model-failover.ts 的 LeadModelQuotaReset）。没有或者写错时用缺省的规则，写错时记一行日志。
function leadQuotaResetsOption(dataDir: string, log: (line: string) => void): { quotaResets?: LeadModelQuotaReset[] } {
  try {
    const configured = loadPlcConfig(dataDir).lead?.quotaResets;
    if (configured === undefined) return {};
    const valid = Array.isArray(configured) && configured.every((entry) =>
      entry && typeof entry.match === "string" && entry.match.trim() && nextWeeklyReset(Date.now(), entry) !== null);
    if (!valid) {
      log("lead.quotaResets in config.json should be a list of { match, weekday (0-6), time (HH:MM) }; using the default");
      return {};
    }
    return { quotaResets: configured };
  } catch (error) {
    log(`reading lead.quotaResets failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export interface DaemonOpts {
  dataDir: string;
  dbPath: string;
  // 测试注入：绕过真实 LLM 的 session 工厂 / fake-pi child
  // 启动时问各 CLI 要模型目录。缺省：没有注入 sessionFactory（真实 daemon）时问，测试不问。
  modelDiscovery?: boolean;
  sessionFactory?: (args: {
    dataDir: string; dbPath: string; db: Db;
    onChildDone?: LeadDeps["onChildDone"]; onChildEvent?: LeadDeps["onChildEvent"];
    childPi?: LeadDeps["childPi"];
    runtimeRegistry?: LeadDeps["runtimeRegistry"];
    // 授权变动后重算 lead 的激活工具表（lead/session.ts）。可选：测试注入的假 session
    // 没有工具表可同步，缺席时 daemon 只是不做这一步。
    currentTurnId?: LeadDeps["currentTurnId"];
    turnOrigin?: LeadDeps["turnOrigin"];
    cancelBudgetTurnId?: LeadDeps["cancelBudgetTurnId"];
    announceLeadStatus?: LeadDeps["announceLeadStatus"];
    scheduleLeadModelRestart?: LeadDeps["scheduleLeadModelRestart"];
    // 工单操作层的宿主（spec 5.11）：和网关的用户操作服务同一份，ticket_action 和页面按钮拉起进程、选核查员的方式一样。
    ticketActionHost?: LeadDeps["ticketActionHost"];
    // 操作层（engine 的 ui-actions/）用的服务：daemon 建一个对象，网关和 Lead 共用它。
    uiActionServices?: LeadDeps["uiActionServices"];
    memory?: LeadDeps["memory"];
    // SmartModel 的决策模型：每次调用时读设置页「模型」的配置和保险库里的 key（memory-controller.ts）。
    // 2026-10-29 起是直觉的整条分工（主用在前）。
    decisionModel?: () => DecisionModelCredentials | readonly DecisionModelCredentials[] | null;
    // 直觉都用不了时问大脑的哪个模型（config.json 的 decision.llmFallback）。每次判断时读。
    llmFallback?: () => string | null;
    connections?: LeadDeps["connections"];
    // 外部通道（slack-takeover 工单 04；统一消息事件工单 05 以后是处理消息事件的通用工具：派活、告诉用户、记下已处理、读对话）。
    channelCards?: LeadDeps["channelCards"];
    // Lead 的 get_environment 里 daemon 提供的部分（工单 13；2026-10-30 起不进系统提示词）：决策模型的设置和记忆服务的状态。
    environment?: () => LeadDaemonEnvironment;
  }) => Promise<LeadEngineFactoryResult>;
  // 托管 Hindsight 记忆服务（memory-controller.ts）。main.ts 传 true。缺省不托管：记忆只用 notes 的全文检索，
  // /v1/memory 回 503。测试传一组替身（launchd、下载、网络、Keychain），走真的设置、确认和收件箱。
  manageMemory?: boolean | MemoryControllerHooks;
  // 用户给 agent 装的 skill 的目录（lead 的 userSkillDirs），Lead 会话加载它们。main.ts 传；测试里起的 daemon 不读用户的目录。
  skillDirs?: string[];
  // 把还是「先问我」的连接一次性改成「直接写」（connections 的 relaxWritePolicyOnce，用户 2026-10-28）。main.ts 传 true。
  relaxConnectionWrites?: boolean;
  childPi?: LeadDeps["childPi"];
  runtimeRegistry?: RuntimeRegistry;
  log?: (line: string) => void;
  // aish 适配器配置（缺省读 PLC_AISH_URL/PLC_AISH_TOKEN；测试可注入短超时）
  aish?: { url: string; token: string; timeouts?: Partial<AishTimeouts> };
  // paired 平面端口。缺省读 PLC_GATEWAY_PORT，没配置时用 47130（被占用时退回随机端口）。网关总是开着。
  gatewayPort?: number;
  webRoot?: string; // paired 平面在 / 下提供的 companion web UI（缺省 dist/web，由 npm run build:web 生成）
  artifactRepairOptions?: ArtifactRepairOptions;
  // 没有客户端连着时的桌面通知（blocker、兜底通知、审批、aish 配对失效）。缺省见 defaultDesktopNotifier。
  notifyDesktop?: (text: string) => void;
  // 网络通不通（叫醒 Lead 之前探一次）。缺省：真实 daemon 解析 PLC_NETWORK_PROBE_HOST（缺省 api.anthropic.com）；
  // 注入了 sessionFactory 的测试总当网络是通的。
  networkProbe?: NetworkProbe;
  // 连接（ConnectionHub）的测试注入：假厂商的 fetch、保险库密钥、gh。缺省：真实 daemon 用 Keychain 和本机的 gh；
  // 注入了 sessionFactory 的测试用数据目录里的密钥文件，没有 gh。
  connections?: { fetch?: FetchLike; keySource?: VaultKeySource; gh?: GhTokenSource; tickMs?: number };
  // 账本写入守卫的核对间隔（缺省 60 秒）和 config.json 的核对间隔（缺省 15 秒）。测试调短。
  ledgerGuardCheckMs?: number;
  configWatchMs?: number;
  // 按批叫醒 Lead 的判断（spec D3，工单 04）：现在该不该为摘要叫醒 Lead、有哪些事件。缺省见 lead-input.ts 的 defaultDigestBatch
  // （05 的常设指令 events.digest_batch）。
  digestBatch?: DigestBatchPolicy;
  // Jev 分诊的影子模式（工单 09，triage-shadow.ts）。测试注入 SmartModel 和间隔；false 关掉。
  triageShadow?: TriageShadowDaemonOptions;
  // 通道（工单 11，channels.ts）：外部来源的消息、会话卡、代你行动。测试注入假的来源和凭据；false 关掉。
  // 没有配置来源时不接任何来源。生产入口（main.ts）给 live：密钥都有的内置来源用真实的传输接上（slack-takeover 工单 02）。
  channels?: ChannelDaemonOptions;
  // 请求 A 的候选仓库，子 agent 的本地仓库也从这里解析。缺省按配置 channels.lookup.localRoots 扫本地仓库；
  // 测试 daemon 只用 project_repositories，测试也可以直接给。
  lookups?: { candidates?: () => readonly ChannelLookupCandidate[] };
  // 派单器（通道派给子 agent 的工单，agent-tasks.ts）。测试注入假模型的会话、超时和上限。
  agentTasks?: Pick<AgentTaskDispatcherOptions, "sessionFactory" | "timeoutMs" | "maxDurationMs" | "limits">;
  // 打开交付里的文件（工单 07）。缺省：engine 的 daemonFileOpener（macOS 上执行 /usr/bin/open；PLC_OPEN_FILES=off 时一律拒绝，
  // 根 vitest 配置设置了它）。要测打开文件的测试注入假的。
  fileOpener?: FileOpener;
}

// 缺省的桌面通知：macOS 上用 osascript 弹系统通知。PLC_DESKTOP_NOTIFY=off 时不弹。
// 根 vitest 配置设置了这个开关，测试里起的 daemon（包括子进程里的）就不会在用户桌面上弹通知。
// 库里的时间有两种写法：ISO（带 T 和时区），和 SQLite 的 datetime('now')（UTC 的 'YYYY-MM-DD HH:MM:SS'）。
function parseDbTime(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

// 不请 Lead 播报的通知：Lead 用 notify_user 写的（它在自己那一轮里已经说过了），主人操作的提醒
// （工单 15：daemon 直接推，见 owner-actions 那一步），和安全报警（同一步）。
function isDirectPushNotification(kind: string): boolean {
  return kind === "lead_notice" || isOwnerActionNotificationKind(kind) || kind === SECURITY_ALERT_NOTIFICATION_KIND;
}

function defaultDesktopNotifier(): (text: string) => void {
  if (process.env.PLC_DESKTOP_NOTIFY === "off") return () => {};
  return (text) => {
    execFile("osascript", ["-e",
      `display notification ${JSON.stringify(text)} with title "pi-lead-child"`,
    ], () => { /* 非 macOS / 失败静默 */ });
  };
}

type DaemonHandle = {
  sockPath: string; close: () => Promise<void>; pairedPort: number;
  // 在正在运行的 Lead 会话里重新加载扩展（例如 SoL-Pi 刚装好），不重启 daemon。Lead 空闲时马上做，
  // 正在跑一轮时等这一轮结束。
  reloadLeadExtensions: (reason: string) => void;
  // 通道的 hub（工单 11）。没有接任何来源时是 null。来源的传输把投递交给它的 receive（测试直接调用）。
  channels: ChannelHub | null;
  // 热重连一个来源（slack-settings 工单 S1）：清掉凭据缓存、停传输，密钥齐了就重新开。设置页的 PUT、DELETE 和「不是我」调它。
  reloadChannelSource: (source: string) => Promise<void>;
  // 派单器（landing.md C1）：Lead 的 dispatch_agent_task 和兜底调它，通道用 onFinished 登记结果的回调。
  agentTasks: DaemonAgentTaskDispatcher;
};

// 单实例保证：一个数据目录只有一个 daemon。它先拿 daemon.lock，拿到才拥有 plc.sock，之后才打开账本、
// 跑启动修复、绑定网关。这必须先于 recoverOrphans 等一切状态修改：否则第二个实例会先把活着的第一个实例的
// children 当孤儿杀掉、标 crash、转 blocked、甚至重复派发，然后才被拒绝。
// 锁由内核持有，进程退出（包括崩溃）时放掉；卡住的 daemon 还活着，所以还持有锁。以前只探测 plc.sock：
// 卡住的 daemon 的 accept 队列满了，connect 被拒绝，第二个 daemon 就接管了（2026-10-15 02:14Z）；
// 两个 daemon 同时启动时，两个都通过了探测，都绑定了网关（13:56Z）。
export async function startDaemon(opts: DaemonOpts): Promise<DaemonHandle> {
  const lockPath = daemonLockPath(opts.dataDir);
  const ownership = claimInstanceLock(lockPath);
  if (!ownership) throw new DaemonAlreadyRunningError(`daemon already running: ${lockPath} is held by another process`);
  try {
    return await runDaemon(opts, ownership);
  } catch (error) {
    ownership.release();
    throw error;
  }
}

async function runDaemon(opts: DaemonOpts, ownership: InstanceLock): Promise<DaemonHandle> {
  const log = opts.log ?? ((l: string) => console.log(`[${new Date().toISOString()}] ${l}`));
  // 拿到了锁，却还有进程在 plc.sock 上 listen：那是不认识这把锁的旧版本 daemon，也让开。
  // 不无条件删 sock（那会把正在运行的 daemon 变成不可达僵尸——实测踩坑）：先探测，没人 listen 才删。
  const sockPath = join(opts.dataDir, "plc.sock");
  if (existsSync(sockPath)) {
    const alive = await new Promise<boolean>((resolve) => {
      const probe = netConnect(sockPath);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (alive) throw new DaemonAlreadyRunningError(`daemon already running at ${sockPath}`);
    unlinkSync(sockPath); // 陈旧 sock，安全接管
  }

  const db = openDb(opts.dbPath);

  try {
    const artifactConfig = loadArtifactStorageConfig();
    const artifactRepair = repairArtifactStorage(
      db,
      opts.dataDir,
      new Date(),
      artifactConfig.orphanGraceMs,
      opts.artifactRepairOptions,
    );
    if (artifactRepair.proofItemsRepaired
      || artifactRepair.artifactsDowngraded
      || artifactRepair.orphansRemoved) {
      log(
        `artifact startup repair: proof=${artifactRepair.proofItemsRepaired}`
        + ` downgraded=${artifactRepair.artifactsDowngraded}`
        + ` orphans=${artifactRepair.orphansRemoved}`,
      );
    }
  } catch (error) {
    db.close();
    throw error;
  }

  // Lead 的输入（工单 04，lead-input.ts）：事件游标、每一轮交给 Lead 的事、当前局面。
  // 在任何启动修复之前建立：修复写下的事（例如补上的审批 blocker）排在游标后面，照常交给 Lead。
  // 第一次建立游标时（04 之前的库），还没处理完的 inbox 行转成事件，交给 Lead 一次。
  // 通道的 hub（工单 11）在后面建（它要推送和网关事件）。当前局面里每条道一行，从它取。
  let channelHub: ChannelHub | null = null;
  const leadInput = createLeadInput({
    db, log,
    tickets: () => listTicketSummaries?.() ?? [],
    lanes: (objectKeys) => channelHub?.laneLines(objectKeys) ?? new Map(),
    ...(Number(process.env.PLC_LEAD_SITUATION_BUDGET) > 0 ? { budgetTokens: Number(process.env.PLC_LEAD_SITUATION_BUDGET) } : {}),
    ...idleTicketOption(opts.dataDir, log),
  });
  // daemon 启动了（2026-10-19）：写一条 daemon.started。Lead 请求的重启登记了等它的等待（tools.ts 的 awaitingRestart），
  // 这一条了结那条等待，Lead 被叫醒，并且必须告诉用户重启完成了（store 的 lead-waits.ts）。
  // 写在游标建立以后：了结等待写下的那一条排在游标后面，照常交给 Lead。
  try {
    db.transaction(() => appendEvent(db, {
      source: "system",
      kind: DAEMON_STARTED_KIND,
      entityKey: DAEMON_ENTITY_KEY,
      level: "record",
      payload: { pid: process.pid, startedAt: new Date().toISOString(), summary: `daemon 启动了（pid ${process.pid}）` },
    }))();
  } catch (error) {
    log(`recording daemon.started failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 这一轮里出现过的「需要用户做什么」（wait-tools.ts）：工具返回的和交给这一轮的事件里带的。render_ui 据此检查卡片有没有控件。
  const turnUserActions = createTurnUserActions();
  // 模型自动切换的额度封禁（model-failover.ts）给 Lead 的工具看和手动清掉。切换器在会话建好以后才有，这里先留一个入口。
  let leadModelQuotaControl: { list(): Array<{ model: string; until: string }>; clear(model?: string): string[] } | null = null;
  const leadModelQuota = {
    list: () => leadModelQuotaControl?.list() ?? [],
    clear: (model?: string) => leadModelQuotaControl?.clear(model) ?? [],
  };

  const clients = new Set<Socket>();               // plc.sock 的连接（停机时 destroy）
  const senders = new Set<(obj: unknown) => void>(); // 旧版 paired WS（v1）的广播出口
  const sendTo = (sock: Socket, obj: unknown) => { try { sock.write(JSON.stringify(obj) + "\n"); } catch { /* 客户端已断 */ } };
  const broadcast = (obj: unknown) => { for (const s of senders) s(obj); };
  // "有没有人在听"：活着的、说自己有人在看的 v2 网关客户端（前台的 companion、运行中的 plc chat），
  // 并且 binding 有效、带 chat scope（见 paired-server 的 chatListenerCount）。旧版 v1 连接说不了
  // 自己有没有人在看，不算。有人在听时，lead 播报即时通知，桌面通知不弹。网关启动之后才接上计数。
  let gatewayChatListeners = () => 0;
  // 网关启动以后有没有客户端连上过（presence 的「未知」用，userPresenceText）。
  let gatewayClientSeen = () => false;
  const clientCount = () => gatewayChatListeners();
  let busy = false;
  // 排着的外部消息的推送（工单 10，publishLeadQueue）：上一次推的样子、合并变化的定时器、daemon 在停（不再推）。
  // 放在这里：启动的半路上就可能开一轮，那时下面定义的函数已经能调，变量也要已经有了。
  let leadQueueSent = "";
  let leadQueueTimer: NodeJS.Timeout | null = null;
  let leadQueueStopped = false;
  // 停机前排空 Lead（2026-10-16 提醒 #83，见 drainLead）：draining 时不再开新的 Lead 回合，
  // 用户的新消息存成排队的轮次，等下一个 daemon（或者排空作废后的本 daemon）回答。
  let draining = false;
  // 排空到时，daemon 中断了正在跑的这一轮：这一轮按「被重启打断」收尾，不按模型失败。
  let restartAbort = false;
  // 正在跑的这一轮结束（finally 写完记录）时 resolve。排空据此等它。
  let currentTurn: Promise<void> | null = null;
  // 这一轮从什么时候开始跑，Lead 最后一次有动静（会话发来任何事件）是什么时候：判断 Lead 是不是卡死了。
  let turnStartedAt: number | null = null;
  let lastLeadActivityAt = Date.now();
  // 卡死：这一轮在一整个检查间隔里没有任何动静（见 checkLeadLiveness）。是从什么时候起没有动静的。
  let leadSilentSince: number | null = null;
  // 用户最后一次在看会话的时间（Jarvis 模式：Lead 据此判断现在推还是等他回来；审批据此算送到）。
  let lastAttendedAt: number | null = null;
  // 带着事的那一轮失败以后，下一次叫醒 Lead 的时间和已经失败的次数。
  let leadWakeRetry: { at: number; failures: number } | null = null;
  const leadWakeRetryBaseMs = Number(process.env.PLC_LEAD_WAKE_RETRY_MS ?? 15_000);
  // 正在跑的这一轮是谁发起的（system: 来源；用户的回合为 null）。整理笔记那一轮不接 inbox。
  let runningSystemOrigin: SystemTurnOrigin | null = null;
  // 正在跑的这一轮的来历（lead 的 turn-origin.ts，用户 2026-10-27）：读进了外部来源的原文没有；是不是只为用户本人设的
  // 跟进开的一轮（那一轮算用户的一轮）。每一轮开始时重算，插进来的事件、读外部原文的工具随时把它改严。
  let runOrigin: LeadTurnOrigin = { external: false, timer: null };
  // 超预算转派（lead-tools-and-routing spec D7，lead 的 overflow.ts）：这一轮顶层的工具调用次数，和这一轮有没有提醒过。
  let runToolCalls = 0;
  let overflowReminded = false;
  // 这一轮有没有插过「有人在排队」的说明（noticeQueue，lead-self-routing spec C）。
  let queueNoticed = false;
  let publishControlEvent: (args: Parameters<typeof publishGatewayEvent>[1]) => ReturnType<typeof publishGatewayEvent> =
    (args) => publishGatewayEvent(db, args);
  // 执行器的开关（设置页「执行器」，runtime-settings.ts）：在编排器和 Lead 会话起来之前，把 config.json 里的停用名单写进环境变量。
  const runtimeSettings = new RuntimeSettings({
    dataDir: opts.dataDir, log,
    publish: (resource) => {
      publishControlEvent({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } });
    },
    // 停用或启用一个 runtime 以后马上 claim（2026-10-20）：点名停用 runtime 的核查请求马上换核查员。
    // tickOrchestrator 在下面定义；设置只会在 daemon 起来以后改，那时它已经有了。
    onChange: () => setImmediate(() => tickOrchestrator()),
    // Lead 代用户启用用户停用的执行器：操作层核对过那一轮，这里再核对一次（纵深防御）。
    userTurn: (turnId) => { activePairedUserTurn(db, turnId, "runtime.enable", "tickets:create"); },
  });

  // 操作层（engine 的 ui-actions/）用的服务。只建这一个对象：网关的页面入口和 Lead 的工具都拿它，两个入口调的是同一个实例。
  const uiActionServices: UiActionServices = { runtimeSettings };

  interface TurnOutcome {
    ok: boolean;
    // lead 在本回合落成的系统回合里说了话（不是只调了工具，也不是一言不发）。
    voiced: boolean;
    systemTurnId: string | null;
    // 断网：这一轮没调模型（或者调了因为断网失败），会话里什么都没留。等网络恢复再做。
    offline?: true;
    // 已经有一轮在跑（或者另一次系统唤醒正在探网络）：这次没开，等下一次。
    deferred?: true;
    // 这一轮作为消息交给 Lead 的事件对应的 inbox 行（工单 04）。
    inboxIds?: number[];
  }

  interface ActiveChannelTurn {
    turn: ChannelTurnRow;
    assistantText: string;
    commandId?: string;
    // 工单 agent 的轮次在哪里收口（F5）：
    //   · "run_end"：工单对话 Run 只为回答这一句话而起，整个 Run 的助手消息都属于这条轮次。
    //     带工具的回合会先说"我去查"，最后才回答；在第一条消息就收口，回答就丢了（#66 第二轮）。
    //   · "reply"：插话进一个还在执行的 Run，回答是插话之后的第一条消息；之后的消息属于执行本身，
    //     不能全部灌进这条聊天气泡。
    sealAt?: "run_end" | "reply";
    // 当前这条助手消息已经流出的文本，用来从 message.completed 里截出还没播出的尾巴。
    messageText?: string;
    // 这一轮画了定稿的卡片（render_ui）。没写字也算回答了。
    drewSurface?: boolean;
    // 这一轮调过工具（可能已经建了提醒、工单）：失败了也不自动重试，免得做第二遍。
    ranTools?: boolean;
    // 这一轮调过的工具和结果，按 toolCallId。被重启打断时，叫醒下一个 Lead 的系统事件列出它们。
    tools?: Map<string, { name: string; state: "running" | "done" | "failed"; result: string }>;
    // 用户在 Lead 忙时发来的消息怎么放的（工单 04，spec D6）：插话（steer）或排队（followUp）。
    placement?: "steer" | "followUp";
  }
  // assistant 文本的"出水口"：lead 说的话流进哪一条 channel_turn（= 会话流里的哪个气泡）。
  let activeChannelTurn: ActiveChannelTurn | null = null;
  // 已受理、但还没接到水的插话轮次。插话不新开回合，而是插进正在跑的那一轮；
  // 出水口要跟着改接过去，否则回答会继续长在用户那条消息**上面**的气泡里
  // （实测：641 字的回答里最后一句答的是 6 分钟后才发的那句话）。
  // 迟到到"lead 真的又开口了"才改接，是为了不制造空气泡：插话之后一言不发就收尾时，
  // 原轮次保住已有文本，插话轮次停在 steered（前端渲染成一行提示，见 companion 的 steeredNotice）。
  let pendingSteerSink: ActiveChannelTurn | null = null;
  // 交给 pi 排队、还没送到模型的用户消息（插话和排队消息），按交出去的先后（工单 04）。
  //   · 会话报告输入送到的时刻（message_start，role=user）时，按原文找到它，出水口改接给它（handOverTo）；
  //   · 这一轮失败时，pi 队列里还剩的据此找回它们的轮次（等那一次自动重试，或者给「重发」），
  //     不让下一次 prompt 再把它们送一次（发布评审 f796c1c 的 B2）；
  //   · 这一轮成功了它们还在 pi 的队列里（交出去时 pi 已经过了最后一次取队列）：转为下一轮的输入（carryOverTurns）。
  // nextTurn：插话赶不上（这一轮已经在写最后的回答），界面标记已经改成「下一轮回答」。
  // prompt 是交给 pi 的原文（排队消息的开头可能带着当前局面），userPrompt 是用户的这一轮本身（转为下一轮时用它）。
  const queuedInputs: Array<{
    prompt: string; userPrompt?: string; entry: ActiveChannelTurn; kind: "steer" | "followUp"; nextTurn?: boolean;
  }> = [];
  // 插进正在跑的这一轮的系统事件（interrupt 级）：原文 → 事件序号。这一轮结束时还在 pi 队列里的，不算交给了 Lead。
  const steeredEvents = new Map<string, number[]>();
  // 下一轮先答的用户消息：上一轮成功结束时还在 pi 队列里没送到的（见 queuedInputs）。一次一条，按先后。
  const carryOverTurns: Array<{ prompt: string; entry: ActiveChannelTurn }> = [];
  // 系统回合正在探网络（还没开始）：别的唤醒不再同时开一轮。
  let systemTurnStarting = false;
  // lead 自己发起的回合（blocker、即时通知、心跳、整理笔记）还没落成一轮时的来源。
  // 它在 lead 第一次开口或调工具时才落成一轮（materializeSystemTurn）：lead 一言不发就收尾时，
  // 会话流里不留空气泡。
  let pendingSystemOrigin: SystemTurnOrigin | null = null;
  // Lead 自己发起的一轮（blocker、通知、心跳巡检、整理笔记）：它说的话先攒着，回合结束时去掉 NO_REPLY 再一次写出，
  // 所以 NO_REPLY 从不出现在会话里；只读工具和笔记工具（LEAD_QUIET_TOOLS）的调用也先攒着。
  // 这几种时候落成一轮：
  //   · 调了会改变外部状态的工具（建工单、派发……）：当场落成，任务卡和这些工具记的卡片要有轮次 id；
  //   · 回合结束时有要告诉用户的话；
  //   · 失败了（会话里一张失败卡片）。整理笔记例外：还没有要告诉用户的话时，失败也不落成。
  // 攒着的工具调用记下它开始时已经说了多少字（textOffset），落成一轮时位置不变。
  let systemTurnBuffer: { text: string; toolEvents: Array<{ event: any; textOffset: number }> } | null = null;
  // 落成系统回合时复用的旧轮次（同一条通知的重试只留一轮）。
  let pendingSystemReuseTurnId: string | null = null;
  // 这一轮为哪几件事单独开（工单 07：一条到点的提醒）。落成会话里的一轮时记下 lead.turn_responding，
  // 界面据此把这一轮说的话挂在提醒卡下面，不另起气泡。
  let pendingSystemRespondsTo: EventRecord[] | null = null;
  // 本回合落成的系统回合：回合结束时据此判断 lead 有没有在里面开口。
  let systemEntryThisTurn: ActiveChannelTurn | null = null;
  // 批量取消闸门的计数桶：最近一次用户发起的轮次（含受理的插话）。lead 自己发起的回合不改它，
  // 所以无人值守时，每次唤醒都不会重置预算。没有轮次的旧入口（v1 paired、aish）每条消息记一个新键。
  let cancelBudgetTurnId: string | null = null;
  let untrackedUserTurns = 0;
  const noteUserTurn = (turnId?: string) => {
    cancelBudgetTurnId = turnId ?? `untracked-${++untrackedUserTurns}`;
  };
  // 当前这条 assistant 消息已经流过的全文（跨出水口累计）。message_end 的补尾必须拿它来比：
  // 出水口中途改接过之后，任何单个出水口的整轮文本都不再是本条消息的前缀。
  let streamingMessageText = "";
  let activeTurnError: string | null = null;
  let pendingLeadModelRestart: LeadModelSwitchRequest | null = null;
  // 工单 agent 的轮次，按 runId 记：正在接文本的那一条。
  const ticketAgentTurns = new Map<number, ActiveChannelTurn>();
  // 同一个 Run 上已受理、还没接到文本的下一条轮次：agent 还在回答时，用户又发了一句。
  // 和 lead 的 pendingSteerSink 同一个约定：下一条助手消息开始时才改接，旧轮次在那一刻收口。
  // 不在消息中途改接：正在流出的这条消息属于旧轮次。
  const pendingTicketAgentTurns = new Map<number, ActiveChannelTurn>();
  // 工单 agent 的一轮答完以后，判断回复在等你决定要不要做哪几个动作（ticket-reply-actions.ts）。
  // 用 Lead 会话的 SmartModel，所以会话建好以后才有；之前答完的轮次不判断。
  let replyActionsJudge: TicketReplyActionsJudge | null = null;
  let orchestrator: Orchestrator | null = null;
  const tickOrchestrator = () => {
    if (!orchestrator) return;
    void orchestrator.tick().catch((error: any) => log(`[orchestrator] tick error: ${error.message}`));
  };

  function publishTurnText(entry: ActiveChannelTurn, text: string): void {
    entry.assistantText += text;
    appendAssistantDelta(db, entry.turn.id, text);
    publishControlEvent({
      type: "lead.message.delta", requiredScope: "chat",
      audienceBindingId: entry.turn.origin_binding_id ?? undefined,
      turnId: entry.turn.id,
      itemId: entry.turn.item_id ?? undefined,
      payload: { messageId: `msg_${entry.turn.id}`, delta: text },
    });
  }

  // 一条轮次的收口：落终态 + 把最终全文播出去。被插话改接掉的那条在交接当场就收口，
  // 不等回合结束——它的气泡到此为止，之后的话不属于它了。
  // 用户的一轮因为断网或临时故障没答上：网络或模型恢复后自动再试一次（2026-10-16）。等待期间这一轮不算失败：
  // 回到 queued，error 写着为什么在等；notice.created 带 retry=waiting，客户端显示「在等」，不给「重发」。
  // 只管 Lead 的普通会话轮次（chatV2 记下了交给 Lead 的原文）；认证、配置这类再试也一样的失败不等。
  // 再试也失败，就是普通的失败。
  const userTurnPrompts = new Map<string, string>();
  // 外部通道里用户本人写给 Lead 的话开的一轮（acceptChannelOwnerMessage）→ 回复发回的对话。这一轮和后面的一轮一起答了时，
  // 对话交给后面那一轮（settleAnsweredTogether）。只在内存里：daemon 重启以后，重启前收的这种消息的回复只在 App 里看得到。
  const channelOwnerReplies = new Map<string, string[]>();
  const retriedUserTurns = new Set<string>();
  // 在等重试的轮次：at 为 null 时等网络恢复，否则到点再试（模型服务暂时连不上、限流）。
  const userTurnRetries = new Map<string, { at: number | null }>();
  const userTurnRetryMs = Number(process.env.PLC_USER_TURN_RETRY_MS ?? 30_000);
  // 交给 Lead 的用户的一轮：工单上下文是 daemon 加的，不是用户的话，放在 <user_message> 外面。
  // 带工单的一轮：2026-10-19 以前，工单对话里的一些消息交给 Lead 回答（工单 08 的第一版）。现在工单对话一律交给
  // 工单的 agent，不再新建这种轮次；库里留下的、重启后还要答的旧轮次照旧带上下文。turnId 是这一轮自己，最近的消息里不列它。
  // imageIds：用户随这条消息发的图片的编号，信封里写着（Lead 用编号指一张图，例如 set_lead_avatar）。
  // 图片本身在 leadTurnImages 里按轮次取，交给 pi 时带上。
  function userTurnPrompt(args: {
    via: string; channel: string; itemId: number | null; message: string; turnId?: string; imageIds?: readonly string[];
  }): string {
    const item = args.itemId === null ? undefined : getItem(db, args.itemId);
    const itemContext = item ? leadSystemEvent("context", ticketChatContext(item, args.turnId ?? null)) : "";
    const source = { via: args.via, channel: args.channel, ...(args.imageIds?.length ? { imageIds: args.imageIds } : {}) };
    return [itemContext, leadUserMessage(source, args.message)].filter(Boolean).join("\n");
  }

  // 写进摘要的用户的话。只发了图片的消息没有文字，写「[图片]」。
  function userTurnText(turn: { id: string; user_text: string }): string {
    if (turn.user_text.trim()) return turn.user_text;
    return listChatImageRefs(db, [turn.id]).has(turn.id) ? "[图片]" : turn.user_text;
  }

  // 用户的一轮带的图片（App 的输入框，protocol 的 chat-images.ts），交给 pi 的格式。图片按轮次存在库里：
  // 新的一轮、插话、排队、转到下一轮、自动重试和重启后再答，交给 pi 时都从这里取，不在内存里另存一份。
  function leadTurnImages(turnId: string): Array<{ type: "image"; data: string; mimeType: string }> {
    return listTurnChatImages(db, turnId).map((image) => ({
      type: "image", data: image.data.toString("base64"), mimeType: image.mimeType,
    }));
  }

  // 工单对话里交给 Lead 的一轮的说明（工单 08 的第一版，只剩上面说的旧轮次用它）：回答落在哪里，按什么回答（系统账本，不凭会话记忆），
  // 什么时候才转给执行 agent。附上这张工单对话里最近的两轮：Lead 的会话里没有执行 agent 的回答，
  // 用户回一句「好的」时 Lead 要知道上一句问的是什么。摘录先遮住密钥再截短（redactAndCap）：对话里可能贴过令牌。
  function ticketChatContext(item: NonNullable<ReturnType<typeof getItem>>, turnId: string | null): string {
    const clip = (text: string, max: number) => {
      const capped = redactAndCap(text.replace(/\s+/gu, " ").trim(), max);
      return capped.truncated ? `${capped.text}…` : capped.text;
    };
    const recent = (db.prepare(
      `SELECT origin_kind, user_text, assistant_text FROM channel_turns
       WHERE item_id = ? AND id != ? AND user_text != '' ORDER BY created_at DESC, rowid DESC LIMIT 2`,
    ).all(item.id, turnId ?? "") as Array<{ origin_kind: string; user_text: string; assistant_text: string }>).reverse();
    const lines = [
      `用户在工单 #${item.id} 的工单对话里问你：[${item.stage}] ${item.title}，project=${item.project ?? "unknown"}。你的回答会出现在这张工单的对话里。`,
      `回答进展、状态、卡在哪之前，先调 get_ticket_status(ticket_id=${item.id})，以它返回的为准，不凭会话记忆。`,
      "不要为了回答进展去续接执行 agent 的会话。只有回答必须用到执行 agent 的工作上下文（例如它改了什么、为什么这样做）时，"
        + "才用 continue_ticket_agent 转给它：那会续接它的会话，花很多 token，先告诉用户。",
    ];
    if (recent.length) {
      lines.push("这张工单对话里最近的消息（旧的在前）：");
      for (const turn of recent) {
        const answerer = turn.origin_kind.endsWith(":ticket-agent") ? "执行 agent" : "Lead";
        lines.push(`- 用户：${clip(turn.user_text, 200)}`);
        if (turn.assistant_text.trim()) lines.push(`  ${answerer}：${clip(turn.assistant_text, 400)}`);
      }
    }
    return lines.join("\n");
  }
  // daemon 崩溃（没有排空）时还没有结局的用户的一轮（工单 04，spec 场景 8）：停在 streaming、queued、steered，没有错误，
  // 用户的消息也还没有处置。有界：只看最近 24 小时里的，最多 20 条，更早的旧行不动。
  //   · 这一轮里 Lead 还没调过工具：等这个 daemon 来答（和排空打断的一样，LEAD_RESTART_INTERRUPTED_ERROR），按发来的先后；
  //   · 调过工具（可能已经建了提醒、工单）：用户的话不再发一次。这一轮记成被重启打断，叫醒 Lead 接着回复。
  for (const row of listUnfinishedLeadTurns(db, { since: new Date(Date.now() - 24 * 3_600_000) })) {
    const tools = [...new Set((db.prepare(
      `SELECT json_extract(payload, '$.toolName') AS name FROM gateway_events
       WHERE turn_id = ? AND event_type = 'lead.tool.started' ORDER BY seq`,
    ).all(row.id) as Array<{ name: string | null }>).map((tool) => tool.name ?? "unknown"))];
    if (tools.length) {
      failTurn(db, row.id, LEAD_RESTART_INTERRUPTED_ERROR);
      const preview = userTurnText(row).replace(/\s+/g, " ").trim().slice(0, 120);
      addInbox(db, {
        ...(row.item_id === null ? { dedupScope: `lead-turn-interrupted:${row.id}` } : { itemId: row.item_id }),
        severity: "attention",
        source: "structural",
        summary: [
          `你回复用户消息「${preview}」的这一轮被 daemon 崩溃打断，用户没有收到你的回复。这条消息不会再发给你一次。`,
          `打断前调过的工具（结果不确定，可能已经执行）：${tools.join("、")}`,
        ].join("\n"),
        payload: { kind: "lead_turn_interrupted", turnId: row.id, wakeLead: true, needsUser: false },
        lossless: true,
      });
      log(`turn ${row.id} was cut off by a crash after ${tools.length} tool call(s): the next Lead is told`);
      continue;
    }
    // 和被重启打断的一样等这个 daemon 来答：下面按发来的先后，和别的在等的轮次一起排。
    waitTurnForRetry(db, row.id, LEAD_RESTART_INTERRUPTED_ERROR);
    log(`turn ${row.id} had no outcome after a crash: answering it again`);
  }

  // daemon 重启前还在等重试的轮次：接着等，网络通了就再试（每一轮仍然只再试一次）。原文按轮次重新包一次。
  // 被重启打断的轮次和停机时发来的消息也在这里（LEAD_RESTART_INTERRUPTED_ERROR），按发来的先后回答。
  for (const row of db.prepare(
    `SELECT * FROM channel_turns WHERE state = 'queued' AND error IS NOT NULL
       AND origin_kind LIKE 'paired:%' AND origin_kind NOT LIKE '%:ticket%'
     ORDER BY created_at, rowid`,
  ).all() as ChannelTurnRow[]) {
    const binding = row.origin_binding_id === null ? null : getBinding(db, row.origin_binding_id);
    userTurnPrompts.set(row.id, userTurnPrompt({
      via: binding?.display_name ?? "unknown", channel: row.origin_kind, itemId: row.item_id, message: row.user_text,
      turnId: row.id, imageIds: (listChatImageRefs(db, [row.id]).get(row.id) ?? []).map((image) => image.id),
    }));
    userTurnRetries.set(row.id, { at: null });
  }
  function waitToRetry(entry: ActiveChannelTurn, error: string): boolean {
    const id = entry.turn.id;
    if (!userTurnPrompts.has(id)) return false;
    // 被重启打断：调过工具的不再答一次（handInterruptedWorkToLead 叫醒下一个 Lead 接着回复）。
    // 只说了话的没有副作用，下一个 daemon 再答一次。
    if (isLeadRestartInterruption(error)) {
      if (entry.ranTools) return false;
      holdTurnForRestart(entry);
      return true;
    }
    if (retriedUserTurns.has(id)) return false;
    // 第一次已经说了话或者调了工具：再试一次可能把事情做第二遍（发布评审 f796c1c）。给「重发」，由用户决定。
    if (entry.assistantText.trim() || entry.ranTools) return false;
    const kind = classifyLeadModelError(error);
    // 上下文满了（2026-10-28）：再试的那一轮开始以前 daemon 先按长度预算压缩（recoverLeadContext），可能就答上了。
    if (kind !== "network" && kind !== "unavailable" && kind !== "busy" && kind !== "context") return false;
    waitTurnForRetry(db, id, error);
    userTurnRetries.set(id, { at: kind === "network" ? null : Date.now() + userTurnRetryMs });
    publishControlEvent({
      type: "notice.created", requiredScope: "chat",
      audienceBindingId: entry.turn.origin_binding_id ?? undefined,
      turnId: id,
      itemId: entry.turn.item_id ?? undefined,
      payload: { severity: "error", message: error, retry: "waiting", waitingFor: kind === "network" ? "network" : "model" },
    });
    log(`user turn ${id} failed (${kind}): retrying once ${kind === "network" ? "when the network is back" : "shortly"}`);
    return true;
  }

  // 用户的一轮等重启后的 daemon 来答（排空时发来的消息，或者被重启打断、还没调过工具的一轮）：
  // 回到 queued，error 是 LEAD_RESTART_INTERRUPTED_ERROR。客户端显示「在等」，不给「重发」。
  function holdTurnForRestart(entry: ActiveChannelTurn): void {
    const id = entry.turn.id;
    waitTurnForRetry(db, id, LEAD_RESTART_INTERRUPTED_ERROR);
    userTurnRetries.set(id, { at: null });
    publishControlEvent({
      type: "notice.created", requiredScope: "chat",
      audienceBindingId: entry.turn.origin_binding_id ?? undefined,
      turnId: id,
      itemId: entry.turn.item_id ?? undefined,
      payload: { severity: "error", message: LEAD_RESTART_INTERRUPTED_ERROR, retry: "waiting", waitingFor: "model" },
    });
    log(`user turn ${id} held for the daemon restart`);
  }

  // 到点的那一轮（一次一轮）。Lead 正忙、正在排空或者网络还没恢复时等下一次。
  function retryWaitingUserTurn(now = Date.now()): void {
    if (busy || draining || !network.online) return;
    for (const [id, retry] of userTurnRetries) {
      if (retry.at !== null && now < retry.at) continue;
      userTurnRetries.delete(id);
      const prompt = userTurnPrompts.get(id);
      const waiting = db.prepare("SELECT error FROM channel_turns WHERE id = ?").get(id) as { error: string | null } | undefined;
      const turn = prompt ? restartTurnForRetry(db, id) : null;
      if (!prompt || !turn) continue;
      // 等重启的这一轮还没真正答过：这一次不算那一次重试。
      if (!isLeadRestartInterruption(waiting?.error)) retriedUserTurns.add(id);
      log(`retrying user turn ${id}`);
      void runTurn(prompt, { channelTurn: { turn, assistantText: "" } });
      return;
    }
  }

  // 用户问 Lead 的话还没有得到回答：排在队里等那一次自动重试，或者等重启后的 daemon 来答（userTurnRetries，
  // 启动时从库里恢复）。Lead 空闲时不会有别的排队轮次：插话的轮次在那一轮结束时已经有了结局。
  // 不按库里 state='queued' 的行判断：daemon 崩溃时留下的旧行没有人收尾，会让整理笔记永远不跑。
  // 排队等下一轮的用户消息（工单 04：赶不上的插话、排队消息）也算。
  function hasUnansweredUserTurn(): boolean {
    return userTurnRetries.size > 0 || carryOverTurns.length > 0 || queuedInputs.length > 0;
  }

  function failChannelTurn(entry: ActiveChannelTurn, error: string): void {
    if (waitToRetry(entry, error)) return;
    replyToChannelOwner(entry.turn.id, `这一轮没有答上：${error}`);
    userTurnPrompts.delete(entry.turn.id);
    retriedUserTurns.delete(entry.turn.id);
    failTurn(db, entry.turn.id, error);
    publishControlEvent({
      type: "notice.created", requiredScope: "chat",
      audienceBindingId: entry.turn.origin_binding_id ?? undefined,
      turnId: entry.turn.id,
      itemId: entry.turn.item_id ?? undefined,
      payload: { severity: "error", message: error },
    });
    if (isLeadRestartInterruption(error) && entry.ranTools) handInterruptedWorkToLead(entry);
  }

  // 调过工具的一轮被重启打断（Jarvis 模式，2026-10-16 决定 D2）：用户的话不再发一次，免得把事情做第二遍。
  // 记一条叫醒 Lead 的 inbox 行（落库，下一个 daemon 读得到），写清事实：哪一轮被打断、已经说了什么、
  // 哪些工具做完了、结果是什么。下一个 daemon 照常叫醒 Lead，由它接着回复。
  function handInterruptedWorkToLead(entry: ActiveChannelTurn): void {
    const preview = (text: string, max: number) => {
      const flat = text.replace(/\s+/g, " ").trim();
      return flat.length > max ? `${flat.slice(0, max)}…` : flat;
    };
    const tools = [...(entry.tools?.values() ?? [])];
    const listed = (state: "done" | "failed" | "running", line: (tool: typeof tools[number]) => string) =>
      tools.filter((tool) => tool.state === state).map((tool) => `- ${line(tool)}`).join("\n");
    const done = listed("done", (tool) => `${tool.name}：${tool.result || "完成，没有返回文字"}`);
    const failed = listed("failed", (tool) => `${tool.name}：失败${tool.result ? `（${tool.result}）` : ""}`);
    const unfinished = listed("running", (tool) => `${tool.name}：没有等到结果，可能已经执行`);
    const userText = userTurnText(entry.turn).trim();
    const said = entry.assistantText.trim();
    const summary = [
      userText
        ? `你回复用户消息「${preview(userText, 120)}」的这一轮被 daemon 重启打断，用户没有收到你的回复。这条消息不会再发给你一次。`
        : "你自己发起的这一轮被 daemon 重启打断。",
      said ? `打断前你已经对用户说了：「${preview(said, 200)}」` : null,
      done ? `已经完成的工具调用：\n${done}` : null,
      failed ? `失败的工具调用：\n${failed}` : null,
      unfinished ? `没有完成的工具调用：\n${unfinished}` : null,
    ].filter(Boolean).join("\n");
    addInbox(db, {
      ...(entry.turn.item_id === null ? { dedupScope: `lead-turn-interrupted:${entry.turn.id}` } : { itemId: entry.turn.item_id }),
      severity: "attention",
      source: "structural",
      summary,
      payload: { kind: "lead_turn_interrupted", turnId: entry.turn.id, wakeLead: true, needsUser: false },
      lossless: true,
    });
    log(`turn ${entry.turn.id} was interrupted after ${tools.length} tool call(s): the next Lead is told`);
  }

  // 一轮失败时存下、发给客户端的错误：模型的原文，先遮住里面的密钥。每个客户端用 packages/protocol 的同一套分类
  // 自己说成一句话（认证失败不叫人重试），原文留给「技术详情」。以前这里把 401 改写成"Lead 模型连接认证失败，请重试。"，
  // 它叫人重试一个再试也一样的失败，也丢了原文。
  function presentLeadTurnError(error: string): string {
    return redactSecretText(error.trim()) || EMPTY_ASSISTANT_REPLY_ERROR;
  }

  function sealChannelTurn(entry: ActiveChannelTurn): void {
    // lead 自己发起的回合没有人在等回答：只调了工具、没说话也是正常收尾，不算失败。
    if (!isSystemTurnOrigin(entry.turn.origin_kind) && shouldFailEmptyLeadTurn({
      assistantText: entry.assistantText,
      pendingModelSwitch: pendingLeadModelRestart !== null,
      drewSurface: entry.drewSurface === true,
    })) {
      failChannelTurn(entry, EMPTY_ASSISTANT_REPLY_ERROR);
      return;
    }
    if (!entry.assistantText.trim() && pendingLeadModelRestart) {
      publishTurnText(entry, `${leadModelSwitchStatusMessage(
        pendingLeadModelRestart.previous,
        pendingLeadModelRestart.selected,
        leadDisplayName(db),
      )}\n`);
    }
    completeTurn(db, entry.turn.id);
    replyToChannelOwner(entry.turn.id, entry.assistantText.trim() || (entry.drewSurface ? "回复是一张卡片，只在 App 里看得到。" : ""));
    userTurnPrompts.delete(entry.turn.id);
    retriedUserTurns.delete(entry.turn.id);
    publishControlEvent({
      type: "lead.message.completed", requiredScope: "chat",
      audienceBindingId: entry.turn.origin_binding_id ?? undefined,
      turnId: entry.turn.id,
      itemId: entry.turn.item_id ?? undefined,
      payload: { messageId: `msg_${entry.turn.id}`, text: entry.assistantText },
    });
    // 工单 agent 答完了这一轮：在后台判断回复下面要不要给动作按钮。不等它，回答已经送达。
    if (entry.turn.origin_kind.endsWith(":ticket-agent") && entry.turn.item_id !== null && entry.assistantText.trim()) {
      replyActionsJudge?.judge({ turnId: entry.turn.id, itemId: entry.turn.item_id, text: entry.assistantText });
    }
  }

  // placement（工单 04，spec D10）：用户的消息现在怎么放的，界面据此标「排队中」「已插入」「下一轮回答」，
  // 以及「和后面的消息一起回答」（answered_together，answeredWith 是答它的那一轮）。mode 的取值不变：
  // 旧客户端严格校验 mode，新加的说明放在 payload 的新字段里（客户端的 payload 校验是开放的）。
  function publishTurnStarted(
    entry: ActiveChannelTurn, mode: "started" | "steered" | "queued",
    extra: { placement?: TurnPlacement; answeredWith?: string } = {},
  ): void {
    publishControlEvent({
      type: "lead.turn.started", requiredScope: "chat",
      audienceBindingId: entry.turn.origin_binding_id ?? undefined,
      turnId: entry.turn.id,
      itemId: entry.turn.item_id ?? undefined,
      payload: {
        messageId: `msg_${entry.turn.id}`,
        commandId: entry.commandId ?? null,
        originKind: entry.turn.origin_kind,
        mode,
        ...(extra.placement ? { placement: extra.placement } : {}),
        ...(extra.answeredWith ? { answeredWith: extra.answeredWith } : {}),
      },
    });
  }

  // /fairyeye on|off（Lead 的形象，用户 2026-10-28：「只有输入 /fairyeye on 才能让矢量 FairyEye 出现」）：daemon 自己答。
  // 用户的这条消息记成一轮（会话里看得到），开关改在 engine 的 setLeadAvatarFairyEye，回复是 daemon 写的一句话。
  // 不交给 Lead、不调模型，所以和 Lead 忙不忙、是不是正在停机都无关。回合的事件在受理之后发（和别的轮次一样排在 command.result 后面）。
  function answerFairyEyeCommand(
    command: { message: string; bindingId: number; bindingKind: string; commandId: string }, on: boolean,
  ): { mode: "started"; turnId: string } {
    const turn = createTurn(db, {
      originBindingId: command.bindingId, originKind: `paired:${command.bindingKind}`, userText: command.message, state: "streaming",
      // 命令不是对 Lead 说的话：不记 user.message 事件，Lead 在等用户回话时不会被它叫醒。
      userMessageEvent: false,
    });
    const entry: ActiveChannelTurn = { turn, assistantText: "", commandId: command.commandId };
    queueMicrotask(() => {
      try {
        publishTurnStarted(entry, "started");
        const outcome = setLeadAvatarFairyEye(db, {
          on,
          publish: (resource: typeof LEAD_AVATAR_RESOURCE) => {
            publishControlEvent({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } });
          },
          log,
        });
        publishTurnText(entry, fairyEyeReply(on, outcome.changed, leadDisplayName(db)));
        sealChannelTurn(entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[lead-avatar] /fairyeye failed: ${message}`);
        failChannelTurn(entry, `没有改 FairyEye：${message}`);
      }
    });
    return { mode: "started", turnId: turn.id };
  }

  // 用户的一条消息没有自己的回答，Lead 把它和后面那一条一起答了（工单 04 第 7 项）：结局是 done，不是失败。
  // answeredWith 为空：插话送到了这一轮，Lead 在这一轮里看到了它，没有另外回答。
  function settleAnsweredTogether(entry: ActiveChannelTurn, answeredWith: ActiveChannelTurn | null, note: string): void {
    settleTurnAnsweredWith(db, entry.turn.id, { answeredWith: answeredWith?.turn.id ?? null, note });
    const owners = channelOwnerReplies.get(entry.turn.id);
    if (owners && answeredWith) {
      channelOwnerReplies.delete(entry.turn.id);
      channelOwnerReplies.set(answeredWith.turn.id, [...(channelOwnerReplies.get(answeredWith.turn.id) ?? []), ...owners]);
    } else if (owners) {
      replyToChannelOwner(entry.turn.id, note);
    }
    userTurnPrompts.delete(entry.turn.id);
    retriedUserTurns.delete(entry.turn.id);
    userTurnRetries.delete(entry.turn.id);
    publishTurnStarted(entry, "steered", {
      placement: "answered_together", ...(answeredWith ? { answeredWith: answeredWith.turn.id } : {}),
    });
  }

  // 出水口从 previous 改接给 next 时，previous 怎样收口：它有自己的回答就照常收口；
  // 它是用户的一轮、一个字都没说（Lead 的第一段话在 next 送到之后），它和 next 一起答了。
  function closeHandedOver(previous: ActiveChannelTurn, next: ActiveChannelTurn): void {
    const silentUserTurn = !isSystemTurnOrigin(previous.turn.origin_kind)
      && !previous.assistantText.trim() && previous.drewSurface !== true;
    if (!silentUserTurn) {
      sealChannelTurn(previous);
      return;
    }
    settleAnsweredTogether(previous, next, next.placement === "followUp" ? "和后面的排队消息一起回答" : "和后面的插话一起回答");
  }

  // 系统回合没有发起的 binding（origin_binding_id 为空），所以事件发给所有带 chat scope 的客户端。
  // 用户发起的回合只发给发起的 binding：别的客户端没有那句提问，只收到回答没有意义；
  // 它们刷新会话流时（GET /v1/conversation/turns）照样看得到全部回合。
  function materializeSystemTurn(): void {
    if (activeChannelTurn || !pendingSystemOrigin) return;
    const reused = pendingSystemReuseTurnId ? reopenTurn(db, pendingSystemReuseTurnId) : null;
    const turn = reused ?? createTurn(db, { originKind: pendingSystemOrigin, userText: "", state: "streaming" });
    pendingSystemOrigin = null;
    pendingSystemReuseTurnId = null;
    activeChannelTurn = { turn, assistantText: "" };
    systemEntryThisTurn = activeChannelTurn;
    // 先记「这一轮在回应哪件事」、把提醒卡推出去，再发轮次开始：界面拿到这一轮时已经知道它属于哪张卡，不会先画一个气泡。
    const respondsTo = pendingSystemRespondsTo;
    pendingSystemRespondsTo = null;
    if (respondsTo?.length) {
      pollStep("turn-responding", () => {
        recordLeadTurnResponding(db, { turnId: turn.id, events: respondsTo });
        syncLeadActivity?.("event");
      });
    }
    publishTurnStarted(activeChannelTurn, "started");
  }

  // 旧版 v1 连接收到的 [error] 广播：同一句话 60 秒内只推一次（例如模型连不上时的重试）。
  let lastErrorBroadcast: { text: string; at: number } | null = null;
  function broadcastTurnError(message: string): void {
    const text = `[error] ${message}`;
    const now = Date.now();
    if (lastErrorBroadcast?.text === text && now - lastErrorBroadcast.at < 60_000) return;
    lastErrorBroadcast = { text, at: now };
    broadcast({ type: "notice", text });
  }

  // daemon 自己发出的一条系统通知（不经过 lead），例如 blocker 提示和兜底投递的通知。
  // 以前它们只经过 plc.sock 的广播；现在是会话流里一轮已完成的消息，plc 和 companion 都看得到。
  // id：同一件事只写一轮。这个 id 的一轮已经在会话里时，什么都不做。
  function publishSystemNotice(originKind: SystemTurnOrigin, text: string, options: { id?: string } = {}): void {
    if (options.id && db.prepare("SELECT 1 FROM channel_turns WHERE id = ?").get(options.id)) return;
    const entry: ActiveChannelTurn = {
      turn: createTurn(db, { ...(options.id ? { id: options.id } : {}), originKind, userText: "", state: "streaming" }),
      assistantText: "",
    };
    publishTurnStarted(entry, "started");
    publishTurnText(entry, text);
    sealChannelTurn(entry);
  }

  function completeSyntheticChannelTurn(
    command: {
      bindingId: number;
      bindingKind: string;
      itemId: number;
      commandId: string;
      userText: string;
      originKind?: string;
    },
    assistantText: string,
  ): { mode: "started"; turnId: string } {
    const turn = createTurn(db, {
      originBindingId: command.bindingId,
      originKind: command.originKind ?? `paired:${command.bindingKind}:ticket`,
      itemId: command.itemId,
      userText: command.userText,
      state: "streaming",
    });
    const entry: ActiveChannelTurn = { turn, assistantText: "", commandId: command.commandId };
    publishControlEvent({
      type: "lead.turn.started",
      requiredScope: "chat",
      audienceBindingId: turn.origin_binding_id ?? undefined,
      turnId: turn.id,
      itemId: turn.item_id ?? undefined,
      payload: {
        messageId: `msg_${turn.id}`,
        commandId: command.commandId,
        originKind: turn.origin_kind,
        mode: "started",
      },
    });
    publishTurnText(entry, assistantText);
    sealChannelTurn(entry);
    return { mode: "started", turnId: turn.id };
  }

  function startTicketAgentChannelTurn(command: {
    bindingId: number;
    bindingKind: string;
    itemId: number;
    commandId: string;
    userText: string;
  }, runId: number | null, sealAt: "run_end" | "reply"): ActiveChannelTurn {
    const turn = createTurn(db, {
      originBindingId: command.bindingId,
      originKind: `paired:${command.bindingKind}:ticket-agent`,
      itemId: command.itemId,
      userText: command.userText,
      state: "streaming",
    });
    const entry: ActiveChannelTurn = { turn, assistantText: "", commandId: command.commandId, sealAt, messageText: "" };
    // runId 为 null：没有 Run 接这一轮（转交失败），调用方马上让它失败，所以不挂在任何 Run 上。
    if (runId !== null && ticketAgentTurns.has(runId)) {
      const superseded = pendingTicketAgentTurns.get(runId);
      if (superseded) closeSupersededTicketAgentTurn(superseded);
      pendingTicketAgentTurns.set(runId, entry);
    } else if (runId !== null) {
      ticketAgentTurns.set(runId, entry);
    }
    publishControlEvent({
      type: "lead.turn.started",
      requiredScope: "chat",
      audienceBindingId: turn.origin_binding_id ?? undefined,
      turnId: turn.id,
      itemId: turn.item_id ?? undefined,
      payload: {
        messageId: `msg_${turn.id}`,
        commandId: command.commandId,
        originKind: turn.origin_kind,
        mode: "started",
      },
    });
    return entry;
  }

  // 被下一条消息接替的轮次。有文本就照常收口；一个字都没说的，它的问题和下一条一起回答，
  // 停在 steered（和 lead 的插话同一个终态），不记成失败。
  function closeSupersededTicketAgentTurn(entry: ActiveChannelTurn): void {
    if (entry.assistantText.trim()) {
      sealChannelTurn(entry);
      return;
    }
    markTurnSteered(db, entry.turn.id);
    publishControlEvent({
      type: "lead.turn.started",
      requiredScope: "chat",
      audienceBindingId: entry.turn.origin_binding_id ?? undefined,
      turnId: entry.turn.id,
      itemId: entry.turn.item_id ?? undefined,
      payload: {
        messageId: `msg_${entry.turn.id}`,
        commandId: entry.commandId ?? null,
        originKind: entry.turn.origin_kind,
        mode: "steered",
      },
    });
  }

  function dropTicketAgentTurn(runId: number, entry: ActiveChannelTurn): void {
    if (ticketAgentTurns.get(runId) === entry) ticketAgentTurns.delete(runId);
    if (pendingTicketAgentTurns.get(runId) === entry) pendingTicketAgentTurns.delete(runId);
  }

  // Run 结束时，这个 Run 上还开着的轮次都落终态。failure 不为空时它们都失败；
  // 否则有文本的收口，没有文本的就是没有得到回答。
  function endTicketAgentTurns(itemId: number, runId: number, failure: string | null): void {
    let failed = false;
    let pausedTurnRemembered = false;
    for (const turns of [ticketAgentTurns, pendingTicketAgentTurns]) {
      const entry = turns.get(runId);
      if (!entry) continue;
      turns.delete(runId);
      if (!failure && entry.assistantText.trim()) {
        sealChannelTurn(entry);
        continue;
      }
      failChannelTurn(entry, failure ?? EMPTY_ASSISTANT_REPLY_ERROR);
      failed = true;
      // 暂停打断的对话 Run：记下是哪一轮，恢复时接回它（reattachPausedTicketTurn）。正在回答的那一轮优先。
      if (failure === PAUSED_TICKET_TURN_ERROR && !pausedTurnRemembered) {
        const run = getRun(db, runId);
        if (run && effectiveRunPurpose(db, run) === "conversation") {
          rememberPausedTurn(db, runId, entry.turn.id);
          pausedTurnRemembered = true;
        }
      }
    }
    if (!failed) return;
    publishControlEvent({
      type: "ticket.updated",
      requiredScope: "tickets:view",
      itemId,
      payload: { ticketId: itemId, snapshotRequired: true },
    });
  }

  // 用户暂停或停止 Run 时，runtime 适配器发的 run.failed 只说进程退出了
  // （pi："Pi process exited before agent_end (143)"）。轮次上写用户做了什么，不写成一次崩溃。
  function ticketAgentRunFailure(runId: number, fallback: string | null): string | null {
    const state = getRun(db, runId)?.state;
    if (state === "paused") return PAUSED_TICKET_TURN_ERROR;
    if (state === "stopped") return "Run 已停止，这一轮回答没有完成。";
    return fallback;
  }

  // 暂停的工单对话 Run 恢复以后，回答要落在暂停时那一轮里（发布评审 run-resume F4）。暂停时那一轮被记成失败、
  // 从内存表里拿掉了，恢复只拉起进程：不接回来，回答的文字没有地方落。按暂停时记在库里的 Run → 轮次找回那一轮（daemon 重启过也找得到）。
  function reattachPausedTicketTurn(itemId: number, runId: number): void {
    const run = getRun(db, runId);
    if (!run || run.item_id !== itemId || effectiveRunPurpose(db, run) !== "conversation" || ticketAgentTurns.has(runId)) return;
    // 只接回暂停时记下的、这个 Run 自己的那一轮。没有记录（例如 Lead 发起的对话 Run 本来没有轮次）就不接。
    const turnId = takePausedTurn(db, runId);
    const turn = turnId ? reopenPausedTurn(db, turnId) : null;
    if (!turn) return;
    const entry: ActiveChannelTurn = { turn, assistantText: "", sealAt: "run_end", messageText: "" };
    ticketAgentTurns.set(runId, entry);
    publishTurnStarted(entry, "started");
  }

  // 兜底：Run 结束时没有收到终态事件（runItem 在启动阶段抛错、或者 runtime 没发 run.failed），
  // 它上面的轮次会一直停在 streaming。child 收尾时，给这张工单上已经不在跑的 Run 的轮次补一个终态。
  function endStaleTicketAgentTurns(itemId: number, err?: Error): void {
    const liveRunId = liveChildren().get(itemId)?.runId;
    const runIds = new Set<number>();
    for (const turns of [ticketAgentTurns, pendingTicketAgentTurns]) {
      for (const [runId, entry] of turns) {
        if (entry.turn.item_id === itemId && runId !== liveRunId) runIds.add(runId);
      }
    }
    for (const runId of runIds) endTicketAgentTurns(itemId, runId, ticketAgentRunFailure(runId, err?.message ?? null));
  }

  // 插话进一个还在跑的 Run 时，轮次在哪里收口取决于这个 Run 实际怎么跑：按 conversation 跑的
  // 整个都在回答，在 Run 结束时收口；执行中的 Run 的回答是插话之后的第一条消息，之后的消息属于执行本身。
  // 每条启动路径都按库里的用途跑 Run；旧版本留下的 run_started_as 由 effectiveRunPurpose 读回，接管时也按它跑。
  // （没有 live Run 时走 routeTicketMessageToAgentRun：它总是新建一个 conversation Run，有暂停的 Run 时也一样，
  // manager 在这一回合结束时结束 Run，所以那条路径总是在 Run 结束时收口。）
  function liveTicketRunSealAt(runId: number): "run_end" | "reply" {
    const run = getRun(db, runId);
    return run && effectiveRunPurpose(db, run) === "conversation" ? "run_end" : "reply";
  }

  function projectTicketAgentEvent(itemId: number, runId: number, event: RuntimeEvent): void {
    if (event.type === "run.failed") {
      endTicketAgentTurns(itemId, runId, ticketAgentRunFailure(runId, event.error));
      return;
    }
    if (event.type === "run.completed") {
      endTicketAgentTurns(itemId, runId, null);
      return;
    }
    if (event.type !== "message.delta" && event.type !== "message.completed") return;
    const pending = pendingTicketAgentTurns.get(runId);
    const current = ticketAgentTurns.get(runId);
    if (pending && !current?.messageText) {
      pendingTicketAgentTurns.delete(runId);
      if (current) closeSupersededTicketAgentTurn(current);
      ticketAgentTurns.set(runId, pending);
    }
    const entry = ticketAgentTurns.get(runId);
    if (!entry) return;
    if (event.type === "message.delta") {
      // 同一轮里的第二条助手消息开始了：先空一行，免得两条消息粘成一句。
      if (!entry.messageText && entry.assistantText.trim()) publishTurnText(entry, "\n\n");
      entry.messageText = `${entry.messageText ?? ""}${event.delta}`;
      publishTurnText(entry, event.delta);
      return;
    }
    if (event.type === "message.completed") {
      const streamed = entry.messageText ?? "";
      const suffix = event.text.startsWith(streamed) ? event.text.slice(streamed.length) : event.text;
      if (suffix) {
        if (!streamed && entry.assistantText.trim()) publishTurnText(entry, "\n\n");
        publishTurnText(entry, suffix);
      }
      entry.messageText = "";
      if (entry.sealAt === "run_end") return;
      if (entry.assistantText.trim()) sealChannelTurn(entry);
      else failChannelTurn(entry, EMPTY_ASSISTANT_REPLY_ERROR);
      ticketAgentTurns.delete(runId);
    }
  }

  async function sendToLiveTicketRun(itemId: number, message: string): Promise<{ runId: number; mode: "steer" | "prompt" } | null> {
    const child = liveChildren().get(itemId);
    if (!child) return null;
    const mode = child.streaming ? "steer" : "prompt";
    // agent 收到的话开头是系统现在的 TicketSummary（2026-10-19）：和开新的对话 Run 一样，它记得的状态可能已经旧了。
    const input = liveTicketMessagePrompt(schedDeps, itemId, message);
    if (child.streaming) {
      if (child.handle?.steer) await child.handle.steer(input);
      else if (child.rpc) {
        const resp = await child.rpc.send({ type: "steer", message: input });
        if (!resp.success) throw new Error(`steer 失败: ${resp.error}`);
      } else {
        throw new Error("当前 run 不支持执行中 steering");
      }
    } else if (child.handle?.send) {
      await child.handle.send(input);
    } else if (child.rpc) {
      const resp = await child.rpc.send({ type: "prompt", message: input });
      if (!resp.success) throw new Error(`prompt 失败: ${resp.error}`);
    } else {
      throw new Error("当前 run 不支持续接 prompt");
    }
    addActivity(db, {
      itemId,
      runId: child.runId,
      actor: "user",
      kind: "comment",
      payload: { content: message, route: "ticket_run", mode },
    });
    publishControlEvent({
      type: "ticket.updated",
      requiredScope: "tickets:view",
      itemId,
      payload: { ticketId: itemId, snapshotRequired: true },
    });
    return { runId: child.runId, mode };
  }

  // 工单对话里的一条消息（spec D13，工单 08）。一律交给这张工单的 agent（用户 2026-10-19 的决定），不按消息的内容分流：
  //   · 有 Run 在跑时交给那个 Run：能中途接收消息的插话或续接，不能的排队到它结束；
  //   · 没有时开一个对话 Run，续接最近的会话（routeTicketMessageToAgentRun）。
  // 两条路上 agent 的输入开头都是系统现在的 TicketSummary。2026-10-16 的 #77：工单已经 done，续接的 reviewer 会话
  // 按旧记忆答「还在 review」。送不到 agent 时（插话失败、排队的消息转交失败）交给 Lead 兜底（handTicketMessageToLead）：
  // 那是故障处理，不是分流。
  // 旧客户端还会带 context.answerer（chat.ticket-answerer.v1，已发布的线上字段）：网关照样收下，这里不再收它，也就忽略了它。
  function handleTicketMessage(command: {
    message: string;
    bindingId: number;
    bindingKind: string;
    bindingName: string;
    itemId: number;
    commandId: string;
  }): { mode: ChatSendMode; turnId: string } {
    const item = getItem(db, command.itemId);
    if (!item) throw new PairedCommandError("not_found", `item #${command.itemId} not found`);

    const liveChild = liveChildren().get(item.id);
    // 在跑的 Run 不能中途接收消息（Codex、Claude Code 的 adapter 都是这样）：消息排队，Run 结束后转交
    // （2026-10-15 #66：以前直接失败，「重发」也必然再失败，Lead 也不知道）。
    if (liveChild && !canDeliverToLiveRun(liveChild)) {
      const turn = queueTicketMessage(command);
      return { mode: "started", turnId: turn.id };
    }
    // 这一轮已经结束、进程只在停留（linger）的 Run 也不接收：它已经结束，新一轮的事件不再落库，用户看不到回答，
    // 这一轮一直停在「正在执行」（2026-10-19 工单 #93 的 Run #106）。消息排队，停止停留的进程，
    // Run 收尾时 deliverQueuedTicketMessages 开一个新的对话 Run，续接会话回答。
    if (liveChild?.settled) {
      const turn = queueTicketMessage(command);
      void releaseSettledChild(item.id, "a ticket message arrived after the run's turn ended")
        .catch((error) => log(`stopping the lingering run of #${item.id} failed: ${String(error)}`));
      return { mode: "started", turnId: turn.id };
    }
    if (liveChild) {
      const entry = startTicketAgentChannelTurn({
        bindingId: command.bindingId,
        bindingKind: command.bindingKind,
        itemId: item.id,
        commandId: command.commandId,
        userText: command.message,
      }, liveChild.runId, liveTicketRunSealAt(liveChild.runId));
      void sendToLiveTicketRun(item.id, command.message)
        .catch((error) => {
          log(`ticket message route error: ${error.message}`);
          failChannelTurn(entry, error.message);
          dropTicketAgentTurn(liveChild.runId, entry);
          handTicketMessageToLead(item.id, command.message, error.message);
        });
      return { mode: "started", turnId: entry.turn.id };
    }

    const turnCommand = {
      bindingId: command.bindingId,
      bindingKind: command.bindingKind,
      itemId: item.id,
      commandId: command.commandId,
      userText: command.message,
    };
    let routed: ReturnType<typeof routeTicketMessageToAgentRun>;
    try {
      routed = routeTicketMessageToAgentRun(schedDeps, { itemId: item.id, message: command.message });
    } catch (error) {
      // 转交不了（2026-10-20 工单 #102：核查员的 runtime 被用户停用）。以前错误抛给网关，客户端收到 internal_error，
      // 发件箱当临时错误重发了 177 次，后面发给 Lead 的消息也一直发不出去。现在和排队消息转交失败一样
      // （deliverQueuedTicketMessages）：这一轮失败，写明原因，消息交给 Lead。
      const reason = error instanceof Error ? error.message : String(error);
      log(`ticket message undelivered: ${reason}`);
      const entry = startTicketAgentChannelTurn(turnCommand, null, "run_end");
      failChannelTurn(entry, reason);
      handTicketMessageToLead(item.id, command.message, reason);
      return { mode: "started", turnId: entry.turn.id };
    }
    const entry = startTicketAgentChannelTurn(turnCommand, routed.runId, "run_end");
    publishControlEvent({
      type: "ticket.updated",
      requiredScope: "tickets:view",
      itemId: item.id,
      payload: { ticketId: item.id, snapshotRequired: true },
    });
    return { mode: "started", turnId: entry.turn.id };
  }

  // render_ui 的流式（generative UI，2026-10-15）：模型还在写参数时，用已经完整的节点拼一张「生成中」的卡片
  // 先发出去（lead.tool.updated，partial: true）。同一次调用的定稿版（工具结束时）替换它。
  // 卡片没有变化时不重发；同一次调用最多每 100 ms 发一次。
  const streamedSurfaces = new Map<string, { key: string; at: number }>();
  function streamRenderUi(update: any): void {
    if (!update || (update.type !== "toolcall_start" && update.type !== "toolcall_delta")) return;
    const block = update.partial?.content?.[update.contentIndex];
    if (!block || block.type !== "toolCall" || block.name !== "render_ui" || typeof block.id !== "string") return;
    const surface = partialUiSurface(block.arguments, block.id);
    if (!surface) return;
    const key = JSON.stringify(surface);
    const last = streamedSurfaces.get(block.id);
    const now = Date.now();
    if (last && (last.key === key || now - last.at < 100)) return;
    // render_ui 会改变用户看到的东西：系统回合在这一刻落成（和改变外部状态的工具一样）。
    if (!activeChannelTurn && systemTurnBuffer && !pendingSteerSink) materializeBufferedSystemTurn(systemTurnBuffer);
    if (!activeChannelTurn) return;
    streamedSurfaces.set(block.id, { key, at: now });
    persistLeadToolConversationEvent(db, {
      type: "lead.tool.updated",
      audienceBindingId: activeChannelTurn.turn.origin_binding_id ?? undefined,
      turnId: activeChannelTurn.turn.id,
      itemId: activeChannelTurn.turn.item_id ?? undefined,
      payload: {
        toolCallId: block.id,
        toolName: "render_ui",
        textOffset: systemTurnBuffer ? systemTurnBuffer.text.length : activeChannelTurn.assistantText.length,
        surface,
        partial: true,
      },
    });
  }

  // 在跑的 Run 现在能不能收下一条消息：在流式输出时要能插话（steer），不在输出时要能续接（send / prompt）。
  function canDeliverToLiveRun(child: NonNullable<ReturnType<ReturnType<typeof liveChildren>["get"]>>): boolean {
    return child.streaming
      ? Boolean(child.handle?.steer || child.rpc)
      : Boolean(child.handle?.send || child.rpc);
  }

  // 消息排队：轮次停在 queued，客户端显示「已排队，Run 结束后转交」。Run 结束时 deliverQueuedTicketMessages 转交。
  function queueTicketMessage(command: {
    message: string; bindingId: number; bindingKind: string; itemId: number; commandId: string;
  }): ChannelTurnRow {
    const turn = createTurn(db, {
      originBindingId: command.bindingId,
      originKind: `paired:${command.bindingKind}:ticket-agent`,
      itemId: command.itemId,
      userText: command.message,
      state: "queued",
    });
    publishControlEvent({
      type: "lead.turn.started",
      requiredScope: "chat",
      audienceBindingId: turn.origin_binding_id ?? undefined,
      turnId: turn.id,
      itemId: command.itemId,
      payload: { messageId: `msg_${turn.id}`, commandId: command.commandId, originKind: turn.origin_kind, mode: "queued" },
    });
    return turn;
  }

  // Run 结束后转交排队的消息：一次转交一条（开一个对话 Run）。这个对话 Run 结束时再转交下一条。
  function deliverQueuedTicketMessages(itemId: number): void {
    if (liveChildren().get(itemId)) return;
    const [turn] = listQueuedTicketTurns(db, itemId);
    if (!turn) return;
    try {
      const routed = routeTicketMessageToAgentRun(schedDeps, { itemId, message: turn.user_text });
      startQueuedTurn(db, turn.id);
      const entry: ActiveChannelTurn = { turn: { ...turn, state: "streaming" }, assistantText: "", sealAt: "run_end", messageText: "" };
      ticketAgentTurns.set(routed.runId, entry);
      publishControlEvent({
        type: "lead.turn.started",
        requiredScope: "chat",
        audienceBindingId: turn.origin_binding_id ?? undefined,
        turnId: turn.id,
        itemId,
        payload: { messageId: `msg_${turn.id}`, commandId: null, originKind: turn.origin_kind, mode: "started" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`queued ticket message undelivered: ${message}`);
      failChannelTurn({ turn, assistantText: "", sealAt: "run_end", messageText: "" }, message);
      handTicketMessageToLead(itemId, turn.user_text, message);
    }
  }

  // 送不到 agent 的工单消息交给 Lead：叫醒它，由它决定怎样回答用户（2026-10-15 方案 A：只有出错时 Lead 才接手）。
  function handTicketMessageToLead(itemId: number, userText: string, reason: string): void {
    const preview = userText.length > 80 ? `${userText.slice(0, 80)}…` : userText;
    addInbox(db, {
      itemId,
      severity: "attention",
      source: "structural",
      summary: `用户在工单 #${itemId} 发给 agent 的消息没送到：「${preview}」。原因：${reason}`,
      payload: { kind: "ticket_message_undelivered", wakeLead: true, needsUser: false, reason },
      lossless: true,
    });
  }

  // textOffset：这次调用开始时这一轮已经说了多少字。客户端据此把工具之间的话放进任务卡，
  // 最后一个工具之后的话作为回复（protocol 的 conversation-tool-calls.ts）。
  function persistLeadToolEvent(entry: ActiveChannelTurn, event: any, textOffset = entry.assistantText.length): void {
    entry.ranTools = true;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      entry.tools ??= new Map();
      entry.tools.set(String(event.toolCallId ?? "unknown"), {
        name: String(event.toolName ?? "unknown"),
        state: event.type === "tool_execution_start" ? "running" : event.isError ? "failed" : "done",
        result: event.type === "tool_execution_end" ? toolResultText(event.result) : "",
      });
    }
    const leadToolTypes: Record<string, "lead.tool.started" | "lead.tool.updated" | "lead.tool.completed" | "lead.tool.failed"> = {
      tool_execution_start: "lead.tool.started",
      tool_execution_update: "lead.tool.updated",
      tool_execution_end: event.isError ? "lead.tool.failed" : "lead.tool.completed",
    };
    const type = leadToolTypes[event.type];
    if (!type) return;
    // 这次调用的流式节流记录用完了（streamRenderUi），不留在内存里。
    if (event.type === "tool_execution_end") streamedSurfaces.delete(event.toolCallId);
    // render_ui 画的卡片（generative UI）：结束之前先发一条带 surface 的 lead.tool.updated。
    // 事件类型表是冻结的，surface 只发给声明了 include=ui_surfaces 的客户端（protocol 的 gatewayEventOptIn）。
    const surface = event.type === "tool_execution_end" && !event.isError && event.toolName === "render_ui"
      ? event.result?.details?.surface
      : undefined;
    if (surface && typeof surface === "object") {
      entry.drewSurface = true;
      persistLeadToolConversationEvent(db, {
        type: "lead.tool.updated",
        audienceBindingId: entry.turn.origin_binding_id ?? undefined,
        turnId: entry.turn.id,
        itemId: entry.turn.item_id ?? undefined,
        payload: { toolCallId: event.toolCallId, toolName: event.toolName, textOffset, surface },
      });
    }
    persistLeadToolConversationEvent(db, {
      type,
      audienceBindingId: entry.turn.origin_binding_id ?? undefined,
      turnId: entry.turn.id,
      itemId: entry.turn.item_id ?? undefined,
      payload: { ...projectToolEvent(event), textOffset },
    });
  }

  // assistant 文本的唯一出口。插话之后 lead 说的第一段话，就是出水口改接生效的地方——
  // 不管这段话是以 delta 到的，还是 message_end 补尾补出来的。
  function routeAssistantText(text: string): void {
    if (!text) return;
    if (pendingSteerSink) {
      handOverToSteer();
    } else if (systemTurnBuffer) {
      systemTurnBuffer.text += text;
      return;
    } else {
      materializeSystemTurn();
    }
    if (activeChannelTurn) publishTurnText(activeChannelTurn, text);
  }

  // 插话接过出水口（会话不报告输入送到的时刻时，在插话之后 Lead 第一次开口时改接）。
  // 还没开口的系统回合不再落成一轮：lead 接下来说的话属于插话那一轮。
  // 攒着的系统回合如果已经说了要告诉用户的话，先把它写出来并收口。
  function handOverToSteer(): void {
    const next = pendingSteerSink!;
    pendingSteerSink = null;
    const index = queuedInputs.findIndex((input) => input.entry === next);
    if (index >= 0) queuedInputs.splice(index, 1);
    handOverTo(next);
  }

  function handOverTo(next: ActiveChannelTurn): void {
    settleSystemTurnBuffer();
    pendingSystemOrigin = null;
    if (activeChannelTurn && activeChannelTurn !== next) closeHandedOver(activeChannelTurn, next);
    activeChannelTurn = next;
  }

  // pi 把一条用户消息送进了模型的上下文（会话的 message_start，role=user；工单 04）。是插话或排队消息时，
  // 从这一刻起 Lead 说的话都是看过它以后说的：出水口改接给它。连着送进来的几条（followUpMode=all，或者几条插话一起送到），
  // 前面的一条没有自己的回答，和后面的一条一起答了。不是交出去的消息（这一轮的 prompt、插进来的系统事件）不用管。
  function onUserInputDelivered(text: string): void {
    const index = queuedInputs.findIndex((input) => input.prompt === text);
    if (index < 0) return;
    const [input] = queuedInputs.splice(index, 1);
    const entry = input!.entry;
    if (input!.kind === "followUp") {
      startQueuedTurn(db, entry.turn.id);
      publishTurnStarted(entry, "started", { placement: "delivered" });
      noteUserTurn(entry.turn.id);
    }
    handOverTo(entry);
  }

  // 把攒着的系统回合落成一轮（还没落成时），按顺序补上攒着的工具调用。
  // 整理笔记也一样（2026-10-17，spec D9）：以前它从不落成，Lead 在里面回答的用户问题就丢了（10-16 19:02 那一问）。
  function materializeBufferedSystemTurn(buffer: NonNullable<typeof systemTurnBuffer>): void {
    if (activeChannelTurn) return;
    materializeSystemTurn();
    if (!activeChannelTurn) return;
    for (const { event, textOffset } of buffer.toolEvents) persistLeadToolEvent(activeChannelTurn, event, textOffset);
    buffer.toolEvents = [];
  }

  // 系统回合收尾（结束、失败、被插话接走）：去掉 NO_REPLY；有话要说时落成一轮并写出文字。
  // force：没有话要说也落成（失败时，会话里要有一张失败卡片）。
  function settleSystemTurnBuffer(options: { force?: boolean } = {}): void {
    const buffer = systemTurnBuffer;
    if (!buffer) return;
    systemTurnBuffer = null;
    const text = stripQuietReply(buffer.text);
    if (text || options.force) materializeBufferedSystemTurn(buffer);
    if (activeChannelTurn && text) publishTurnText(activeChannelTurn, text);
  }

  // 插话的统一入口（paired chat.v2 / v1 paired / aish 共用）。
  // 自带轮次的入口（chat.v2）直接把那条轮次当锚。没有轮次概念的入口只在"插进了一条
  // 别人正看着的轮次"时才现开一条锚——不然改接之后的文本无处可去，只能继续挂在被打断的
  // 那条气泡下面，也就是这个缺陷本身。
  function steerLead(
    prompt: string,
    origin: ChannelTurnRow | { originKind: string; userText: string },
    commandId?: string,
  ): Promise<void> {
    const anchor = "id" in origin
      ? origin
      : activeChannelTurn || pendingSteerSink || pendingSystemOrigin
        ? createTurn(db, { originKind: origin.originKind, userText: origin.userText, state: "queued" })
        : null;
    // 受理的插话就是用户回了话：取消预算按新的一轮算。没受理（steer 失败）的不算。
    // pi 1.x 的 steer 会返回 disposition（handled/queued），调用方只关心成败，这里丢弃。
    if (!anchor) return session.steer(prompt).then(() => { noteUserTurn(); });
    // 用户这一轮带的图片跟着插话一起交给 pi。
    const images = leadTurnImages(anchor.id);
    const sink: ActiveChannelTurn = {
      turn: anchor, assistantText: "", placement: "steer",
      ...(commandId === undefined ? {} : { commandId }),
    };
    // 会话报告输入送到的时刻：插话送到时才改接出水口（onUserInputDelivered）。不报告时，Lead 在插话之后第一次开口时改接。
    if (!inputDeliveryEvents) pendingSteerSink = sink;
    queuedInputs.push({ prompt, entry: sink, kind: "steer" });
    const dropQueued = () => {
      const index = queuedInputs.findIndex((input) => input.entry === sink);
      if (index >= 0) queuedInputs.splice(index, 1);
    };
    publishTurnStarted(sink, "steered", { placement: "steered" });
    return (images.length ? session.steer(prompt, images) : session.steer(prompt)).then(
      () => {
        noteUserTurn(anchor.id);
        // 那一轮已经失败，插话这时才被 pi 收下：它躺在 pi 的队列里（发布评审 f796c1c 的 B2）。
        //   · Lead 空着：清掉它，由那一次自动重试或「重发」送，下一次 prompt 不再送一次；
        //   · Lead 正在跑另一轮：那一轮会收下它，回答出现在那一轮里，这一轮不再重试，算插话。
        const row = db.prepare("SELECT state, error FROM channel_turns WHERE id = ?").get(anchor.id) as
          { state: string; error: string | null } | undefined;
        if (row && (row.state === "failed" || (row.state === "queued" && row.error !== null))) {
          if (!busy) {
            dropQueued();
            session.clearQueue?.();
          } else if (row.state === "failed") {
            dropQueued();
          } else if (inputDeliveryEvents) {
            // 送到正在跑的那一轮时，出水口改接给它；结局在那一轮结束时定。
            markTurnInserted(db, anchor.id);
            userTurnRetries.delete(anchor.id);
            publishTurnStarted(sink, "steered", { placement: "steered" });
          } else if (settleRetryAsSteered(db, anchor.id)) {
            dropQueued();
            userTurnRetries.delete(anchor.id);
            userTurnPrompts.delete(anchor.id);
            publishTurnStarted(sink, "steered");
          }
          return;
        }
        // 已经接上水的轮次不能再被打回 steered——它有自己的文本，终态由 sealChannelTurn 给。
        // 插话还在路上：轮次停在 steered，结局在这一轮结束时定（markTurnInserted 不记处置）。
        if (activeChannelTurn !== sink) markTurnInserted(db, anchor.id);
      },
      (err: any) => {
        if (pendingSteerSink === sink) pendingSteerSink = null;
        dropQueued();
        failTurn(db, anchor.id, err.message);
        throw err;
      },
    );
  }

  // 正在跑的这一轮带着外部内容时，用户的消息等它结束后单独开一轮（lead-tools-and-routing spec D16）：
  // 存进 carryOverTurns，这一轮结束时 dispatchLeadWork 先开它。界面显示「排队」。
  function holdForOwnTurn(prompt: string, entry: ActiveChannelTurn): void {
    publishTurnStarted(entry, "queued", { placement: "queued" });
    carryOverTurns.push({ prompt, entry });
    log(`user message ${entry.turn.id} waits for its own turn: the running turn read external content`);
  }

  // 用户选「排队」、Lead 正在忙（工单 04，spec D6）：交给 pi 的 followUp。Lead 答完这一轮（插话也处理完）以后，
  // pi 把排着的几条一起送进去（followUpMode=all），开下一轮；它们排在系统事件前面（系统事件等这次运行结束才单独开一轮）。
  // 会话不报告输入送到的时刻时（只有测试里的替身会这样），不交给 pi：daemon 自己在这次运行结束后开下一轮答它。
  function queueLeadFollowUp(prompt: string, turn: ChannelTurnRow, commandId: string): void {
    const entry: ActiveChannelTurn = { turn, assistantText: "", commandId, placement: "followUp" };
    publishTurnStarted(entry, "queued", { placement: "queued" });
    if (!inputDeliveryEvents) {
      carryOverTurns.push({ prompt, entry });
      return;
    }
    // pi 答完这一轮以后开新的一轮，把排着的几条一起送进去：那一轮的开头也要有一份当前局面（spec D7）。
    // 交给 pi 的原文定了就不能改，所以在第一条排队消息的开头放这时的当前局面；同一批后面的几条不再放。
    const first = !queuedInputs.some((input) => input.kind === "followUp");
    const situation = first ? situationBlock() : "";
    const piPrompt = situation ? `${situation}\n\n${prompt}` : prompt;
    queuedInputs.push({ prompt: piPrompt, userPrompt: prompt, entry, kind: "followUp" });
    const images = leadTurnImages(turn.id);
    (images.length ? session.followUp(piPrompt, images) : session.followUp(piPrompt)).catch((err: any) => {
      const index = queuedInputs.findIndex((input) => input.entry === entry);
      if (index < 0) return;
      queuedInputs.splice(index, 1);
      log(`follow-up rejected: ${err?.message ?? String(err)}; answering it in the next turn`);
      carryOverTurns.push({ prompt, entry });
      setImmediate(dispatchLeadWork);
    });
  }

  // ── 排着的追问：插进这一轮、不再发给 Lead（用户 2026-10-28，protocol 的 lead-follow-ups.ts）──────────────────
  // 状态栏的「Steer」和「×」、Lead 的 perform_action 都经过操作层的 follow_up 调到这里（uiActionServices.followUps）。
  // 排着的追问在两个地方：
  //   · pi 的 followUp 队列（queuedInputs 里 kind=followUp 的）：能插进这一轮，也能取消；
  //   · 等这一轮结束后单独开一轮的（carryOverTurns：这一轮读过外部内容，或者上一轮没赶上的）：只能取消，插不进这一轮。
  // 「现在能不能做」由操作层的 available 判断（看快照里的 heldForOwnTurn）；执行时这里再核对一次，
  // 这期间它交给了 Lead 就报错，不做半个操作。

  type QueuedInput = (typeof queuedInputs)[number];

  // 等单独开一轮的追问为什么插不进正在跑的这一轮（快照里的 heldReason）。
  function heldFollowUpReason(): string {
    return runOrigin.external ? "这一轮读过外部内容，这条要单独开一轮" : "这条排在下一轮单独回答，插不进正在跑的这一轮";
  }

  function followUpSnapshot(): FollowUpEntry[] {
    const entryOf = (entry: ActiveChannelTurn, held: boolean): FollowUpEntry => ({
      turnId: entry.turn.id, text: entry.turn.user_text, at: entry.turn.created_at, heldForOwnTurn: held,
      ...(held ? { heldReason: heldFollowUpReason() } : {}),
    });
    return [
      ...queuedInputs.filter((input) => input.kind === "followUp").map((input) => entryOf(input.entry, false)),
      ...carryOverTurns.map((carried) => entryOf(carried.entry, true)),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }

  // 在 pi 队列里排着的那一条追问。不在时报错：等单独开一轮的插不进这一轮，别的已经交给了 Lead（或者不存在）。
  function piQueuedFollowUp(turnId: string): QueuedInput {
    const target = queuedInputs.find((input) => input.kind === "followUp" && input.entry.turn.id === turnId);
    if (target) return target;
    if (carryOverTurns.some((carried) => carried.entry.turn.id === turnId)) {
      throw new UiActionError("unavailable", `${heldFollowUpReason()}。`);
    }
    throw new UiActionError("not_found", `排着的追问 ${turnId} 不在了：它已经交给 ${leadDisplayName(db)}，或者不存在`);
  }

  // pi 没有「只取出一条」的接口：把它的队列整个取出来（clearQueue），按原来的先后放回去，只拿掉 drop 这一条。
  //   · 插话照旧插话，排队照旧排队。clearQueue 只还回文字：用户的消息带的图片按轮次从库里取（leadTurnImages），一起放回去；
  //   · 不是用户消息的原文（插进来的系统事件、超预算提醒、排队说明）照原样放回去；
  //   · drop 是这一批排队消息的第一条时，它的开头带着当前局面（queueLeadFollowUp）：挪到下一条排队消息的开头，
  //     那一轮开头照旧有一份当前局面。后面没有排队消息时这份当前局面就没有了：可以接受，下一轮是 daemon 自己开的，
  //     开头另有一份；插话进这一轮的那一条不带它（这一轮开头已经有了）。
  // 取出和放回的调用同步发出，中间不让出事件循环：pi 取不到半个队列。drop 不在 pi 的队列里（已经送到了）时一条都不拿掉，
  // found 是 false。drop 拿掉以后也从 queuedInputs 里拿掉。done 在放回的调用都结束时完成；放回失败（几乎不会）时，
  // 用户的消息转为下一轮单独回答，插进来的系统事件交回游标（和 takeLeftoverInputs 一样）。
  function requeueWithout(drop: QueuedInput): { found: boolean; done: Promise<void> } {
    const cleared = session.clearQueue!();
    const used = new Set<QueuedInput>();
    const recordOf = (text: string, kind: QueuedInput["kind"]): QueuedInput | undefined => {
      const record = queuedInputs.find((input) => input.kind === kind && !used.has(input) && input.prompt === text);
      if (record) used.add(record);
      return record;
    };
    const steering = cleared.steering.map((text) => ({ text, record: recordOf(text, "steer") }));
    const followUp = cleared.followUp.map((text) => ({ text, record: recordOf(text, "followUp") }));
    const found = used.has(drop);
    if (found) {
      const situation = drop.userPrompt && drop.prompt !== drop.userPrompt && drop.prompt.endsWith(drop.userPrompt)
        ? drop.prompt.slice(0, drop.prompt.length - drop.userPrompt.length)
        : "";
      const next = situation
        ? followUp.find((item) => item.record && item.record !== drop && item.record.prompt === (item.record.userPrompt ?? item.record.prompt))
        : undefined;
      if (next) {
        next.record!.prompt = `${situation}${next.record!.prompt}`;
        next.text = next.record!.prompt;
      }
      queuedInputs.splice(queuedInputs.indexOf(drop), 1);
    }
    const pending: Array<Promise<unknown>> = [];
    const putBack = (kind: "steer" | "followUp", text: string, record: QueuedInput | undefined) => {
      const images = record ? leadTurnImages(record.entry.turn.id) : [];
      const call = kind === "steer"
        ? (images.length ? session.steer(text, images) : session.steer(text))
        : (images.length ? session.followUp(text, images) : session.followUp(text));
      pending.push(Promise.resolve(call).catch((err: any) => requeueFailed(text, record, err)));
    };
    for (const item of steering) putBack("steer", item.text, item.record);
    for (const item of followUp) if (!found || item.record !== drop) putBack("followUp", item.text, item.record);
    return { found, done: Promise.all(pending).then(() => {}) };
  }

  function requeueFailed(text: string, record: QueuedInput | undefined, err: any): void {
    log(`putting a queued input back failed: ${err?.message ?? String(err)}`);
    if (!record) {
      const seqs = steeredEvents.get(text);
      if (seqs) {
        steeredEvents.delete(text);
        leadInput.release(seqs);
      }
      return;
    }
    const index = queuedInputs.indexOf(record);
    if (index < 0) return;
    queuedInputs.splice(index, 1);
    if (record.kind === "steer" && !record.nextTurn) publishTurnStarted(record.entry, "steered", { placement: "next_turn" });
    carryOverTurns.push({ prompt: record.userPrompt ?? record.prompt, entry: record.entry });
    setImmediate(dispatchLeadWork);
  }

  // 插进这一轮：和用户发送时选「插话」走同一条路（steerLead），placement 变成 steered，Lead 接下来说的话长在它下面。
  async function steerFollowUp(turnId: string): Promise<FollowUpActionResult> {
    const target = piQueuedFollowUp(turnId);
    if (!busy) throw new UiActionError("unavailable", `${leadDisplayName(db)} 已经答完这一轮了，这条马上就交给它`);
    if (!session.clearQueue) throw new UiActionError("unavailable", "这个 Lead 会话不能改排队");
    const { found, done } = requeueWithout(target);
    if (!found) {
      await done;
      throw new UiActionError("unavailable", `这条已经交给 ${leadDisplayName(db)} 了`);
    }
    const steered = steerLead(target.userPrompt ?? target.prompt, target.entry.turn, target.entry.commandId);
    await done;
    await steered;
    log(`follow-up ${turnId} steered into the running turn`);
    return { turnId, placement: "steered" };
  }

  // 不再发给 Lead：从 pi 的队列或者 carryOverTurns 里拿掉。用户的话照旧留在会话里，这一轮不再被回答，没有失败卡。
  async function cancelFollowUp(turnId: string, by: string): Promise<FollowUpActionResult> {
    const held = carryOverTurns.findIndex((carried) => carried.entry.turn.id === turnId);
    if (held >= 0) {
      const [carried] = carryOverTurns.splice(held, 1);
      settleCancelledFollowUp(carried!.entry, by);
      return { turnId, placement: "cancelled" };
    }
    const target = piQueuedFollowUp(turnId);
    if (!session.clearQueue) throw new UiActionError("unavailable", "这个 Lead 会话不能改排队");
    const { found, done } = requeueWithout(target);
    if (found) settleCancelledFollowUp(target.entry, by);
    await done;
    if (!found) throw new UiActionError("unavailable", `这条已经交给 ${leadDisplayName(db)} 了，取消不了`);
    return { turnId, placement: "cancelled" };
  }

  // 取消的结局（store 的 settleTurnCancelled）：轮次停在 steered，user.message 的结局是 cancelled。不是失败，也不再等。
  // 和别的放置变化一样发 lead.turn.started（placement=cancelled），客户端据此更新。
  function settleCancelledFollowUp(entry: ActiveChannelTurn, by: string): void {
    settleTurnCancelled(db, entry.turn.id, { by });
    userTurnPrompts.delete(entry.turn.id);
    retriedUserTurns.delete(entry.turn.id);
    userTurnRetries.delete(entry.turn.id);
    publishTurnStarted(entry, "steered", { placement: "cancelled" });
    log(`follow-up ${entry.turn.id} cancelled: Lead will not answer it`);
  }

  const notifyDesktop = opts.notifyDesktop ?? defaultDesktopNotifier();

  let aishNotify: (text: string) => void = () => {}; // adapter 就绪后重绑
  // child 完成回调（lead spawn + scheduler 自动派发共用）。
  const onChildDone = (itemId: number, err?: Error) => {
    endStaleTicketAgentTurns(itemId, err);
    // 排队的工单消息先转交，再让调度器接着派活：对话 Run 回答完，排着的执行才继续。
    deliverQueuedTicketMessages(itemId);
    const t = getItem(db, itemId);
    // 完成也先让 Lead 知道（2026-10-15 用户决定，Jarvis 模式）：马上叫醒 Lead，由它决定要不要、怎样告诉用户
    // （run-finished.ts）。通常 onChildEvent 在 Run 结束时已经说过，这里不重复；没有终止事件就结束的 Run 靠这里。
    // 系统不再把每次完成直接推到 Slack 和本机客户端。工单对话的回答不叫醒 Lead：
    // 它的 Run 结束、stage 变化都是事件日志里的 record 级事件，写在 Lead 下一轮的当前局面里（工单 04，
    // 取代以前内存里的 childNotices：重启就丢）。
    recordRunFinished(db, { itemId, ...(err ? { error: err } : {}) });
    publishControlEvent({
      // 线上 payload 的键叫 status，值取内部的 item.stage。
      type: "ticket.updated", requiredScope: "tickets:view", itemId,
      payload: { status: t?.stage ?? null, childError: err?.message ?? null, snapshotRequired: true },
    });
    setImmediate(tickOrchestrator);
  };

  // 工单 agent 正在回答某一轮时，它调的工具（Bash、Read 等）属于这一轮：child.tool.* 事件带上这一轮的
  // turnId 和 textOffset，工单对话里这一轮的任务卡据此列出这些工具。事件名和 scope 不变。
  function attachTicketAgentTurn(runId: number, projected: PublishGatewayEventInput): PublishGatewayEventInput {
    if (!projected.type.startsWith("child.tool.")) return projected;
    const entry = ticketAgentTurns.get(runId);
    if (!entry) return projected;
    return {
      ...projected,
      turnId: entry.turn.id,
      payload: { ...projected.payload, textOffset: entry.assistantText.length },
    };
  }

  // 模型目录自动刷新（model-catalog-watch.ts）。注入了自己的 Lead 会话的测试不去问真实的 CLI，除非显式打开 modelDiscovery。
  const catalogWatch = (opts.modelDiscovery ?? !opts.sessionFactory)
    ? startModelCatalogWatch({
      db, cwd: projectRoot(), log,
      intervalMs: Number(process.env.PLC_MODEL_CATALOG_REFRESH_MS ?? DEFAULT_MODEL_CATALOG_REFRESH_MS),
    })
    : null;

  const onChildEvent: NonNullable<LeadDeps["onChildEvent"]> = (itemId, runId, event) => {
    if (catalogWatch) void catalogWatch.onRunEvent(event);
    projectTicketAgentEvent(itemId, runId, event);
    const projected = childRuntimeControlEvent(itemId, runId, event);
    if (projected) publishControlEvent(attachTicketAgentTurn(runId, projected));
    // Run 一处理完终止事件就告诉 Lead（2026-10-19）：pi 的执行 Run 交付以后进程还要停留 5 分钟，
    // 等进程退出（onChildDone）再说，Lead 就晚 5 分钟知道。onChildDone 照样调用，同一个 Run 只说一次。
    // 只有交付后会停留的 Run（执行 Run）在这一刻说；核查、合并的结论在进程退出时才登记，那时（onChildDone）再说（2026-10-19 审查）。
    if (event.type === "run.completed" || event.type === "run.failed") recordRunFinishedAtTerminalEvent(db, { itemId, runId });
  };

  // Lead 的 list_needs_user 读网关投给 App 的同一份工单摘要。控制面在后面才建好，所以这里先留一个入口。
  let listTicketSummaries: (() => TicketSummary[]) | null = null;
  // get_ticket_status 读单张工单的同一份摘要（工单 03）。工单对话续接执行 agent 的会话时，它也放在 agent 输入的开头（工单 08）。
  let ticketSummaryOf: ((id: number) => TicketSummary | undefined) | null = null;

  // spawn 依赖包（scheduler 自动派发 + 孤儿自动重派共用；定义在 onChildDone 之后以便复用回调）
  const runtimeRegistry = opts.runtimeRegistry ?? createDefaultRuntimeRegistry();
  const schedDeps: LeadDeps = {
    db, dbPath: opts.dbPath, dataDir: opts.dataDir,
    childPi: opts.childPi, onChildDone, onChildEvent, runtimeRegistry,
    // 控制面建好以前没有工单摘要：那时开的对话 Run 不带它。
    ticketSummary: (id) => ticketSummaryOf?.(id),
  };
  // 用户控制面（spec §6.4/§8）。companion 和 plc 都经过 paired 网关用这个实例——
  // 入口必须落在同一个进程里，因为"暂停"要杀的是**这个** daemon 持有的子进程。
  // 绕过 daemon 直接改库，DB 会说 paused 而进程还在烧 token，那正是要避免的谎。
  // 权限清单里的本地仓库：按候选仓库把名字解析成根目录（派单器和工单动作「放宽权限」都用它）。候选仓库在下面建好以后接上。
  let resolveGrantLocalRepo: (name: string) => GrantLocalRepo | null = () => null;
  const userActions = createUserActionService({
    db,
    resolveLocalRepo: (name) => resolveGrantLocalRepo(name),
    // 拉不起来时把错误交回恢复控制：它把 Run 留在 paused，网关把原因交给用户。
    resumeRun: ({ itemId, runId, sessionId }) => {
      try { resumeItemChild(schedDeps, { itemId, runId, sessionId }); }
      catch (e: any) { log(`[resume] run #${runId} failed: ${e.message}`); throw e; }
      reattachPausedTicketTurn(itemId, runId);
    },
    // 页面的「开始执行」和 Lead 的 spawn_child（执行者）都经过工单操作 start 调它（ui-action-parity P03）。
    startRun: (itemId, options) => spawnItemChild(schedDeps, itemId, { ...options }),
    // 手动派发的独立核查与 orchestrator 的自动核查用同一个 reviewer runtime。
    ...(opts.childPi ? { reviewerRuntime: LOCAL_RUNTIME_ID } : {}),
    // 核查员能不能用，按派发 gate 的同一个 profile 查。
    runtimeProfile: (runtime) => childRuntimeProfile(schedDeps, runtime),
    // 停用的执行器是谁停用的（工单 11 审查第 1 条）：Lead 自己停用的不算「核查做不成」，D11 的托管验收不因此生效。
    // 读不出 config.json 时按 Lead 停用的算（复核第 1 条）。
    runtimeDisabledBy: (runtime) => runtimeSettings.disabledByForDelegation(runtime),
    // 打开交付里的文件（工单 07）：macOS 上执行 /usr/bin/open，页面和 Lead 用同一个。PLC_OPEN_FILES=off（测试）时一律拒绝。
    openFile: opts.fileOpener ?? daemonFileOpener(),
  });
  // 确认卡放行 Lead 被拦下的工单操作（兜底授权卡，2026-10-29）：和页面上的工单操作用同一个宿主。
  uiActionServices.ticketActions = { host: userActions.host };
  // daemon 重启后接管 child（spec D7，工单 15）。先清理启动目录，再核对每个垫片（异步，只读），
  // 然后按结果接管或交给孤儿回收。接管开始之后到启动修复结束之间没有 await，
  // 所以接管的事件处理不会和启动修复交错。
  retainChildrenOnHostExit();
  acceptRunningChildren();
  const launchRoot = join(opts.dataDir, "launches");
  const launchSweep = await sweepLaunchDirectories(db, { dataDir: opts.dataDir });
  if (launchSweep.removed || launchSweep.stopped) {
    log(`launch sweep: removed=${launchSweep.removed} stopped=${launchSweep.stopped}`);
  }
  // 上一个 daemon 在记下垫片的身份之前被杀掉时，这个垫片的 CLI 还在运行。先停止它，再回收和重派它的 Run，
  // 否则同一张工单上有两个 CLI。
  const untracked = await stopUntrackedLaunchers(db, { launchRoot });
  if (untracked) log(`stopped ${untracked} launcher(s) that no run had recorded`);
  // 通道派给子 agent 的工单（agent-tasks.ts）是上一个 daemon 进程里的会话，不能接管：记成失败、工单收进 cancelled，
  // 结果在派单器建好以后交回发起方。剩下的 purpose=lookup 的工单和 Run（例如退役以前的代查）收尾（lookup.ts）；
  // 它们的卡由 hub 的第一拍记成失败（代查退役，落地计划 D1）。
  const reclaimedAgentTasks = recoverAgentTasksAfterRestart(db);
  const reclaimedLookups = recoverLookupsAfterRestart(db);
  if (reclaimedLookups.length) log(`[lookup] closed ${reclaimedLookups.length} lookup(s) left by the previous daemon`);
  const restartCandidates = await planRestartRecovery(db, { launchRoot });
  const budget = crashLoopBudget();
  const restartAt = new Date();
  const restart = applyRestartRecovery(db, restartCandidates, {
    budget,
    now: restartAt,
    canAdopt: (runtime) => childRuntimeAdapter(schedDeps, runtime).attach !== undefined,
    adopt: (run, launch) => adoptRunChild(schedDeps, { run, launch }),
    log,
  });
  if (restart.adopted || restart.crashLooped) {
    log(`restart adoption: adopted=${restart.adopted} crashLooped=${restart.crashLooped}`);
  }
  // 接管不了的 Run 走孤儿回收（spec §C1）：孤儿如实标 crash；首次自动重派续做（redispatch 失败/二次孤儿回落 blocker）。
  // 和接管用同一个时间，所以接管失败后改走孤儿回收的 Run 不会被扣两次额度。
  const reclaimed = restart.reclaim.size ? recoverOrphans(db, {
    runIds: restart.reclaim,
    budget,
    now: restartAt,
    redispatch: (itemId) => {
      try { spawnItemChild(schedDeps, itemId, {}); return true; }
      catch (e: any) { log(`[recover] redispatch #${itemId} failed: ${e.message}`); return false; }
    },
  }) : 0;
  if (reclaimed) log(`recovered ${reclaimed} orphaned run(s)`);
  const retryRepairs = repairNonBudgetRetryExhaustion(db);
  if (retryRepairs) log(`repaired ${retryRepairs} non-budget retry exhaustion state(s)`);
  const stoppedRunRepairs = repairStoppedRunCrashCheckpoints(db);
  if (stoppedRunRepairs) log(`repaired ${stoppedRunRepairs} false stopped-run crash checkpoint(s)`);
  const workspaceRepair = reconcileWorkspaces(db);
  // 交付后自动开草稿 PR（用户 2026-10-26）：只管这个时间以后的交付，以前交付的工单不会一下子都开出 PR。
  markAutoPullRequestRollout(db);
  if (workspaceRepair.recovered || workspaceRepair.failed) {
    log(`workspace reconcile: checked=${workspaceRepair.checked} recovered=${workspaceRepair.recovered} failed=${workspaceRepair.failed}`);
  }
  const startupRepair = repairDaemonStartupState(db);
  if (startupRepair.approvals || startupRepair.decisions || startupRepair.runStarts
      || startupRepair.reregistered || startupRepair.reregistrationErrors
      || startupRepair.outcomes || startupRepair.handoffs) {
    log(
      `startup repair: approvals=${startupRepair.approvals} decisions=${startupRepair.decisions} `
      + `runStarts=${startupRepair.runStarts} reregistered=${startupRepair.reregistered} `
      + `reregistrationErrors=${startupRepair.reregistrationErrors} `
      + `outcomes=${startupRepair.outcomes} handoffs=${startupRepair.handoffs}`,
    );
  }
  const repairedBlockers = repairMissingBlockerAlerts(db);
  if (repairedBlockers) log(`startup repair: restored ${repairedBlockers} missing blocker alert(s)`);
  // 卡在 started 的工具卡片：用它们自己那条终局事件结算掉（见 repairStuckLeadToolOperations
  // 的规则说明）。幂等，所以每次启动都跑，而不是做成一次性迁移。
  const cardRepair = repairStuckLeadToolOperations(db);
  if (cardRepair.operations) {
    log(`startup repair: settled ${cardRepair.operations} stuck tool operation(s) on ${cardRepair.cards} card(s)`);
  }
  const emptyTurnRepair = repairEmptyCompletedTurns(db);
  if (emptyTurnRepair) {
    log(`startup repair: marked ${emptyTurnRepair} empty completed turn(s) as failed`);
  }
  const quietTurns = restoreQuietSystemTurns(db);
  if (quietTurns) log(`startup repair: restored ${quietTurns} quiet Lead-initiated turn(s) to completed`);

  const coordinator = createCoordinator({ db });

  // 模型目录（engine 的 model-catalog.ts，2026-10-15）：问各 CLI 自己接受哪些模型和 effort。Lead 的工具描述在会话
  // 建立时生成，所以先等第一次刷新，最多等 5 秒；超时就先用 kv 里上一次的目录，刷新在后台完成。
  // 这一次不给 Lead 写「目录有变化」：工具描述马上按新目录生成。
  if (catalogWatch) {
    await Promise.race([
      catalogWatch.refresh("daemon 启动", { announce: false }),
      new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
    ]);
  }

  // Lead 的笔记记忆：选了 Hindsight 时它是主后端，notes 是镜像（.scratch/hindsight-primary-memory/spec.md）。
  // 后端由 MemoryController 在下面接上，笔记定时写过去并跟踪任务；写入失败时告诉 Lead（一次故障一条）。
  const memory = new NotesMemory(db, null, {
    log,
    onWriteFailed: (status) => {
      addInbox(db, {
        dedupScope: "memory-write-failed", severity: "attention", source: "structural",
        summary: `记忆写入失败：${status.failed} 条笔记没写进 Hindsight（最近的原因：${status.lastError ?? "不明"}）。`
          + "这些笔记现在按意思召回不到，search_notes 会写明。常见原因是摘要模型的 key 或服务不可用（设置 → 记忆）。"
          + "原因修好以后，用 perform_action 的 memory_settings / memory / retry_failed_writes 重试，或者请用户在设置页点「重试失败的写入」。告诉用户。",
        payload: { kind: "memory_write_failed", failed: status.failed, wakeLead: true, needsUser: false },
      });
    },
  });
  // 常驻偏好的改、删、撤销（操作层的 core_memory、core_memory_change）也经过这个 NotesMemory：写 notes，再交给 Hindsight。
  uiActionServices.notesMemory = memory;
  const stopMemorySync = opts.manageMemory ? memory.startPeriodicSync() : () => {};
  // 连接（设置页的「连接」）：daemon 是唯一的 OAuth 客户端和远程 MCP 客户端。
  // daemon 自己的密钥（预注册客户端的 client secret）先从环境里取走再删掉：child 继承 daemon 的全部环境。
  const daemonOnlySecrets = new Map<string, string>();
  for (const name of DAEMON_ONLY_ENV_NAMES) {
    const value = process.env[name];
    if (value) daemonOnlySecrets.set(name, value);
    delete process.env[name];
  }
  const testDaemon = opts.sessionFactory !== undefined;
  let connectionsGatewayPort = 0;
  // 保险库：连接的令牌和记忆的密钥都用它加密（packages/connections 的 vault）。hindsight-main 用同一个密钥。
  const vault = lazyVault(opts.connections?.keySource
    ?? (testDaemon ? fileKeySource(join(opts.dataDir, "connections.key")) : defaultKeySource(join(opts.dataDir, "connections.key"))));
  const connections = new ConnectionHub({
    db,
    vault,
    config: loadConnectionsConfig(opts.dataDir),
    redirectUri: () => `http://127.0.0.1:${connectionsGatewayPort}/oauth/callback`,
    ...(opts.relaxConnectionWrites ? { newConnectionWritePolicy: "direct" as const } : {}),
    ...(opts.connections?.fetch ? { fetch: opts.connections.fetch } : {}),
    secrets: { get: (name) => daemonOnlySecrets.get(name) ?? (testDaemon ? null : readKeychainSecret(name)) },
    gh: opts.connections?.gh ?? (testDaemon ? { token: async () => null } : ghCliTokenSource()),
    ...(testDaemon && !opts.connections?.gh ? { ghInstalled: () => false } : {}),
    log,
    // 本地仓库的读取（带清单的 Run）不能碰助手自己的数据目录。
    localDeniedRoots: [opts.dataDir],
    // 子 agent 经连接中心的写操作记进动作层（agent-writes.ts）：别人看得到的推给你，能撤销。
    onAgentWrite: (write) => {
      recordAgentWrite(db, write);
      publishControlEvent({ type: "ticket.updated", requiredScope: "tickets:view", itemId: write.itemId, payload: { ticketId: write.itemId, snapshotRequired: true } });
    },
    onChange: () => {
      publishControlEvent({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: "connections" } });
    },
    // 一次写入确认有了结果：交给 Lead，由它告诉用户。每个确认一行，不合并。
    // 过期（用户没有回答）只记一条 user_request.expired（record 级）：在等这次确认的 Lead 由它的等待叫醒（lead-waits.ts）。
    onConfirmation: ({ confirmation, resultText }) => {
      const what = `${confirmation.label} 的 ${confirmation.tool}（${confirmation.summary}）`;
      if (confirmation.state === "expired") {
        recordUserRequestExpired(db, {
          entityKey: `connection_confirmation:${confirmation.id}`, requestKind: "connection_confirmation", requestId: confirmation.id,
          summary: `写入确认过期了，用户没有回答：${what}。这次写入没有执行。`,
        });
        return;
      }
      const summary = confirmation.state === "rejected"
        ? `用户拒绝了写入：${what}。不要再执行它。`
        : confirmation.state === "done"
        ? `用户允许了写入，已经执行：${what}。结果：${(resultText ?? "").slice(0, 2_000)}`
        : `用户允许了写入，但执行失败：${what}。原因：${confirmation.resultPreview ?? "未知"}`;
      addInbox(db, {
        // 对象键和网关记主人操作用的一样（connection_confirmation:<id>）：Lead 在等这次确认时，等待按它认出这一条已经叫醒了 Lead（lead-waits.ts）。
        dedupScope: `connection_confirmation:${confirmation.id}`, severity: "attention", source: "structural", lossless: true,
        summary,
        payload: { kind: "connection_confirmation", confirmation: confirmation.id, state: confirmation.state, wakeLead: true, needsUser: false },
      });
    },
    // 权限设置被绕过设置页改了（2026-10-19 审查）。hub 已经恢复成更严的值；这里记一条安全报警，
    // 下面 owner-actions 那一步直接推给用户，不经过 Lead：改动可能就是一个 child 做的。
    onSettingsAlert: (alert) => {
      const text = connectionSettingsTamperAlertText(alert);
      try {
        recordSecurityAlert(db, {
          kind: CONNECTION_SETTINGS_TAMPERED_KIND,
          entityKey: `connection:${alert.key}`,
          title: text.title,
          body: text.body,
          rootCause: {
            code: "connection_settings_tampered",
            scope: "connection",
            evidence: `封印 ${alert.seal}；账本里是「${describeConnectionSettings(alert.found)}」，记录的是「${describeConnectionSettings(alert.expected)}」`,
            next_step: "查是哪个进程直接改了 plc.db；需要放开时在设置 → 连接里改",
          },
          payload: {
            connection: { id: alert.connectionId, key: alert.key, label: alert.label },
            expected: alert.expected, found: alert.found, restored: alert.restored, seal: alert.seal,
          },
        });
      } catch (error) {
        log(`[connections] ${alert.key}: security alert not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    // Jarvis 模式：要告诉你的事先交给 Lead（connection-attention.ts：说明带着要用户做的事，授权失效时登记等待）。
    onAttention: (event) => recordConnectionAttention(db, event, log),
  });
  if (opts.relaxConnectionWrites) {
    const relaxed = connections.relaxWritePolicyOnce();
    if (relaxed.length) log(`[connections] switched to direct writes: ${relaxed.join(", ")}`);
  }

  const lookupCandidatesOverride = opts.lookups?.candidates;
  // 请求 A 的候选仓库：project_repositories 加配置的根目录下的 git 仓库（lead 的 listLookupCandidates）。扫目录要读盘，缓存 5 分钟。
  // 测试 daemon 不扫用户的 ~/Workspace。
  const plcConfig = (() => {
    try {
      return loadPlcConfig(opts.dataDir);
    } catch (error) {
      log(`config.json not read for channels: ${error instanceof Error ? error.message : String(error)}`);
      return {} as ReturnType<typeof loadPlcConfig>;
    }
  })();
  // 配置文件里 Slack 署名的 emoji（channels.slack.assistantEmoji，Lead 的形象，2026-10-28）。没配时 undefined。
  // 设置 → 身份与风格 → 形象的值压过它（engine 的 effectiveSlackBylineEmoji）。
  const configSlackEmoji = (): string | undefined => {
    const value = plcConfig.channels?.slack?.assistantEmoji;
    return typeof value === "string" ? value : undefined;
  };
  // 署名里的助手名：配置的 channels.assistantName，没有时是 Lead 的名字（设置 → 身份与风格；用户 2026-10-22）。
  const channelAssistantName = () => (typeof plcConfig.channels?.assistantName === "string" ? plcConfig.channels.assistantName.trim() : "")
    || leadDisplayName(db);
  const lookupRoots = plcConfig.channels?.lookup?.localRoots?.filter((root) => typeof root === "string" && root.trim().length > 0);
  let candidateCache: { at: number; value: readonly ChannelLookupCandidate[] } | null = null;
  const lookupCandidates = lookupCandidatesOverride ?? ((): readonly ChannelLookupCandidate[] => {
    if (candidateCache && Date.now() - candidateCache.at < 5 * 60_000) return candidateCache.value;
    const value = listLookupCandidates({ db, roots: testDaemon ? [] : lookupRoots ?? DEFAULT_LOOKUP_ROOTS() })
      .map(({ repo, root, github }) => ({ repo, root, github }));
    candidateCache = { at: Date.now(), value };
    return value;
  });
  resolveGrantLocalRepo = (name) => {
    const wanted = name.trim().toLowerCase();
    const found = lookupCandidates().find((candidate) => candidate.repo.toLowerCase() === wanted || basename(candidate.root).toLowerCase() === wanted);
    return found ? { name: found.repo, root: found.root, ...(found.github ? { github: `${found.github.owner}/${found.github.repo}` } : {}) } : null;
  };
  // 派单器（landing.md C1）：通道派给子 agent 的工单。结果交给发起方登记的回调（通道），不叫醒 Lead。
  const agentTasks = createAgentTaskDispatcher({
    db, dbPath: opts.dbPath, dataDir: opts.dataDir, connections, log,
    resolveLocalRepo: (name) => resolveGrantLocalRepo(name),
    ownerName: () => plcConfig.channels?.ownerName?.trim() || null,
    onEvent: (itemId, runId, event) => onChildEvent(itemId, runId, event),
    onSettled: (itemId) => publishControlEvent({
      type: "ticket.updated", requiredScope: "tickets:view", itemId,
      payload: { status: getItem(db, itemId)?.stage ?? null, childError: null, snapshotRequired: true },
    }),
    ...opts.agentTasks,
  });
  // config.json 被 daemon 以外的进程改了（config-watch.ts，2026-10-19 审查）：记一条安全报警，下面 owner-actions 那一步直接推。
  const configWatch = createConfigWatch(envConfigPath(opts.dataDir), ({ hash, changed }) => {
    const text = configChangedAlertText(changed, leadDisplayName(db));
    try {
      recordSecurityAlert(db, {
        kind: CONFIG_CHANGED_OUTSIDE_API_KIND, entityKey: "config:config.json", sourceRef: `config-change:${hash ?? "deleted"}`,
        title: text.title, body: text.body, delivery: "lead",
        rootCause: {
          code: "config_changed_outside_api", scope: "config",
          evidence: changed.length ? `变了的配置项：${changed.join("、")}` : "内容变了",
          next_step: "确认是不是用户自己改的；不是的话查是哪个进程改的",
        },
        payload: { changed },
      });
    } catch (error) {
      log(`[config] security alert not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  let lastConfigCheckAt = 0;
  // 只记录的主人操作（扫码配对的手机做的）读到哪里了。从启动时的最大 seq 开始：历史上的记录不一下子贴进会话。
  let ownerActionRecordCursor = maxEventSeq(db);
  // 账本的写入守卫（ledger-guard.ts）：每分钟核对一次触发器。缺了就补装；缺的是已经装过的表的触发器时报警
  // （任何连接都能 DROP TRIGGER）。daemon 启动后才建的表只补装，不报警。
  let lastGuardCheckAt = 0;
  const guardedAtStart = new Set<string>(ledgerGuardsEnabled() ? ledgerGuardTriggers(db) : []);
  const checkLedgerGuards = (): void => {
    if (!ledgerGuardsEnabled()) return;
    const missing = missingLedgerGuards(db);
    if (!missing.length) return;
    const known = new Set(guardedAtStart);
    const removed = missing.filter((name) => known.has(name));
    installLedgerGuards(db);
    for (const name of missing) guardedAtStart.add(name);
    if (!removed.length) return;
    const text = ledgerGuardRemovedAlertText(removed.length);
    recordSecurityAlert(db, {
      kind: LEDGER_GUARD_REMOVED_KIND, entityKey: "ledger:plc.db", title: text.title, body: text.body,
      rootCause: {
        code: "ledger_guard_removed", scope: "ledger",
        evidence: `${removed.length} 个触发器不见了或被换过：${removed.slice(0, 5).join("、")}`,
        next_step: "看最近的 child 在做什么；守卫已经补装",
      },
      payload: { missing: removed.slice(0, 20), count: removed.length },
    });
    log(`[ledger] ${removed.length} guard trigger(s) were removed; reinstalled`);
  };

  // 读 Keychain 每次起一个 security 进程，SmartModel 每次调用都要决策模型的 key。所以缓存一分钟：
  // 用户在 Keychain 里换了 key，一分钟内生效。
  const keychainCache = new Map<string, { value: string | null; at: number }>();
  const cachedKeychainSecret = (name: string): string | null => {
    const hit = keychainCache.get(name);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = readKeychainSecret(name);
    keychainCache.set(name, { value, at: Date.now() });
    return value;
  };

  // Lead 的记忆设置和 Hindsight 服务（设置页「Lead → 记忆 / 模型」）。决策模型的 key 不在保险库里时，
  // 从 daemon 专用的环境变量或者 Keychain 取：它不进 process.env，child 拿不到。
  const memoryControl = opts.manageMemory ? new MemoryController({
    db, dataDir: opts.dataDir, vault, memory, log,
    publish: (resource) => {
      publishControlEvent({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource } });
    },
    externalSecret: (name) => daemonOnlySecrets.get(name) ?? cachedKeychainSecret(name),
    summaryModels: (settings) => summaryModels(opts.dataDir, settings),
    programArguments: hindsightProgram(),
    ...(typeof opts.manageMemory === "object" ? opts.manageMemory : {}),
  }) : null;
  if (memoryControl) {
    // 设置 → 记忆的摘要模型和重试（操作层的 memory_settings）：页面和 Lead 调同一个函数。
    uiActionServices.memorySettings = memoryControl.memorySettingsService();
    void memoryControl.start().catch((error: any) => log(`[memory] start failed: ${error?.message ?? String(error)}; Lead memory uses notes only`));
  }

  // child 经工具桥用连接（engine 的 connection-host.ts）。预期内的失败以结果返回，child 据此报 blocker。
  const connectionFailure = (error: unknown) => {
    if (!(error instanceof ConnectionError)) throw error;
    return { ok: false, error: error.code, connection: error.key, message: error.message };
  };
  const connectionHost: AgentConnectionHost = {
    search: async (role, input, context) => {
      try {
        const tools = await connections.searchTools(role, input, { runId: context?.runId ?? null });
        return {
          ok: true,
          tools: tools.map((tool) => ({
            connection: tool.connection, name: tool.name, description: tool.description, read_only: tool.readOnly, input_schema: tool.inputSchema,
            ...(tool.allowedBy ? { allowed_by: tool.allowedBy } : {}),
          })),
        };
      } catch (error) {
        return connectionFailure(error);
      }
    },
    call: async (role, input, signal, context) => {
      try {
        const result = await connections.callTool(input.connection, input.tool, input.arguments, {
          role, runId: context?.runId ?? null, ...(signal ? { signal } : {}),
        });
        return { ok: !result.isError, text: result.text, truncated: result.truncated };
      } catch (error) {
        return connectionFailure(error);
      }
    },
  };
  setAgentConnectionHost(connectionHost);

  // 当前局面（spec D7，lead-input.ts）：包成 <system_event kind="situation">，放在这一轮输入的开头。
  // 生成不了时（例如库被锁）这一轮照常跑，只是没有这一份。
  // Lead 的上下文现在用了多少（lead 的 cost-signals.ts）。压缩线按会话的压缩参数算；读不到会话的设置时不写压缩线。
  function currentContextUsage(): LeadContextUsage | null {
    const settings = (session as { settingsManager?: { getCompactionSettings?: () => { reserveTokens?: unknown } } }).settingsManager;
    const reserve = settings?.getCompactionSettings?.()?.reserveTokens;
    return leadContextUsage(session, typeof reserve === "number" ? reserve : null);
  }

  function situationBlock(): string {
    try {
      const usage = currentContextUsage();
      const text = leadInput.renderSituation({
        queuedUserMessages: queuedInputs.filter((input) => input.kind === "followUp").length + carryOverTurns.length,
        queuedNotifications: listNotifications(db, { state: ["pending"], urgency: "immediate" })
          .filter((note) => !isDirectPushNotification(note.kind)).length,
        contextUsage: usage ? contextUsageLine(usage) : null,
      });
      return text ? leadSystemEvent("situation", text) : "";
    } catch (error: any) {
      log(`lead situation failed: ${error?.message ?? String(error)}`);
      return "";
    }
  }

  // 首次启动引导的设置状态（setup-status.ts）。在通道设置建好以后才建，这之前是 null。
  let setupTracker: SetupTracker | null = null;
  const factory = opts.sessionFactory ?? createLeadSession;
  const {
    session, modelName, syncToolAccess, reloadExtensions, models: leadModels, switchModel: switchLeadModel,
    reportsInputDelivery, smartModel: leadSmartModel, complete: leadComplete, smartModelLlm, refreshProviders, brainReady,
  } = await factory({
    memory,
    // 直觉的整条分工（设置 → 模型，2026-10-29）：SmartModel 按顺序问，都失败时问 LLM。
    ...(memoryControl ? { decisionModel: () => memoryControl.decisionChainCredentials() } : {}),
    llmFallback: () => loadDecisionModels(opts.dataDir).llmFallback,
    dataDir: opts.dataDir, dbPath: opts.dbPath, db,
    ...(opts.skillDirs ? { skillDirs: opts.skillDirs } : {}),
    childPi: opts.childPi,
    onChildDone, onChildEvent, runtimeRegistry,
    // 批量取消闸门按轮次计数（LEAD_CANCEL_BATCH_LIMIT）。用户回一句话就是新的一轮，
    // 预算随之重置——所以"你说全部终止"这类正当批量请求，请示一次即可放行。
    // 已受理的插话立刻算作新一轮——预算不该等 lead 开口才重置：用户说"全部终止"之后
    // lead 往往先动工具再说话，那时出水口还没改接过来。
    currentTurnId: () => pendingSteerSink?.turn.id ?? activeChannelTurn?.turn.id ?? null,
    turnOrigin: () => runOrigin,
    cancelBudgetTurnId: () => cancelBudgetTurnId,
    // set_lead_avatar 的结果按它算 Slack 署名 emoji 的生效值。
    configSlackEmoji,
    announceLeadStatus: (message) => {
      const tail = activeChannelTurn;
      if (!tail) return;
      publishTurnText(tail, message.endsWith("\n") ? message : `${message}\n`);
    },
    scheduleLeadModelRestart: (request) => {
      pendingLeadModelRestart = request;
    },
    ticketActionHost: userActions.host,
    uiActionServices,
    ticketSummaries: () => {
      if (!listTicketSummaries) throw new Error("daemon 还在启动，工单摘要还不可用");
      return listTicketSummaries();
    },
    ticketSummary: (id) => {
      if (!ticketSummaryOf) throw new Error("daemon 还在启动，工单摘要还不可用");
      return ticketSummaryOf(id);
    },
    // Lead 的健康状态只在 daemon 内存里（lead-health.ts）。read_lead_turns 读它，和顶栏的状态点是同一份。
    leadHealth: () => leadHealth.status(),
    connections,
    // 外部通道（统一消息事件 spec D8，工单 05）：Lead 处理消息事件的通用工具，按消息事件找卡。读对话时带上卡的事实。
    // 回复到来源、回表情走操作层（uiActionServices.channelMessages）。hub 在会话之后才建好。
    channelCards: {
      read: (cardId) => channelHub?.cardForLead(cardId) ?? null,
      // 派活、告诉用户（带 Lead 的草稿）、记下已处理。
      dispatch: (eventSeq, input) => {
        if (!channelHub) throw new Error("没有接任何外部通道");
        return channelHub.leadDispatch(eventSeq, input);
      },
      notify: (eventSeq, input) => {
        if (!channelHub) throw new Error("没有接任何外部通道");
        return channelHub.leadNotify(eventSeq, input);
      },
      // 改选交接说明里的一句（自动代你处理方案 B，D1）。
      repick: (eventSeq, input) => {
        if (!channelHub) throw new Error("没有接任何外部通道");
        return channelHub.leadRepick(eventSeq, input);
      },
      dispose: (eventSeq, input) => {
        if (!channelHub) throw new Error("没有接任何外部通道");
        return channelHub.leadDisposed(eventSeq, input);
      },
      // Lead 代用户直接发消息以前找对话（2026-10-23）。发消息走操作层（uiActionServices.channelMessages）。
      findConversations: (source, query) => {
        if (!channelHub) throw new Error("没有接任何外部通道");
        return channelHub.findConversations(source, query);
      },
      // 读一个对话最近的消息、列最近有动静的对话（2026-10-26：Lead 要能确认 Slack 里的上下文）。只读。
      readConversation: (conversationId, limit) => {
        if (!channelHub) throw new Error("没有接任何外部通道");
        return channelHub.readConversation(conversationId, limit);
      },
      recentConversations: (source, limit) => {
        if (!channelHub) throw new Error("没有接任何外部通道");
        return channelHub.recentConversations(source, limit);
      },
    },
    turnUserActions,
    leadModelQuota,
    // Lead 的 get_environment（工单 13）：调用时现读。不托管记忆服务时两项都是 null。
    environment: () => ({
      decisionModel: memoryControl?.getDecisionModel() ?? null,
      memory: memoryControl?.get() ?? null,
    }),
  });
  log(`lead ready (model=${modelName}, session=${session.sessionId})`);
  // 工单回复下面的动作按钮由 Lead 会话的 SmartModel 判断（ticket-reply-actions.ts）。会话没有给出 SmartModel 时不判断。
  replyActionsJudge = createTicketReplyActionsJudge({
    db,
    smartModel: () => leadSmartModel ?? null,
    publish: (event) => publishControlEvent(event),
    log,
  });
  // 会话报告一条用户消息什么时候送进模型的上下文（pi 的 message_start，role=user）：插话、排队消息据此改接出水口。
  const inputDeliveryEvents = reportsInputDelivery === true;
  // Lead 正在用的模型（spec D9 的模型切换会换掉它）。hello 和状态里报这个。
  let leadModelName = modelName;
  // 模型切换（model-failover.ts）：会话能在运行中换模型、也配了模型时才有。
  // 额度用尽、在重置以前跳过的模型存在 kv 里（2026-10-19）：daemon 重启以后不再去撞一次额度。
  // 额度按周重置的规则读 config.json 的 lead.quotaResets，没有时用 DEFAULT_LEAD_QUOTA_RESETS（笔记 #46）。
  // 你在输入框里换模型时（leadModelService.switch）按新的顺序重建它：额度封禁存在 kv 里，重建不丢。
  const failoverOptions = {
    ...leadQuotaResetsOption(opts.dataDir, log),
    quotaStore: {
      load: () => {
        const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LEAD_MODEL_QUOTA_KEY) as { value: string } | undefined;
        return row ? JSON.parse(row.value) as Record<string, number> : {};
      },
      save: (blocked: Record<string, number>) => {
        db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(LEAD_MODEL_QUOTA_KEY, JSON.stringify(blocked));
      },
    },
  };
  let modelFailover = switchLeadModel && leadModels?.length
    ? createLeadModelFailover({ models: leadModels, ...failoverOptions })
    : null;
  if (modelFailover) {
    // 读当时的切换器：你换模型以后它会被重建（rebuildModelFailover），但不会变成 null。
    leadModelQuotaControl = {
      list: () => (modelFailover?.blockedModels() ?? []).map((entry) => ({ model: entry.model, until: localIso(new Date(entry.until)) })),
      clear: (model) => {
        const cleared = modelFailover?.clearBlocked(model) ?? [];
        if (cleared.length) log(`lead model quota block cleared by Lead: ${cleared.join(", ")}`);
        return cleared;
      },
    };
  }
  // 会话建好时用的是 lead.models 的第一个（session.ts）。切换器想用别的（例如第一个的额度还没重置）时，
  // 第一轮开始前换（syncLeadModel），并告诉用户。
  let appliedLeadModel = modelFailover?.models[0] ?? modelName;
  // 最近一次定下的切换：为什么换、服务端给的恢复时间。下一轮开始前换模型时，写进日志和给 Lead 的说明。
  // manual：你在输入框里换的（leadModelService.switch）。告诉 Lead 的说法不一样，也不用 Lead 再告诉你。
  // via：用户在哪里换的（「在输入框里」「在设置页」），写进给 Lead 的说明。
  let pendingModelSwitch: { reason: string; restoreAt: number | null; manual?: boolean; via?: string } | null = modelFailover?.startup ?? null;
  // 服务商的地址或 key 改了（设置 → 模型）：正在用的模型要按新的注册重新挂一次。Lead 正在回答时，下一轮开始前做（syncLeadModel）。
  let rebindLeadModel = false;

  // Lead 正在用的模型变了（模型自动切换，或者你在输入框里换的）：告诉所有页面，输入框右下角的模型名跟着变。
  // 用 daemon.status.changed 的 model：旧页面也认这个字段。
  function publishLeadModel(): void {
    publishControlEvent({ type: "daemon.status.changed", requiredScope: "chat", payload: { model: leadModelName } });
  }

  // 会话输入框的模型选择（2026-10-26，protocol 的 lead-models.ts）。页面（GET /v1/lead/models、POST /v1/lead/model）
  // 和 Lead（switch_lead_model、perform_action）都用它；换模型经过操作层（engine 的 ui-actions/ 的 lead_model / switch）。
  const choiceOf = (spec: string): LeadModelChoice => {
    const parsed = parseLeadModelSpec(spec);
    return { model: parsed.model, effort: parsed.effort };
  };
  // 你选的：config.json 的 lead.models 的第一个。读不到 config 时就是正在用的。
  const selectedLeadSpec = (): string => {
    try {
      return loadLeadModelConfig(opts.dataDir).models[0] ?? leadModelName;
    } catch {
      return leadModelName;
    }
  };
  // 目录要问 provider（vibeproxy 的 /v1/models）。连着点开几次输入框的模型名时不用每次都问：30 秒内用上一次的。
  let leadCatalogCache: { at: number; models: Promise<LeadCatalogModel[]> } | null = null;
  const LEAD_CATALOG_TTL_MS = 30_000;
  const rebuildModelFailover = () => {
    modelFailover = createLeadModelFailover({ models: loadLeadModelConfig(opts.dataDir).models, ...failoverOptions });
  };
  const leadModelService: LeadModelService = {
    state: () => ({ current: choiceOf(leadModelName), selected: choiceOf(selectedLeadSpec()) }),
    async catalog() {
      if (!leadCatalogCache || Date.now() - leadCatalogCache.at > LEAD_CATALOG_TTL_MS) {
        const models = leadModelCatalog(loadLeadModelConfig(opts.dataDir)).then((result) => result.models);
        leadCatalogCache = { at: Date.now(), models };
        models.catch(() => { leadCatalogCache = null; });
      }
      const models = await leadCatalogCache.models;
      // 额度封禁按模型算（不看推理强度）：同一个模型的几个强度都封着时，取最晚的那个时间。
      const blocked = new Map<string, number>();
      for (const entry of modelFailover?.blockedModels() ?? []) {
        const model = parseLeadModelSpec(entry.model).model;
        blocked.set(model, Math.max(blocked.get(model) ?? 0, entry.until));
      }
      return {
        ...leadModelService.state(),
        models: models.map((model) => {
          const spec = `${model.provider}/${model.id}`;
          const until = blocked.get(spec);
          return {
            model: spec, provider: model.provider, id: model.id, prefix: model.prefix, source: model.source, name: model.name,
            image: model.input.includes("image"), efforts: model.efforts, defaultEffort: model.defaultEffort,
            blockedUntil: until === undefined ? null : new Date(until).toISOString(),
          };
        }),
      };
    },
    async switch(choice) {
      const spec = leadModelSpec(choice);
      const previousSpec = selectedLeadSpec();
      const previous = choiceOf(previousSpec);
      if (spec === previousSpec && spec === leadModelName) return { previous, selected: choice, applied: "unchanged" };
      if (!modelFailover || !switchLeadModel) throw new UiActionError("unavailable", "这个 Lead 会话不能在运行中换模型");
      // 在不在目录里、推理强度支不支持：不行时拒绝，原因里写着可选的。
      try {
        await assertConfiguredLeadModel(spec, loadLeadModelConfig(opts.dataDir));
      } catch (error) {
        throw new UiActionError("invalid_input", error instanceof Error ? error.message : String(error));
      }
      // 你点名要用它：它的额度封禁不再挡着。它真的还不能用时，模型自动切换会再换走。
      modelFailover.clearBlocked(spec);
      setLeadModelInConfig(spec, opts.dataDir);
      rebuildModelFailover();
      pendingModelSwitch = { reason: "用户在输入框里换了模型", restoreAt: null, manual: true };
      log(`lead model chosen by the user: ${previousSpec} -> ${spec}`);
      // Lead 正在回答：这一轮结束以后，下一轮开始前换（runTurnNow 的 syncLeadModel）。
      if (busy || draining || systemTurnStarting) return { previous, selected: choice, applied: "after_turn" };
      await syncLeadModel();
      if (leadModelName !== spec) {
        // 换不过去（例如注册不了这个模型）：原因在日志里。config 退回原来的顺序。
        setLeadModelInConfig(previousSpec, opts.dataDir);
        rebuildModelFailover();
        throw new UiActionError("unavailable", `换不到 ${spec}，还在用 ${leadModelName}`);
      }
      return { previous, selected: choice, applied: "now" };
    },
  };
  uiActionServices.leadModels = leadModelService;

  // 设置 → 模型（方案 B，2026-10-29，.scratch/model-settings/spec.md）。大脑的分工整条写进 lead.models，主用变了才换模型：
  // 只改备用的顺序时不动正在用的（模型自动切换可能正用着备用）。
  const modelSettings = new ModelSettings({
    db, dataDir: opts.dataDir, vault, log, memory: memoryControl,
    externalSecret: (name) => daemonOnlySecrets.get(name) ?? cachedKeychainSecret(name),
    smartModelLlm: () => smartModelLlm ?? null,
    publish: () => {
      publishControlEvent({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: MODEL_SETTINGS_RESOURCE } });
      // 首次启动页接好大脑以后马上重算：页面等着设置状态说大脑能用了才切到会话。
      void setupTracker?.refresh().catch((error) => log(`[setup] 重算设置状态失败：${error instanceof Error ? error.message : String(error)}`));
    },
    brain: {
      current: () => leadModelName,
      blocked: () => modelFailover?.blockedModels() ?? [],
      async applyChain(specs) {
        const primary = specs[0]!;
        const previousModels = loadLeadModelConfig(opts.dataDir).models;
        const previousPrimary = previousModels[0] ?? leadModelName;
        const switching = primary !== previousPrimary || (primary !== leadModelName && !modelFailover?.blockedModels().some((entry) => entry.model === leadModelName));
        if (switching && (!modelFailover || !switchLeadModel)) throw new UiActionError("unavailable", "这个 Lead 会话不能在运行中换模型");
        setLeadModelChainInConfig(specs, opts.dataDir);
        rebuildModelFailover();
        leadCatalogCache = null;
        if (!switching || primary === leadModelName) return "unchanged";
        // 你点名要用它：它的额度封禁不再挡着。它真的还不能用时，模型自动切换会再换走。
        modelFailover!.clearBlocked(primary);
        pendingModelSwitch = { reason: "用户在设置页换了主用", restoreAt: null, manual: true, via: "在设置页" };
        log(`lead model chain set by the user: ${previousModels.join(", ")} -> ${specs.join(", ")}`);
        if (busy || draining || systemTurnStarting) return "after_turn";
        await syncLeadModel();
        if (leadModelName !== primary) {
          setLeadModelChainInConfig(previousModels, opts.dataDir);
          rebuildModelFailover();
          throw new UiActionError("unavailable", `换不到 ${primary}，还在用 ${leadModelName}`);
        }
        return "now";
      },
      async providersChanged() {
        leadCatalogCache = null;
        if (!refreshProviders) return;
        try {
          await refreshProviders();
        } catch (error: any) {
          log(`lead providers refresh failed: ${error?.message ?? String(error)}`);
          return;
        }
        if (busy || draining || systemTurnStarting) {
          rebindLeadModel = true;
          return;
        }
        try {
          await switchLeadModel?.(appliedLeadModel);
        } catch (error: any) {
          log(`lead model rebind after a provider change failed: ${error?.message ?? String(error)}`);
        }
      },
    },
  });
  uiActionServices.modelSettings = modelSettings;
  // 代回复风格的提炼（设置 → 消息通道，2026-10-28）：用 Lead 的 SmartModel 的 LLM 后端，和把对话整理成事实的是同一个。
  uiActionServices.textModel = () => leadComplete ?? null;

  // 在正在运行的 Lead 会话里重新加载扩展（2026-10-16 用户要求）：Lead 是一个常驻会话，自己从不重建。
  // SoL-Pi 在 daemon 运行中第一次装好时（main.ts 的 solPi.sync），不用重启 daemon 就要用上。
  // reload 只在两轮之间做：Lead 空闲时马上做；正在跑一轮时记下来，这一轮结束再做（同一时间的多次请求合成一次）。
  // 重新加载期间来的新一轮，等它做完再开始（runTurnNow）。
  let pendingExtensionReload: string | null = null;
  let extensionReload: Promise<void> | null = null;
  function reloadLeadExtensions(reason: string): void {
    if (!reloadExtensions) {
      log(`lead session cannot reload its extensions (${reason}); they load after the next daemon restart`);
      return;
    }
    pendingExtensionReload = reason;
    applyPendingExtensionReload();
  }
  function applyPendingExtensionReload(): void {
    if (busy || extensionReload || !pendingExtensionReload || !reloadExtensions) return;
    const reason = pendingExtensionReload;
    pendingExtensionReload = null;
    extensionReload = reloadExtensions().then(
      () => log(`lead extensions reloaded (${reason})`),
      (error: any) => log(`lead extension reload failed (${reason}): ${error?.message ?? String(error)}`),
    ).finally(() => {
      extensionReload = null;
      applyPendingExtensionReload();
    });
  }

  // 用户对 lead 的授权（store/lead-grants.ts）。plc 和 companion 都经过 paired 控制面
  // 走到这里（渠道按 binding 记 cli 或 control-plane），因为授权变动必须**当场**改写活着的 session 的工具表：
  // 撤销之后 lead 下一轮就不该再看得见 confirm_item，而不是等到 daemon 重启。
  // lead 的工具表里没有任何一条能走到这里，授权因此不可自授。
  const leadTrust = {
    grant(capability: LeadCapability, via: LeadGrantChannel, note?: string): LeadGrant {
      const granted = grantLeadCapability(db, {
        capability, via, ...(note === undefined ? {} : { note }),
      });
      syncToolAccess?.();
      log(`[trust] granted ${capability} via ${via} (grant #${granted.id})`);
      return granted;
    },
    revoke(capability: LeadCapability, via: LeadGrantChannel): number {
      const revoked = revokeLeadCapability(db, { capability, via });
      syncToolAccess?.();
      log(`[trust] revoked ${capability} via ${via} (${revoked} grant(s))`);
      return revoked;
    },
    status(capability: LeadCapability): LeadGrant | null {
      return activeLeadGrant(db, capability);
    },
  };

  let precipitated = false; // 每个压缩周期只做一次沉淀检查
  let coreMemoryDirty = false; // 压缩后核心记忆需在下一轮前缀重注入（spec §A2 的既定偏差：前缀注入替代 followUp）
  // 上下文压缩的时限（spec D9）：2026-10-16 一次溢出压缩跑了 70 分钟才失败。超过 PLC_LEAD_COMPACTION_TIMEOUT_MS
  // （缺省 10 分钟）时，daemon 用 pi 的 abortCompaction 中止这次压缩，按失败处理。
  const configuredCompactionTimeoutMs = Number(process.env.PLC_LEAD_COMPACTION_TIMEOUT_MS);
  const compactionTimeoutMs = Number.isFinite(configuredCompactionTimeoutMs) && configuredCompactionTimeoutMs > 0
    ? configuredCompactionTimeoutMs : 10 * 60_000;
  let compactionTimer: NodeJS.Timeout | null = null;
  let compactionTimedOut = false;
  // 自动压缩失败了，还没有压缩成功过：哪一种（recoverLeadContext 在下一轮开始以前先压缩一次）。
  // overflow：溢出恢复的压缩失败，上下文确实满了；threshold：到了压缩线，模型还有一点余量。
  let compactionDue: "threshold" | "overflow" | null = null;
  // daemon 自己发起的压缩正在跑（recoverLeadContext）。
  let recoveringCompaction = false;
  // 关于 Lead 自己的事（压缩失败、换了模型）是事件（工单 14，store 的 lead-self-events.ts）：按 Lead 的事件游标交给它，
  // 写在下一轮当前局面的「关于你自己」一节。这一轮成功才算告诉过，失败或重启从原位置重读。以前是这里的内存队列 leadSelfNotes。
  function recordLeadSelfEvent(what: string, write: () => void): void {
    try {
      write();
    } catch (error: any) {
      log(`lead self event (${what}) failed: ${error?.message ?? String(error)}`);
    }
  }
  // Lead 自己的模型调用健康（顶栏的状态点读它）。下一次自动调用的时间来自后面才建好的
  // 通知重播和心跳巡检，它们建好时把自己登记进来。
  const scheduledLeadAttempts: Array<() => number | null> = [];
  const leadHealth = createLeadHealthTracker({
    nextScheduledAttempt: () => {
      const times = scheduledLeadAttempts.map((next) => next()).filter((at): at is number => at !== null);
      return times.length ? new Date(Math.min(...times)) : null;
    },
    onChange: (lead) => {
      // 带 lead 的 daemon.status.changed 是选收事件：只有连接时带 include=lead_health 的客户端收得到
      // （旧客户端严格校验这个 payload，见 protocol 的 gatewayEventOptIn）。
      publishControlEvent({ type: "daemon.status.changed", requiredScope: "tickets:view", payload: { lead } });
    },
    lastPatrolAt: loadLastPatrolAt(db),
    savePatrol: (at) => saveLastPatrolAt(db, at),
    leadName: () => leadDisplayName(db),
  });
  // 断网不是模型的问题（2026-10-16）：系统回合叫醒 Lead 之前先探网络，不通时等它恢复，恢复后马上接着做。
  const network = new NetworkMonitor({
    probe: opts.networkProbe ?? (opts.sessionFactory
      ? async () => null
      : dnsProbe(process.env.PLC_NETWORK_PROBE_HOST ?? "api.anthropic.com")),
    retryBaseMs: Number(process.env.PLC_NETWORK_RETRY_MS ?? 15_000),
    onDown: (detail) => {
      log(`network unreachable: ${detail}`);
      leadHealth.networkDown(detail);
    },
    // 网络恢复：等它的那一轮用户消息接着试，积压的事叫醒 Lead 处理。Lead 的健康状态和唤醒退避不动：
    // 探测通过不等于模型能用，只有一次成功的模型调用才算恢复（发布评审 f796c1c 的 B1）。
    onRestored: () => {
      log("network is back: resuming Lead");
      dispatchLeadWork();
    },
  });

  session.subscribe((event: any) => {
    lastLeadActivityAt = Date.now();
    leadSilentSince = null;
    // 一条用户消息送进了模型的上下文（工单 04）：插话、排队消息送到的时刻。
    if (event.type === "message_start" && event.message?.role === "user") {
      onUserInputDelivered(userMessageText(event.message));
    }
    if (event.type === "auto_retry_start") {
      leadHealth.retrying(Number(event.delayMs ?? 0), String(event.errorMessage ?? ""));
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = String(event.assistantMessageEvent.delta ?? "");
      broadcast({ type: "delta", text: delta });
      aishStream?.append(delta);
      streamingMessageText += delta;
      routeAssistantText(delta);
    }
    if (event.type === "message_update") streamRenderUi(event.assistantMessageEvent);
    if (event.type === "tool_execution_start") {
      // 输出算外部内容的工具（turn-origin.ts 的清单，没声明的也算）：这一轮算读过外部内容，记下是哪个工具。
      if (isExternalTextTool(event.toolName)) runOrigin = withExternalContent(runOrigin, { via: "tool", tool: event.toolName });
      if (!event.parentToolCallId) remindOnOverflow();
      const args = JSON.stringify(event.args ?? {});
      broadcast({ type: "tool", name: event.toolName, args: args.length > 120 ? args.slice(0, 120) + "…" : args });
    }
    let handled = false;
    if (event.type.startsWith("tool_execution_")) {
      if (pendingSteerSink && !activeChannelTurn) {
        // 系统回合还没开口时用户插了话：这之后的工具调用是在回应插话，归插话那一轮，
        // 只发给插话的人，也不再落成系统回合。
        handOverToSteer();
      } else if (!pendingSteerSink && systemTurnBuffer) {
        const buffer = systemTurnBuffer;
        handled = true;
        if (!activeChannelTurn && LEAD_QUIET_TOOLS.has(String(event.toolName))) {
          // 只读、笔记工具先攒着：这一轮最后可能不落成。
          buffer.toolEvents.push({ event, textOffset: buffer.text.length });
        } else {
          // 改变外部状态的工具：这一轮当场落成，工具执行时拿得到轮次 id。文字照样攒到回合结束。
          materializeBufferedSystemTurn(buffer);
          if (activeChannelTurn) persistLeadToolEvent(activeChannelTurn, event, buffer.text.length);
        }
      } else if (!pendingSteerSink) {
        materializeSystemTurn();
      }
    }
    if (activeChannelTurn && !handled && event.type.startsWith("tool_execution_")) {
      persistLeadToolEvent(activeChannelTurn, event);
    }
    // 改日程的 Lead 工具自己发刷新事件（经过操作层的由操作层发），这里不再按工具名另发一份（ui-action-parity P04）。
    if (event.type === "message_end") {
      if (event.message?.role === "assistant") {
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
          const rawError = String(
            event.message.errorMessage
              || (event.message.stopReason === "aborted"
                ? restartAbort ? LEAD_RESTART_INTERRUPTED_ERROR : "Lead 回复被中断，请重试。"
                : EMPTY_ASSISTANT_REPLY_ERROR),
          );
          activeTurnError = presentLeadTurnError(rawError);
          log(`lead model error: ${rawError}`);
          // 中断（用户插话、停止）不是模型的问题，不算进健康。
          if (event.message.stopReason === "error") leadHealth.failed(rawError);
        } else if (isEmptyLengthStop(event.message)) {
          // 回答被截成空的（上下文满了，模型没有输出的空间）：一次失败的模型调用，不是成功（2026-10-28）。
          // pi 接着做溢出压缩再试；那一次答上了，下面成功的分支清掉这个错误。压缩失败时 compaction_end 换上压缩的原因。
          const rawError = leadContextFullError();
          activeTurnError = presentLeadTurnError(rawError);
          log(`lead reply cut off empty (stopReason length): ${rawError}`);
          leadHealth.failed(rawError);
        } else {
          // SDK 自动重试可能先发 error，再以一条成功消息结束；最终成功应清掉前次错误。
          activeTurnError = null;
          leadHealth.succeeded();
          // 模型答上了：到模型服务的路是通的，不再按探测拦着系统的唤醒。
          network.modelSucceeded();
          // 这是这一轮最后的回答（没有调工具）：还在 pi 队列里的插话赶不上这一轮了，转为下一轮的输入。
          // 界面标记从「已插入」改为「下一轮回答」（spec D6）。
          const calledTools = Array.isArray(event.message.content)
            && event.message.content.some((part: any) => part?.type === "toolCall");
          if (!calledTools && inputDeliveryEvents) {
            for (const input of queuedInputs) {
              if (input.kind !== "steer" || input.nextTurn) continue;
              input.nextTurn = true;
              publishTurnStarted(input.entry, "steered", { placement: "next_turn" });
            }
          }
        }
      }
      const fullText = assistantMessageText(event.message);
      const streamed = streamingMessageText;
      streamingMessageText = "";
      // 补尾比的是**本条消息**已流过的文本，不是某个出水口的整轮文本。后者在两种情况下都不再
      // 是 fullText 的前缀：一轮里有多条 assistant 消息（补尾会静默失效），以及出水口被插话
      // 中途改接（前半段记在被打断的那轮，后半段记在插话那轮）。补出来的这一段照样走
      // routeAssistantText——若插话之后一个 delta 都没来过，这段就是插话之后的第一句话。
      if (fullText.startsWith(streamed)) routeAssistantText(fullText.slice(streamed.length));
    }
    if (event.type === "compaction_start") {
      if (compactionTimer) clearTimeout(compactionTimer);
      compactionTimedOut = false;
      const reason = String(event.reason ?? "unknown");
      log(`compaction started (${reason})`);
      compactionTimer = setTimeout(() => {
        compactionTimer = null;
        compactionTimedOut = true;
        log(`compaction (${reason}) still running after ${compactionTimeoutMs}ms: aborting it`);
        // pi 有中止压缩的接口：只停这次压缩。会话没有这个接口时，退一步中止这一轮。
        if (session.abortCompaction) {
          session.abortCompaction();
        } else {
          Promise.resolve(session.abort?.()).catch((error: any) => log(`compaction abort failed: ${error?.message ?? String(error)}`));
        }
      }, compactionTimeoutMs);
      compactionTimer.unref();
    }
    // 以前每一次 compaction_end 都记成「compaction done」，失败的压缩也一样（2026-10-16 那五次）。
    // 现在读 pi 的 aborted 和 errorMessage：失败写明原因，算进 Lead 的健康状态，Lead 的下一轮也知道。
    if (event.type === "compaction_end") {
      if (compactionTimer) clearTimeout(compactionTimer);
      compactionTimer = null;
      const reason = String(event.reason ?? "unknown");
      const timedOut = compactionTimedOut;
      const outcome = compactionEndOutcome(event, { timedOut, timeoutMs: compactionTimeoutMs });
      compactionTimedOut = false;
      if (outcome.kind === "succeeded") {
        precipitated = false; // 新压缩周期，重新武装
        coreMemoryDirty = true; // 压缩摘要不保真核心记忆，下一轮重新注入
        leadInput.forgetSentSituation(); // 压缩摘要也不保真当前局面：下一份整段给
        compactionDue = null;
        log(`compaction done (${reason}), precipitation re-armed`);
      } else if (outcome.kind === "aborted") {
        // 停机或者停止中止了它：不是模型的问题。上下文没变，整理笔记不重新武装。
        log(`compaction aborted (${reason})`);
      } else if (recoveringCompaction) {
        // daemon 自己发起的那一次（recoverLeadContext）：它决定再试还是收尾，失败由它记一次。
        log(`compaction failed (${reason}): ${outcome.detail}`);
      } else {
        log(`compaction failed (${reason}): ${outcome.detail}`);
        // 自动压缩失败：下一轮开始以前 daemon 自己压缩一次，带上长度预算（recoverLeadContext）。
        if (reason === "overflow" || reason === "threshold") compactionDue = compactionDue === "overflow" ? "overflow" : reason;
        // 溢出恢复的压缩失败了：这一轮的回答已经被截成空的，pi 不再重试。这一轮是失败的一轮（2026-10-28）：
        // 游标不动，交给它的事件下一轮再交；按上下文溢出算（模型切换）。
        if (reason === "overflow" && busy) activeTurnError = presentLeadTurnError(leadContextFullError(outcome.detail));
        leadHealth.compactionFailed(outcome.detail);
        recordLeadSelfEvent("compaction failed", () => recordLeadCompactionFailed(db, {
          reason, detail: outcome.detail, timedOut,
        }));
      }
    }
  });

  // 自动压缩失败以后，下一轮开始以前 daemon 自己压缩一次（2026-10-28）。pi 的自动压缩不带说明，摘要每次并进上一份，
  // 越写越长，写到输出上限就失败；daemon 发起的这一次带上长度预算（lead 的 leadCompactionInstructions），
  // 写到上限时按更严的预算再写一次。都不成时：上一次是溢出恢复失败（上下文确实满了），这一轮不调模型，按上下文溢出失败
  // （模型切换按连续溢出算）；只是到了压缩线，照常调模型（还有一点余量），失败只记下。
  async function recoverLeadContext(): Promise<void> {
    const due = compactionDue;
    if (due === null || typeof session.compact !== "function") return;
    let failure = "";
    for (const level of ["normal", "strict"] as const) {
      recoveringCompaction = true;
      try {
        log(`compacting Lead's context before the turn (${level}, at most ${LEAD_COMPACTION_BUDGETS[level]} characters)`);
        await session.compact(leadCompactionInstructions(level));
        compactionDue = null;
        return;
      } catch (error: any) {
        failure = String(error?.message ?? error);
        // 上一次压缩以后没有新的对话：没有要压缩的（pi 的 "Already compacted"、"Nothing to compact"）。
        if (/already compacted|nothing to compact/i.test(failure)) {
          compactionDue = null;
          return;
        }
        if (!isSummaryTokenCapError(failure)) break;
      } finally {
        recoveringCompaction = false;
      }
    }
    const detail = `上下文压缩失败：${failure}`;
    leadHealth.compactionFailed(detail);
    recordLeadSelfEvent("compaction failed", () => recordLeadCompactionFailed(db, { reason: "manual", detail, timedOut: false }));
    if (due !== "overflow") return;
    const error = leadContextFullError(detail);
    leadHealth.failed(error);
    throw new Error(presentLeadTurnError(error));
  }

  // 沉淀检查：回合结束后检测上下文水位，赶在 auto-compaction 之前让 lead 存 notes。
  // 用户的问题还没回答时（排队中，或者在等那一次自动重试）先不做：先回答用户。这一轮不算做过，
  // 那一轮答完以后（每一轮结束都会再来这里）再检查（2026-10-17，spec D9）。
  function maybePrecipitate(): void {
    if (precipitated || busy || hasUnansweredUserTurn()) return;
    const ratio = contextUsageRatio(session);
    if (ratio !== null && ratio >= PRECIPITATE_RATIO) {
      precipitated = true;
      log(`context at ${(ratio * 100).toFixed(0)}%, running precipitation check`);
      void runTurn(PRECIPITATE_PROMPT, { system: SYSTEM_TURN_ORIGINS.precipitate });
    }
  }

  // ── Lead 是常驻的助理（2026-10-15 用户决定，Jarvis 模式）──────────────────────────────
  // 「凡是这些委派出去的事情中间出现的状况都应该先让 lead 知道吧？异常的，完成的，都先交由他知道吧？
  // 由 lead 决策要如何知会我」。事件都先交给 Lead；向用户推送由 Lead 用 notify_user 决定。
  // 系统只在 Lead 不能工作时兜底，从不拿计时器推翻 Lead 的判断：
  //   · Lead 的模型调用持续失败超过 PLC_LEAD_DOWN_GRACE_MS（默认 1 分钟）；
  //   · 一轮卡死：不按时长算（2026-10-15 用户：「30 分钟也未必算卡死」）。系统每隔 PLC_LEAD_CHECK_MIN_MS 到
  //     PLC_LEAD_CHECK_MAX_MS（默认 15 到 25 分钟，随机）查一次：这一轮在一整个检查间隔里没有任何动静才算。
  //     一直在输出或者调用工具的长任务不算。
  // 兜底给用户一条汇总（会话里一行、Slack、没人在看时弹桌面），不逐条发；汇总过的事不再汇总。
  const leadDownGraceMs = Number(process.env.PLC_LEAD_DOWN_GRACE_MS ?? 60_000);
  const leadCheckMinMs = Number(process.env.PLC_LEAD_CHECK_MIN_MS ?? 15 * 60_000);
  const leadCheckMaxMs = Math.max(leadCheckMinMs, Number(process.env.PLC_LEAD_CHECK_MAX_MS ?? 25 * 60_000));
  let lastLivenessCheckAt = Date.now();
  let livenessTimer: NodeJS.Timeout | null = null;
  function checkLeadLiveness(): void {
    const now = Date.now();
    // 上一次检查以前就开始的这一轮，从上一次检查到现在一点动静都没有：卡死了。
    if (busy && turnStartedAt !== null && turnStartedAt <= lastLivenessCheckAt && lastLeadActivityAt <= lastLivenessCheckAt) {
      leadSilentSince ??= Math.max(turnStartedAt, lastLeadActivityAt);
    }
    lastLivenessCheckAt = now;
    scheduleLivenessCheck();
  }
  function scheduleLivenessCheck(): void {
    const delay = leadCheckMinMs + Math.random() * (leadCheckMaxMs - leadCheckMinMs);
    livenessTimer = setTimeout(checkLeadLiveness, delay);
    livenessTimer.unref();
  }
  scheduleLivenessCheck();
  // reason 是写进日志和通知的一句话；kind 和 since 给停摆卡片（protocol 的 lead-outage）：为什么、从什么时候起。
  function leadIncapacity(now = Date.now()): { reason: string; kind: LeadModelFailureKind | "silent"; since: number } | null {
    const status = leadHealth.status();
    // 只看模型调用的失败（failures）：只是上下文压缩失败时，Lead 的模型调用可能还是好的，不算不能工作。
    if (status.state === "degraded" && status.failures > 0 && status.since && now - Date.parse(status.since) >= leadDownGraceMs) {
      return {
        reason: `${leadDisplayName(db)} 的模型调用失败（${status.reason ?? status.detail ?? "原因未知"}）`,
        kind: classifyLeadModelError(status.detail ?? ""),
        since: Date.parse(status.since),
      };
    }
    if (busy && leadSilentSince !== null) {
      return {
        reason: `${leadDisplayName(db)} 的这一轮已经 ${Math.max(1, Math.round((now - leadSilentSince) / 60_000))} 分钟没有任何动静`,
        kind: "silent",
        since: leadSilentSince,
      };
    }
    return null;
  }

  // 审批由 Lead 传达。系统保证它在过期前送到用户（2026-10-15 用户决定）。算送到的情况：
  //   · 用户在看会话时，审批卡片就在会话里；
  //   · Lead 用 notify_user 转达了它（dedup_key 是 approval:<id>:lead-notice）；
  //   · 系统已经推过。
  // 都没有、离过期不到 PLC_APPROVAL_DEADLINE_MARGIN_MS（默认 5 分钟）时，系统自己推。
  const approvalDeadlineMarginMs = Number(process.env.PLC_APPROVAL_DEADLINE_MARGIN_MS ?? 5 * 60_000);
  const conveyedApprovals = new Set<number>();
  function approvalConveyed(approval: ReturnType<typeof pendingApprovals>[number]): boolean {
    if (conveyedApprovals.has(approval.id)) return true;
    if (lastAttendedAt !== null && lastAttendedAt >= parseDbTime(approval.created_at)) return true;
    return db.prepare("SELECT 1 FROM notifications WHERE dedup_key=?").get(`approval:${approval.id}:lead-notice`) !== undefined;
  }
  function pushApproval(approval: ReturnType<typeof pendingApprovals>[number]): void {
    conveyedApprovals.add(approval.id);
    const line = pendingApprovalLine(approval);
    // Lead 提议的常设指令修改（工单 10）只能在确认卡或设置页里决定：不提示回复，也不发 Slack 的批准按钮。
    if (isStandingOrderProposal(approval)) {
      broadcast({ type: "notice", text: `[审批 #${approval.id}] ${line}` });
      aishNotify(`🔔 ${line}`);
      if (clientCount() === 0) notifyDesktop(line);
      return;
    }
    broadcast({ type: "notice", text: `[审批 #${approval.id}] ${line}（回复"批准 #${approval.id}"，或在 Slack 点按钮）` });
    if (aishAdapter?.connected && lastAishOrigin) {
      void aishAdapter.requestApproval(lastAishOrigin.channelId, lastAishOrigin.threadTs, {
        approvalId: String(approval.id), tool: approval.tool, description: approval.action,
      }).catch((e: any) => log(`[approval] aish request failed: ${e.message}`));
    } else if (clientCount() === 0) {
      notifyDesktop(line);
    }
  }

  // 一次停摆（Lead 不能工作的一段时间），会话里只有一条系统通知（2026-10-16）。以前每次汇总都是一条新的通知，
  // 正文把 Lead 写给自己的跟进原样转给用户；Lead 那几轮的失败另外是一张卡片。现在：
  //   · 开头一行："Lead 离线 19:11 起（网络中断）· 期间积压 2 件"（protocol 的 lead-outage）；
  //   · 每件积压的事一行，写给用户看：Lead 的跟进只说"跟进到点了"，工具名去掉；
  //   · 停摆期间来了新的事，这一条原地更新；Lead 恢复以后再更新一次，写上恢复的时间。
  // 积压的事都已经在会话里有卡片时（检查点、介入卡片），不另贴这一条，只推桌面和 Slack（一件事一张卡片）。
  // 没有积压的停摆不贴：Mac 每天夜里睡眠都会断网，那不是用户要知道的事。
  // 停摆记在会话里那条通知上（lead-outage.ts）：daemon 重启前还没结束的那一次接着记，上一次结束的时间也读回来。
  // 读回的那一次（restored）在 daemon 起来满一个宽限期、Lead 也正常时收尾，写上结束时间。
  const restoredOutages = restoreOutages(db);
  let outage: (OpenOutage & { restored?: true }) | null = restoredOutages.open ? { ...restoredOutages.open, restored: true } : null;
  let lastOutageEndedAt = restoredOutages.lastEndedAt;
  const daemonStartedAt = Date.now();

  const clockOf = (at: number) => localIso(new Date(at)).slice(11, 16);

  function outageText(endedAt: number | null): string {
    const current = outage!;
    const name = leadDisplayName(db);
    const headline = leadOutageHeadline({
      start: clockOf(current.since),
      end: endedAt === null ? null : clockOf(endedAt),
      cause: leadOutageCause(current.kind),
      pending: current.items.length,
      resumed: endedAt !== null,
      durationMs: endedAt === null ? null : endedAt - current.since,
      name,
    });
    const lines = current.items.map((item) => {
      // 「已推送给你」以外的状态读回时都算 inbox（lead-outage.ts 的 restoreOutages），所以可以写名字。
      const status = item.kind === "pushed" ? "已推送给你" : endedAt === null ? `等 ${name} 恢复后处理` : `已交给 ${name}`;
      return `· ${item.line} —— ${status}`;
    });
    return [headline, ...lines].join("\n");
  }

  // 写这一次停摆的那条系统通知：第一次新建，之后原地更新（同一轮重新开始、写入全文，客户端替换掉旧的文字）。
  function writeOutageNotice(endedAt: number | null): void {
    const current = outage;
    // 积压的事都已经有卡片时不另开这一张；已经开了的这一张总是原地更新（例如 daemon 重启后读回的那一张）。
    if (!current || (!current.turnId && current.items.every((item) => item.hasRecord))) return;
    const text = outageText(endedAt);
    if (!current.turnId) {
      current.turnId = `turn_outage_${current.since}`;
      publishSystemNotice(SYSTEM_TURN_ORIGINS.fallbackNotice, text, { id: current.turnId });
      return;
    }
    const reopened = reopenTurn(db, current.turnId);
    if (!reopened) return;
    const entry: ActiveChannelTurn = { turn: reopened, assistantText: "" };
    publishTurnStarted(entry, "started");
    publishTurnText(entry, text);
    sealChannelTurn(entry);
  }

  function backlogLine(row: ReturnType<typeof listLeadBacklog>[number]): string {
    const item = row.item_id === null ? null : getItem(db, row.item_id);
    const summary = row.summary.trim().replace(new RegExp(`^工单\\s*#${row.item_id ?? "x"}\\s*`, "u"), "");
    const text = userFacingBacklogText(summary, leadDisplayName(db));
    return item ? `工单 #${item.id}「${item.display_title ?? item.title}」：${text}` : text;
  }

  function summarizeBacklogForUser(incapacity: { reason: string; kind: LeadModelFailureKind | "silent"; since: number }): void {
    const now = new Date();
    const rows = listLeadBacklog(db, now);
    const notes = listNotifications(db, { state: ["pending"], urgency: "immediate" }).filter((note) => !isDirectPushNotification(note.kind));
    const approvals = pendingApprovals(db).filter((approval) => !approvalConveyed(approval));
    const items: OutageItem[] = [
      ...rows.map((row) => ({ line: backlogLine(row), kind: "inbox" as const, hasRecord: blockerHasConversationRecord(db, row) })),
      ...notes.map((note) => ({
        line: userFacingBacklogText(`${note.title}${note.body ? `：${note.body.split("\n")[0]}` : ""}`, leadDisplayName(db)),
        kind: "pushed" as const, hasRecord: false,
      })),
      ...approvals.map((approval) => ({
        line: pendingApprovalLine(approval),
        kind: "pushed" as const, hasRecord: false,
      })),
    ];
    if (!items.length) return;
    // 新的一次停摆不早于上一次停摆恢复的时间，两张卡片的时间段不重叠（发布评审）。
    outage ??= { since: outageStart(incapacity.since, lastOutageEndedAt), kind: incapacity.kind, items: [], turnId: null };
    outage.kind = incapacity.kind;
    outage.items.push(...items);
    const title = leadOutageHeadline({
      start: clockOf(outage.since), end: null, cause: leadOutageCause(outage.kind), pending: outage.items.length, resumed: false,
      name: leadDisplayName(db),
    });
    escalateLeadBacklog(db, rows.map((row) => row.id), { reason: incapacity.reason, at: now });
    for (const note of notes) markNotificationDelivered(db, note.id, "fallback", now);
    for (const approval of approvals) pushApproval(approval);
    const newLines = items.map((item) => item.line);
    const summaryId = addNotification(db, {
      kind: "lead_unavailable", urgency: "immediate", title, body: newLines.join("\n"), createdAt: now.toISOString(),
    });
    markNotificationDelivered(db, summaryId, "fallback", now);
    writeOutageNotice(null);
    // 推送只带这一次新来的事。
    const pushed = [`${title}：`, ...newLines.map((line, index) => `${index + 1}. ${line}`)].join("\n");
    broadcast({ type: "notice", text: `[通知] ${title}` });
    aishNotify(`⏰ ${pushed}`);
    if (clientCount() === 0) notifyDesktop(title);
    log(`lead unavailable (${incapacity.reason}): summarized ${items.length} item(s) for the user`);
  }

  // Lead 又能工作了：这次停摆的通知写上恢复的时间，停摆结束。
  function closeOutage(): void {
    if (!outage) return;
    const endedAt = Date.now();
    writeOutageNotice(endedAt);
    lastOutageEndedAt = endedAt;
    outage = null;
  }

  // 用户现在方不方便（Jarvis 模式）：Lead 据此判断现在告诉他、推给他，还是等他回来。
  // 以前写成"（用户：正在看会话）"，读起来像用户在说话（2026-10-16）。现在是一条系统事件。
  // daemon 刚启动、还没有任何客户端连上时，看不出用户在不在（2026-10-19）：以前写「用户此刻不在，daemon 启动以来用户还没在线过」，
  // 15:12 Lead 请求的重启完成以后，Lead 据此回了 NO_REPLY，用户之后问了两次。现在写「未知」，并且说清不能据此不说话。
  // 有客户端连上过、但没有人在看（后台标签页、没有 chat 权限）时，照旧是「不在」。
  function userPresenceText(): string {
    if (clientCount() > 0) return "用户此刻正在看会话。";
    if (lastAttendedAt === null && !gatewayClientSeen()) {
      return `用户此刻在不在：未知。daemon ${localIso(new Date(daemonStartedAt))} 启动以后，还没有客户端连上，看不出用户在不在。`
        + "不要因此不说话：要告诉用户的事照常说。";
    }
    return lastAttendedAt === null
      ? "用户此刻不在。daemon 启动以来用户还没在线过。"
      : `用户此刻不在。最后一次在看是 ${localIso(new Date(lastAttendedAt))}。`;
  }

  // 单脑多嘴（DESIGN-GATEWAY §1）：当前回合的 aish 回帖流；delta 按来源路由，v1 paired 保持观察广播
  let aishStream: StreamHandle | null = null;
  let lastAishOrigin = loadLastAishOrigin(db); // 重启恢复投递目标（连接靠 conn 凭证自动重连，目标靠这里）

  // 一个 lead 回合。三种来源：
  // - channelTurn：用户经 paired v2 发来的消息，自带一条轮次；
  // - system：daemon 自己叫醒 lead（blocker、即时通知、心跳、整理笔记），轮次在 lead 开口时才落成；
  // - 都没有：旧版 paired（v1）和 aish 的消息，没有轮次概念。
  type RunTurnOptions = {
    aish?: { channelId: string; threadTs?: string };
    channelTurn?: ActiveChannelTurn;
    system?: SystemTurnOrigin;
    // 系统回合落成时复用这一轮（同一件事的重试只留一轮）。
    reuseTurnId?: string;
    // 这一轮把游标后面要 Lead 处理的事（tell、interrupt 级）作为系统事件交给它（工单 04）。
    deliverEvents?: true;
    // 只交这几件事（工单 07：一条到点的提醒单独一轮）。这一轮落成会话里的一轮时记下它在回应它们（lead.turn_responding）。
    respondTo?: EventRecord[];
    // 只交这几件事，不记成回应（用户本人设的跟进到点单独一轮，2026-10-28）。
    only?: EventRecord[];
  };

  // 这一轮要交给 Lead 的事件。为一条到点的提醒开的一轮只交它（还没处理完的话）；普通的一轮交别的，提醒各自单独一轮（工单 07）。
  // 普通的一轮只交排在最前面的一组（工单 10）：同一个对话里排着的外部消息，或者所有排着的系统事件。
  function eventsForRun(options: RunTurnOptions): EventRecord[] {
    const only = options.respondTo ?? options.only;
    if (only) {
      const wanted = new Set(only.map((event) => event.seq));
      return leadInput.pendingMessages().filter((event) => wanted.has(event.seq));
    }
    return leadInput.nextMessages();
  }

  // Lead 回了 NO_REPLY 的、必须告诉用户的事：系统直接在会话里写一轮（同一件事只写一次）。
  function tellUserDirectly(event: EventRecord): void {
    const payload = event.payload;
    const note = typeof payload.note === "string" ? payload.note : "";
    const trigger = payload.trigger && typeof payload.trigger === "object"
      ? String((payload.trigger as { summary?: unknown }).summary ?? "") : "";
    const name = leadDisplayName(db);
    const text = event.kind === "lead.model_switched"
      ? `${name} 的模型从 ${String(payload.from)} 换成了 ${String(payload.to)}。${typeof payload.reason === "string" && payload.reason ? `原因：${payload.reason}。` : ""}`
      : event.kind === LEAD_WAIT_EXPIRED_KIND
      ? `${name} 在等的事到了超时还没有完成：${note}`
      : `${trigger ? `${trigger}。` : ""}${note ? `（${name} 当时记下：${note}）` : ""}`;
    log(`lead stayed silent on event #${event.seq} that must be told; telling the user directly`);
    publishSystemNotice(SYSTEM_TURN_ORIGINS.fallbackNotice, text.trim() || `${name} 在等的事有了结果。`, {
      id: `turn_must_tell_${event.seq}`,
    });
  }

  // 这一次运行在 Lead 的输入里算哪一种（lead-input.ts 的记账）。
  function runKindOf(options: RunTurnOptions): Parameters<typeof leadInput.beginRun>[0] {
    if (options.deliverEvents) return "events";
    if (options.system === SYSTEM_TURN_ORIGINS.precipitate) return "internal";
    if (options.system === SYSTEM_TURN_ORIGINS.digest) return "digest";
    if (options.system === SYSTEM_TURN_ORIGINS.notification) return "notification";
    return options.system ? "events" : "user";
  }

  // Lead 的一轮失败了：问 model-failover.ts 要不要换模型。要换时记下原因，下一轮开始前换（syncLeadModel）。
  // 顶栏的技术详情里写上下一轮用哪个模型（复用 leadHealth.reclassify：只改原文，不改失败次数和开始时间）。
  // 所有模型都失败时不再换：健康状态留在降级，停摆流程（leadIncapacity）照常接手。
  function noteLeadModelFailure(error: string): void {
    if (!modelFailover) return;
    const decision = modelFailover.turnFailed(error);
    if (decision.kind === "switch") {
      pendingModelSwitch = { reason: decision.reason, restoreAt: decision.restoreAt };
      log(`lead model failover: ${decision.reason}; the next turn uses ${decision.to}`
        + (decision.restoreAt === null ? "" : ` until ${new Date(decision.restoreAt).toISOString()}`));
      leadHealth.reclassify(`${error}（${leadDisplayName(db)} 的下一轮换用 ${decision.to}）`);
    } else if (decision.kind === "exhausted") {
      log(`every Lead model failed (${decision.reason}); tried ${decision.tried.join(", ")}: no model left to switch to`);
    }
  }

  // 两轮之间换模型：上一轮定下要换的，或者限流的恢复时间到了要换回第一个。换好以后写日志，并在这一轮开头告诉 Lead。
  // 会话换不到某个模型时跳过它，换下一个。这里从不抛错：它在 runTurnNow 的 try 外面。
  async function syncLeadModel(): Promise<void> {
    if (!modelFailover || !switchLeadModel) return;
    try {
      const restored = modelFailover.restore();
      let reason = restored?.kind === "switch" ? restored.reason : pendingModelSwitch?.reason ?? "";
      const restoreAt = restored ? null : pendingModelSwitch?.restoreAt ?? null;
      const manual = !restored && pendingModelSwitch?.manual === true;
      const via = pendingModelSwitch?.via ?? "在输入框里";
      pendingModelSwitch = null;
      if (rebindLeadModel) {
        rebindLeadModel = false;
        try {
          await switchLeadModel(appliedLeadModel);
        } catch (error: any) {
          log(`lead model rebind after a provider change failed: ${error?.message ?? String(error)}`);
        }
      }
      for (let attempt = 0; attempt < modelFailover.models.length; attempt += 1) {
        const want = modelFailover.desired();
        if (want === appliedLeadModel) return;
        const from = appliedLeadModel;
        try {
          await switchLeadModel(want);
        } catch (error: any) {
          const message = String(error?.message ?? error);
          log(`lead model switch to ${want} failed: ${message}`);
          const next = modelFailover.unusable(want, message);
          if (next.kind !== "switch") {
            log(`every Lead model failed (${next.kind === "exhausted" ? next.reason : message}): staying on ${from}`);
            modelFailover.stayOn(from);
            return;
          }
          reason = next.reason;
          continue;
        }
        appliedLeadModel = want;
        leadModelName = want;
        log(`lead model switch: ${from} -> ${want} (${reason})`);
        publishLeadModel();
        const restoredFirst = want === modelFailover.models[0];
        const note = manual && restoredFirst
          ? `用户${via}把你的模型从 ${from} 换成了 ${want}。`
          : restoredFirst
          ? `${reason}，系统把你的模型从 ${from} 换回了 ${want}。`
          : `${reason ? `你的上一轮失败了：${reason}。` : ""}系统按 lead.models 的顺序把你的模型从 ${from} 换成了 ${want}。`
            + (restoreAt === null
              ? "daemon 重启前一直用这个模型。"
              : `${localIso(new Date(restoreAt))} 以后的第一轮会换回 ${modelFailover.models[0]}。`);
        // 写在这一轮之前：这一轮（用新模型跑的）的当前局面里就有它。
        // 系统换的要告诉用户（2026-10-19）：这条事件交给 Lead，并且必须说（mustTell）；Lead 不说时系统替它说（tellUserDirectly）。
        // 用户自己换的不用再告诉用户。
        recordLeadSelfEvent("model switched", () => recordLeadModelSwitched(db, {
          from, to: want, reason, restored: restoredFirst,
          restoreAt: restoreAt === null ? null : new Date(restoreAt).toISOString(), note, mustTell: !(manual && restoredFirst),
        }));
        return;
      }
    } catch (error: any) {
      log(`lead model switch failed: ${error?.message ?? String(error)}`);
    }
  }

  // 系统回合先探网络，探完才把 daemon 标成忙（发布评审 f796c1c 的 B2）：以前先标忙再探（最多 3 秒），
  // 这时来的用户消息被当成插话排进空着的 pi 的队列；探测不通，这一轮不跑，那条消息却留在队列里，
  // 后来和它的重试各送一次。现在探测期间 daemon 不忙，用户的消息自己开一轮；探完发现已经有一轮在跑，系统回合让开。
  async function runTurn(message: string, options: RunTurnOptions = {}): Promise<TurnOutcome> {
    if (options.system) {
      const skipped: TurnOutcome = { ok: false, voiced: false, systemTurnId: null };
      if (busy || systemTurnStarting || draining) return { ...skipped, deferred: true };
      systemTurnStarting = true;
      publishLeadQueue();
      let reachable = false;
      try {
        reachable = await network.check();
      } finally {
        systemTurnStarting = false;
        publishLeadQueue();
      }
      // 断网时不调模型，不灌积压的事，会话里什么都不留（DarkWake 的几秒里也一样）。
      if (!reachable) return { ...skipped, offline: true };
      if (busy || draining) return { ...skipped, deferred: true };
      // 探网络的时候要交的事已经没了（例如跟进被取消了，提醒被用户确认了）：不开这一轮。
      if (options.deliverEvents && !eventsForRun(options).length) return { ...skipped, deferred: true };
    }
    return runTurnNow(message, options);
  }

  async function runTurnNow(message: string, options: RunTurnOptions): Promise<TurnOutcome> {
    const { channelTurn } = options;
    // 正在排空（停机前）：不开新的一轮。用户的这一轮等重启后的 daemon 来答。
    if (draining) {
      if (channelTurn) holdTurnForRestart(channelTurn);
      return { ok: false, voiced: false, systemTurnId: null, deferred: true };
    }
    let settleTurn!: () => void;
    currentTurn = new Promise<void>((resolve) => { settleTurn = resolve; });
    busy = true;
    publishLeadQueue();
    // 新回合开始，上一回合遗留的插话锚（受理了但 lead 一直没再开口）作废——
    // 否则它会去接下一回合的水，把答非所问的文本挂到一条早已过去的消息下面。
    // 必须在下面两个等待之前清：等待期间 daemon 已经忙，用户发来的消息走插话，它的锚属于这一轮，要留着
    // （审查 02：以前在等完以后才清，那条插话的回答挂到别的轮次下面，它自己一直停在 steered）。
    pendingSteerSink = null;
    // Lead 的输入（工单 04）：这一次运行交给 Lead 的事和当前局面在这里记账，这一轮成功以后游标才前进。
    leadInput.beginRun(runKindOf(options));
    // 这一轮的「需要用户做什么」从空开始（wait-tools.ts）：工具返回的、交给这一轮的事件里带的，render_ui 据此检查卡片。
    turnUserActions.reset();
    // 交给这一轮、要告诉用户的事（等待的 mustTell）：Lead 一言不发时，系统替它说（见 finally）。
    let mustTell: EventRecord[] = [];
    // 扩展正在重新加载（reloadLeadExtensions）：等它做完再给模型发这一轮。
    if (extensionReload) await extensionReload;
    // 上一轮定下要换模型，或者限流的恢复时间到了：先换好模型，再给模型发这一轮。
    await syncLeadModel();
    turnStartedAt = Date.now();
    if (clientCount() > 0) lastAttendedAt = turnStartedAt;
    runningSystemOrigin = options.system ?? null;
    runOrigin = options.aish
      ? withExternalContent({ external: false, timer: null }, { via: "message", source: "aish" })
      : { external: false, timer: null };
    runToolCalls = 0;
    overflowReminded = false;
    queueNoticed = false;
    let succeeded = false;
    let offline = false;
    // 这一轮被停机前的排空中断了（restartAbort）。
    let interrupted = false;
    let outcome: TurnOutcome = { ok: false, voiced: false, systemTurnId: null };
    // 这一轮作为消息交给 Lead 的事件对应的 inbox 行。
    let deliveredInboxIds: number[] = [];
    pendingSystemOrigin = options.system ?? null;
    pendingSystemReuseTurnId = options.system ? options.reuseTurnId ?? null : null;
    pendingSystemRespondsTo = null;
    systemTurnBuffer = options.system ? { text: "", toolEvents: [] } : null;
    systemEntryThisTurn = null;
    streamingMessageText = "";
    activeTurnError = null;
    if (channelTurn) {
      activeChannelTurn = channelTurn;
      publishTurnStarted(channelTurn, "started");
    }
    if (!options.system) noteUserTurn(channelTurn?.turn.id);
    let stream: StreamHandle | null = null;
    if (options.aish && aishAdapter?.connected) {
      stream = aishAdapter.openStream(options.aish.channelId, options.aish.threadTs);
      aishStream = stream;
    }
    try {
      // 要 Lead 处理的事（tell、interrupt 级）只交给为它们开的一轮，每件事一个 <system_event>（工单 04，spec D6）。
      // 别的回合不再把积压的事逐条灌在开头：digest、record 级的事按对象合并，写在当前局面里（下面的 situation）。
      const delivered = options.deliverEvents ? leadInput.takeMessages({ events: eventsForRun(options) }) : null;
      if (delivered?.events.length) publishLeadQueue();
      deliveredInboxIds = delivered?.inboxIds ?? [];
      const deliveredEvents = delivered?.events ?? [];
      runOrigin = {
        ...withExternalEvents(runOrigin, deliveredEvents),
        timer: channelTurn ? null : userTimerOf(deliveredEvents),
      };
      for (const event of delivered?.events ?? []) {
        const action = pendingUserActionOfEvent(event);
        if (action) turnUserActions.add(action);
      }
      mustTell = (delivered?.events ?? []).filter(eventMustBeTold);
      if (options.system && options.respondTo && delivered?.events.length) pendingSystemRespondsTo = delivered.events;
      // 每轮注入当前时间（本地墙钟+偏移，非 UTC，避免 lead 误解时区）——lead 靠它把自然语言时间转结构化字段
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const clock = leadSystemEvent("clock", `当前时间：${localIso(new Date())}，时区 ${tz}`);
      let coreBlock = "";
      if (coreMemoryDirty) {
        const refresh = coreMemoryRefreshPrefix(db);
        coreBlock = refresh ? leadSystemEvent("core_memory", refresh) : "";
        coreMemoryDirty = false; // 只刷一次；无核心记忆时也复位，避免每轮空跑
      }
      // 系统回合的说明包成一条系统事件；用户的回合，调用方已经把用户的话包成 <user_message>。
      const body = options.system ? leadSystemEvent(systemEventKind(options.system), unwrapNote(message)) : message;
      const presence = leadSystemEvent("presence", userPresenceText());
      // 当前局面（spec D7）放在这一轮输入的开头，不放进系统提示（系统提示一变，整段对话的提示缓存就失效了）。
      // 整理笔记是内部回合，不给：积压的事等下一轮普通的 Lead 回合。
      const situation = options.system === SYSTEM_TURN_ORIGINS.precipitate ? "" : situationBlock();
      const full = [clock, presence, situation, coreBlock, delivered?.text ?? "", body].filter(Boolean).join("\n\n");
      // 上一次自动压缩失败了：先压缩，再调模型（recoverLeadContext）。放在取事件之后：失败时这一轮带着事件失败，
      // 游标不动，按退避再叫醒（leadWakeRetry），不会马上又开一轮、又压缩一次。
      await recoverLeadContext();
      // 用户这一轮带的图片（新的一轮、转到下一轮、自动重试、重启后再答都走这里）。
      const images = channelTurn ? leadTurnImages(channelTurn.turn.id) : [];
      if (images.length) await session.prompt(full, { images });
      else await session.prompt(full);
      // 排空中断了这一轮：pi 不一定发出 aborted 的 message_end（例如中断时工具正在执行），按被打断收尾。
      if (restartAbort) throw new Error(LEAD_RESTART_INTERRUPTED_ERROR);
      if (activeTurnError) throw new Error(activeTurnError);
      // 这次运行结束时还在 pi 队列里的输入：交出去时 pi 已经过了最后一次取队列。用户的消息转为下一轮的输入，
      // 插进来的系统事件不算交给了 Lead（工单 04）。
      takeLeftoverInputs();
      // 系统回合说了要告诉用户的话（或者改了外部状态）才落成一轮；什么都没有就不留痕迹。
      settleSystemTurnBuffer();
      // 收口的是**当前**出水口，未必是本回合开的那条：插话把出水口改接走之后，原来那条
      // 在交接当场就已经收口过了，这里结算的是最后接水的那一条。
      // （出水口也可能是插进一条无轮次回合里的 chat.v2 插话，此时 channelTurn 缺席。）
      const tail = activeChannelTurn ?? channelTurn;
      let emptyUserTurn = false;
      if (tail && tail.placement === "steer" && !tail.assistantText.trim() && tail.drewSurface !== true) {
        // 插话送到了，Lead 看过以后没有另外说话（例如只调了工具）：它的结局是 done，不是「Lead 未生成回复」。
        settleAnsweredTogether(tail, null, `插话送到了这一轮，${leadDisplayName(db)} 看过了，没有另外回答`);
      } else if (tail) {
        sealChannelTurn(tail);
        emptyUserTurn = !isSystemTurnOrigin(tail.turn.origin_kind) && shouldFailEmptyLeadTurn({
          assistantText: tail.assistantText,
          pendingModelSwitch: pendingLeadModelRestart !== null,
        });
      }
      // 交出去的插话和排队消息里还剩下的：不在 pi 的队列里（takeLeftoverInputs 取过了），送到时会话也没有报告
      // （会话不报告送到的时刻时，插话之后 Lead 一言不发就收尾了）。它们在这一轮里被看到了，结局是 done。
      // 会话报告送到、却没有 clearQueue 时不动它们：它们可能还在 pi 的队列里，下一次运行开头送到。
      if (!inputDeliveryEvents || session.clearQueue) {
        for (const input of queuedInputs.splice(0)) {
          if (input.entry !== tail) settleAnsweredTogether(input.entry, null, `插话送到了这一轮，${leadDisplayName(db)} 看过了，没有另外回答`);
        }
      }
      if (!emptyUserTurn) {
        modelFailover?.turnSucceeded();
        succeeded = true;
      }
    } catch (err: any) {
      // 系统回合失败（例如模型连不上）也要让在听的人看到：没开口的这时落成一轮，再收口为失败。
      // 用户的插话正等着接住输出时，失败不落成系统回合（和工具调用那条路一样），而是落在插话那一轮上：
      // 插话的人收到错误，那一轮也不会一直停在 steered。
      // 整理笔记是内部的事：还没有要告诉用户的话时，失败也不进会话（顶栏的健康状态会显示模型的问题）。
      // 已经说了要告诉用户的话，照常落成一轮再收口为失败，说过的话不丢。
      // 断网：系统回合还没开口时不落成一轮、不留失败卡片（不是模型的问题，网络恢复后 daemon 接着做）。
      // 错误看起来是断网时先探一次：探测通过，就是模型服务或它的代理的问题（连接被拒、被重置），
      // 按"模型服务连不上"走正常的降级、退避和兜底（发布评审 f796c1c 的 B1）。
      // 被停机前的排空中断：不是模型的问题，也不是断网。
      interrupted = restartAbort;
      let error = interrupted ? LEAD_RESTART_INTERRUPTED_ERROR : String(err?.message ?? "");
      let networkFailure = false;
      // 传输层的失败（超时、连接断开、fetch failed）也先探网络（2026-10-19 审查）：断网时不算模型的问题，不换模型。
      if (!interrupted && (classifyLeadModelError(error) === "network" || isLeadTransportFailure(error))) {
        if (await network.confirmOutage(error)) {
          networkFailure = true;
        } else {
          error = markUpstreamFailure(error);
          leadHealth.reclassify(error);
        }
      }
      // 限流或者连续溢出：下一轮换模型（spec D9）。断网和被重启打断不是模型的问题。
      if (!interrupted && !networkFailure) noteLeadModelFailure(error);
      // 被重启打断、还没落成一轮的系统回合也一样：不留失败卡片，灌进去的事下面交回 pending，下一个 daemon 接着做。
      // 上下文满了的系统回合也不留（2026-10-28）：每次按退避再试都会失败一次，顶栏的降级和停摆通知已经告诉用户。
      const quietNotes = options.system === SYSTEM_TURN_ORIGINS.precipitate && !activeChannelTurn
        && stripQuietReply(systemTurnBuffer?.text ?? "") === "";
      const contextFull = classifyLeadModelError(error) === "context";
      if (quietNotes || ((networkFailure || interrupted || contextFull) && options.system && !activeChannelTurn)) {
        pendingSystemOrigin = null;
        systemTurnBuffer = null;
        offline = networkFailure;
      }
      const failedSteer = pendingSteerSink;
      if (!pendingSteerSink) {
        settleSystemTurnBuffer({ force: true });
        materializeSystemTurn();
      } else {
        failChannelTurn(pendingSteerSink, error);
      }
      const tail = activeChannelTurn ?? channelTurn;
      if (tail && pendingLeadModelRestart) {
        sealChannelTurn(tail);
      } else if (tail) {
        failChannelTurn(tail, error);
      }
      // pi 队列里还没送出去的插话和排队消息：这一轮失败了，它们没到模型。清掉，由 daemon 自己送（等那一次重试，或者给「重发」），
      // 不然下一次 prompt 会把它们再送一次（发布评审 f796c1c 的 B2）。交给这一轮的事件没有算处理完（游标不动），下一轮从原位置重读。
      const leftover = session.clearQueue?.();
      for (const text of [...(leftover?.steering ?? []), ...(leftover?.followUp ?? [])]) {
        const index = queuedInputs.findIndex((input) => input.prompt === text);
        if (index < 0) continue;
        const [input] = queuedInputs.splice(index, 1);
        if (input!.entry !== failedSteer && input!.entry !== tail) failChannelTurn(input!.entry, error);
      }
      // 会话报告送到的时刻、也能清队列时，还剩下的是送到了却没有报告的：它们跟着这一轮没有答上。
      if (inputDeliveryEvents && session.clearQueue) {
        for (const input of queuedInputs.splice(0)) {
          if (input.entry !== failedSteer && input.entry !== tail) failChannelTurn(input.entry, error);
        }
      }
      if (!offline && !interrupted) broadcastTurnError(error);
      log(offline ? `turn skipped: network unreachable (${error})`
        : interrupted ? "turn interrupted by the daemon shutdown" : `turn error: ${error}`);
    } finally {
      // materializeSystemTurn 在别的函数里赋值，TypeScript 看不到，这里按声明的类型读。
      const systemEntry = systemEntryThisTurn as ActiveChannelTurn | null;
      outcome = {
        ok: succeeded,
        // lead 在本回合的系统回合里真的说了话，才算播报过。
        voiced: Boolean(systemEntry?.assistantText.trim()),
        systemTurnId: systemEntry?.turn.id ?? null,
        ...(offline ? { offline: true as const } : {}),
      };
      systemEntryThisTurn = null;
      pendingSystemReuseTurnId = null;
      const scheduledRestart = pendingLeadModelRestart;
      pendingLeadModelRestart = null;
      // 这一轮带着要 Lead 处理的事却失败了：按退避再叫醒它，不等心跳巡检（2026-10-15 用户决定）。
      // 断网（探测确认过）不算：网络恢复时 NetworkMonitor 叫醒 Lead；网络是好的却失败，才按退避（发布评审 f796c1c 的 B1）。
      const carriedEvents = leadInput.carriesMessages();
      // 成功：交给这一轮的事和当前局面里列出的变化算处理完，游标前进。失败：游标不动，下一轮从原位置重读。
      // 被停机打断：交给这一轮的 inbox 行回到 pending，下一个 daemon 照常交给 Lead。
      // 当前局面里列出的摘要记成 digested 时带的摘要编号：这一轮在会话里的轮次；没有落成一轮（安静的摘要回合）时，
      // lead-input.ts 用这一次运行的编号。
      const runTurnId = outcome.systemTurnId ?? (activeChannelTurn ?? channelTurn)?.turn.id ?? null;
      const { digested } = leadInput.endRun(
        succeeded ? "succeeded" : interrupted ? "interrupted" : "failed",
        runTurnId ? { digestId: `turn:${runTurnId}` } : {},
      );
      // 必须告诉用户的事（2026-10-19，例如 Lead 请求的重启完成了）：这一轮成功了，Lead 却一言不发（回了 NO_REPLY）。
      // 不允许静默：系统直接在会话里说。失败的一轮不在这里：事件还在游标后面，下一轮再交给 Lead。
      if (succeeded && options.system && !outcome.voiced) {
        for (const event of mustTell) tellUserDirectly(event);
      }
      if (digested) log(`digest: ${digested} event(s) digested`);
      if (deliveredInboxIds.length) outcome.inboxIds = deliveredInboxIds;
      if (carriedEvents && !offline && !interrupted) {
        if (succeeded) {
          leadWakeRetry = null;
        } else {
          const failures = (leadWakeRetry?.failures ?? 0) + 1;
          leadWakeRetry = { at: Date.now() + Math.min(leadWakeRetryBaseMs * 2 ** (failures - 1), 5 * 60_000), failures };
        }
      }
      busy = false;
      publishLeadQueue();
      // 这一轮结束：插进来的系统事件不再找得到。会话不报告输入送到的时刻时，交出去的用户消息也一样
      // （成功时它们在这一轮里被看到了，失败时上面已经找回了还在队列里的）。会话报告时，还在 pi 队列里的
      // （会话没有 clearQueue 时）留着：pi 在下一次运行开头送它们，那时再改接。
      steeredEvents.clear();
      if (!inputDeliveryEvents) queuedInputs.length = 0;
      turnStartedAt = null;
      leadSilentSince = null;
      runningSystemOrigin = null;
      // 首次启动引导（spec R2）：用户自己的一轮（不是系统、外部消息、到点的跟进叫醒的）成功结束时，看要不要发一张建议卡。
      const userTurn = Boolean(channelTurn) && !options.system && !runOrigin.external && runOrigin.timer === null;
      void setupTracker?.afterTurn({ userTurn, succeeded })
        .catch((error) => log(`[setup] 一轮结束的检查失败：${error instanceof Error ? error.message : String(error)}`));
      // 这一轮结束：来历跟着清掉，下一轮重新算。
      runOrigin = { external: false, timer: null };
      activeChannelTurn = null;
      pendingSteerSink = null;
      pendingSystemOrigin = null;
      systemTurnBuffer = null;
      streamingMessageText = "";
      activeTurnError = null;
      aishStream = null;
      restartAbort = false;
      currentTurn = null;
      settleTurn();
      if (stream) await stream.end().catch(() => {});
      broadcast({ type: "turn_end" });
      // 这一轮跑的时候来了重新加载扩展的请求，现在 Lead 空闲了。
      applyPendingExtensionReload();
      if (scheduledRestart) {
        void supervisorRequest<MaintenanceRequest>({
          type: "request_maintenance",
          action: "restart",
          reason: scheduledRestart.reason,
        }).catch((error: any) => {
          log(`lead model restart request failed: ${error.message}`);
          // 部署闸门拒绝了这次重启（主 checkout 有没提交的代码等）：新模型要等下一次重启才生效。告诉 Lead，由它转告用户。
          if (error.code === "deploy_refused") {
            // 回答可能在 daemon 停机、关库以后才到：那时写不进去，只记日志（下一个 daemon 用的还是配置里的模型）。
            if (closing) {
              log("lead model restart refused after the daemon began to stop; not recorded");
              return;
            }
            try {
              addInbox(db, {
                dedupScope: "lead-model-restart", severity: "attention", source: "structural",
                summary: `换 ${leadDisplayName(db)} 的模型以后的重启被部署闸门拒绝，新模型要等下一次重启才生效：${error.message}`,
                payload: { inboxKind: "lead_model_restart_refused", wakeLead: true, needsUser: true },
                lossless: true,
              });
            } catch (inboxError) {
              log(`lead model restart refusal not recorded: ${inboxError instanceof Error ? inboxError.message : String(inboxError)}`);
            }
          }
        });
      }
      // Lead 空下来了：先答排着的用户消息，再处理排着的系统事件（dispatchLeadWork），最后才是整理笔记。
      setImmediate(() => {
        dispatchLeadWork();
        maybePrecipitate();
      });
    }
    return outcome;
  }

  // 这次运行成功结束时还在 pi 队列里的输入（交出去时 pi 已经过了最后一次取队列，见 queuedInputs）。
  //   · 用户的插话和排队消息：转为下一轮的输入（carryOverTurns），界面标记改为「下一轮回答」；
  //   · 插进来的系统事件：不算交给了 Lead，这一轮成功以后它们还在游标后面，再单独交一次。
  function takeLeftoverInputs(): void {
    const leftover = session.clearQueue?.();
    if (!leftover) return;
    for (const text of [...leftover.steering, ...leftover.followUp]) {
      const seqs = steeredEvents.get(text);
      if (seqs) {
        leadInput.release(seqs);
        continue;
      }
      const index = queuedInputs.findIndex((input) => input.prompt === text);
      if (index < 0) continue;
      const [input] = queuedInputs.splice(index, 1);
      if (input!.kind === "steer" && !input!.nextTurn) publishTurnStarted(input!.entry, "steered", { placement: "next_turn" });
      carryOverTurns.push({ prompt: input!.userPrompt ?? input!.prompt, entry: input!.entry });
    }
  }

  // aish 适配器（DESIGN-GATEWAY §3）。凭证来源优先级：显式 opts > 环境变量（并落盘）> 持久化凭证。
  // 落盘后 daemon 重启/自愈拉起无需再带 env 即自动重连（回应"配对过的 channel 应自动连上"）。
  // 代码里不写网关的地址（公开仓库，2026-10-30）：PLC_AISH_URL，没设时用上次存下的地址。
  let aishConf = opts.aish;
  const aishUrl = process.env.PLC_AISH_URL ?? loadAishConn(db)?.url;
  if (!aishConf && process.env.PLC_AISH_TOKEN && !aishUrl) {
    log("[aish] PLC_AISH_TOKEN is set but PLC_AISH_URL is not, and no address was saved before: not connecting.");
  } else if (!aishConf && process.env.PLC_AISH_TOKEN && aishUrl) {
    aishConf = { url: aishUrl, token: process.env.PLC_AISH_TOKEN };
    saveAishConn(db, aishConf.url, aishConf.token);
    log("[aish] credentials from env, persisted for auto-reconnect");
  } else if (!aishConf) {
    const saved = loadAishConn(db);
    if (saved) { aishConf = saved; log("[aish] credentials restored from store (auto-reconnect)"); }
  }
  // 上游已经对这个 token 回过 AUTH_FAILED：再连只会再被拒、再弹一次通知。不连，只记一行日志。
  // 换 token（env 或 plc aish forget 后重配）指纹就对不上，下次启动照常连。
  const aishAuthFailure = aishConf ? getAishAuthFailure(db, aishConf.token) : null;
  if (aishAuthFailure) {
    log(`[aish] skipped: this token failed auth at ${aishAuthFailure.at} (${aishAuthFailure.reason}).`
      + " Set a new PLC_AISH_TOKEN or run `plc aish forget`.");
    aishConf = undefined;
  }
  const aishToken = aishConf?.token;
  const aishAdapter = aishConf ? new AishAdapter({
    url: aishConf.url,
    token: aishConf.token,
    timeouts: aishConf.timeouts,
    onStatus: (l) => log(l),
    onFatal: (reason, code) => {
      // 只有 AUTH_FAILED 说明 token 本身无效。AUTH_TIMEOUT 可能只是一次慢握手，下次启动照常重试。
      if (code === "AUTH_FAILED" && aishToken) markAishAuthFailed(db, aishToken, reason);
      broadcast({
        type: "notice",
        text: `[aish] 配对失效：${reason}。daemon 不会再用这个 token 重连。更新 PLC_AISH_TOKEN 后重启 daemon，或运行 plc aish forget。`,
      });
      notifyDesktop(`aish 配对失效：${reason}`);
    },
    onApproval: (msg) => {
      // Slack 按钮点击 → 映射到 approvals 表；approval_id 是我们发起时给的 approvals.id
      const id = Number(msg.approval_id);
      const a = getApproval(db, id);
      if (!a) return;
      // 常设指令的提议不发 Slack 按钮，也不从 Slack 接决定（工单 10）。coordinator 也会拒绝，这里先拦下，不让异常冒出回调。
      if (isStandingOrderProposal(a)) {
        log(`[approval] #${id} is a standing order proposal; ignored the Slack decision from ${msg.user_id}`);
        return;
      }
      const decision = msg.decision === "decline" || msg.decision === "cancel"
        ? "reject" as const
        : msg.decision === "acceptForSession"
          ? "approve_session" as const
          : "approve" as const;
      const result = coordinator.resolveApproval({
        approvalId: id,
        decision,
        actor: { kind: "user", resolvedBy: `user via slack:${msg.user_id}` },
      });
      log(`[approval] #${id} → ${result.approval.status} via slack ${msg.user_id}`);
    },
    onEvent: (ev) => {
      const origin = { channelId: ev.channel_id, threadTs: ev.thread_ts };
      lastAishOrigin = origin;
      saveLastAishOrigin(db, origin);
      const text = leadUserMessage({
        via: "Slack", channel: "aish", sender: ev.sender.user_id, thread: `${ev.channel_id}/${ev.thread_ts ?? "-"}`,
      }, ev.text);
      // 正在停机：Slack 的消息没法存成重启后再答的轮次（回帖要原来的线程）。如实告诉发消息的人。
      if (draining) {
        void aishAdapter!.sendMessage(ev.channel_id, ev.thread_ts, `（daemon 正在重启，这条消息没有交给 ${leadDisplayName(db)}。请过一会儿再发一次。）`)
          .catch(() => {});
        return;
      }
      if (busy) {
        void steerLead(text, { originKind: "aish", userText: ev.text }).then(
          () => aishAdapter!.sendMessage(ev.channel_id, ev.thread_ts, "（lead 正在处理其他请求，你的消息已插话送达，稍后回复）").catch(() => {}),
          (err: any) => log(`aish steer error: ${err.message}`),
        );
      } else {
        void runTurn(text, { aish: origin });
      }
    },
  }) : null;
  aishAdapter?.start();
  if (aishAdapter) {
    aishNotify = (text) => {
      if (aishAdapter.connected && lastAishOrigin) {
        log(`[aish] push notice to ${lastAishOrigin.channelId}: ${text.slice(0, 80)}`);
        void aishAdapter.sendMessage(lastAishOrigin.channelId, lastAishOrigin.threadTs, text)
          .catch((e: any) => log(`[aish] notice push failed: ${e.message}`));
      } else {
        log(`[aish] notice skipped (connected=${aishAdapter.connected}, hasOrigin=${!!lastAishOrigin}): ${text.slice(0, 60)}`);
      }
    };
  }

  // 即时投递：blocker + 到点提醒（remind）。提醒虽是 attention 级，但"提醒我"的语义要求主动弹出，
  // 不能像普通 attention 那样攒批到下轮——否则用户设的提醒失去意义。
  const deliveredApprovals = new Set<number>(); // 审批投递去重（重启后重投是好事——提醒还有待批）
  const deliveringNotifications = new Set<number>();
  // 即时通知的播报状态（见下面的轮询）。通知不再 pending 时移出。
  // - 每条通知的系统回合：重试时复用，会话流里一条通知只有一轮；
  // - 没播报成功（失败或一言不发）之后的退避：下一次尝试的时间和已经失败的次数；
  // - 播报了但播完时没人在看的通知：不再播报第二遍，交给兜底投递。
  const voicingTurns = new Map<number, string>();
  const voicingRetries = new Map<number, { at: number; failures: number }>();
  const voicedUnattended = new Set<number>();
  // Lead 判断等用户回来再说的通知（它在用户不在时一言不发）：用户回来时再请它当面说。
  const heldForReturn = new Set<number>();
  const voicingRetryBaseMs = Number(process.env.PLC_NOTIFY_RETRY_BASE_MS ?? 15_000);
  // 这些 blocker 的即时通知（raiseBlocker 用 blocker:<blockerKey> 去重）。
  const blockerNotificationIds = (rows: ReturnType<typeof listInbox>): number[] => rows.flatMap((row) => {
    let key: unknown;
    try { key = (JSON.parse(row.payload || "{}") as { blockerKey?: unknown }).blockerKey; } catch { key = undefined; }
    if (typeof key !== "string") return [];
    const found = db.prepare(
      "SELECT id FROM notifications WHERE dedup_key=? AND state='pending'",
    ).get(`blocker:${key}`) as { id: number } | undefined;
    return found ? [found.id] : [];
  });
  // Lead 在会话里把这些通知说了。有人在看：记为 lead 已送达，不再播第二遍，也不兜底。
  // 没人在看：同样不再播第二遍；兜底只推桌面和 Slack，会话里不再贴一遍（一件事只出现一次）。
  const noteVoiced = (notificationIds: number[]) => {
    for (const id of notificationIds) {
      if (clientCount() > 0) markNotificationDelivered(db, id, "lead");
      else voicedUnattended.add(id);
    }
  };
  scheduledLeadAttempts.push(() => {
    const times = [...voicingRetries.values()].map((retry) => retry.at);
    if (leadWakeRetry) times.push(leadWakeRetry.at);
    return times.length ? Math.min(...times) : null;
  });
  // 工作区 TTL 清扫不跟着通知轮询每一轮都跑：TTL 是 7 天和 14 天，用不着 3 秒一次，
  // 而且清扫是同步的，耗时随工作区数量增长。启动后的第一轮清扫一次，之后每 PLC_WORKSPACE_SWEEP_MS（缺省 1 小时）一次。
  const configuredSweepMs = Number(process.env.PLC_WORKSPACE_SWEEP_MS);
  const workspaceSweepMs = Number.isFinite(configuredSweepMs) && configuredSweepMs > 0 ? configuredSweepMs : 60 * 60_000;
  let lastWorkspaceSweepAt: number | null = null;
  // 清扫释放不了的工作区：每次清扫都会再试，每个工作区只记一行日志。
  // 不按错误文本去重：快照的临时文件名是随机的，同一个失败每一次的文本都不一样。
  const loggedSweepFailures = new Set<string>();
  // 交付后自动开草稿 PR、返工后更新 PR（engine 的 auto-pull-request.ts）：每 PLC_AUTO_PR_SWEEP_MS（缺省 30 秒）看一次。
  // 要推送和调 gh，是异步的：上一轮没做完时这一轮跳过。
  const configuredAutoPrMs = Number(process.env.PLC_AUTO_PR_SWEEP_MS);
  const autoPrSweepMs = Number.isFinite(configuredAutoPrMs) && configuredAutoPrMs > 0 ? configuredAutoPrMs : 30_000;
  let lastAutoPrSweepAt = 0;
  let autoPrSweepRunning = false;
  // 一拍轮询的每一步各自接住错误（发布评审 reliability-backlog）：以前整拍只有一个 try，排在前面的一步一直出错
  // （例如一条坏了的审批让审批过期每次都抛），后面的推送和叫醒 Lead 每一拍都跑不到。
  // 每一步出错只记一行日志：同一步的同一句错误一分钟只记一次。
  const lastPollStepErrors = new Map<string, { message: string; at: number }>();
  // 「Lead 动态」和 interrupt 横幅（工单 06）：把变了的卡推出去。网关建好以后才有（见下面 controlPlane 那里）。
  // 轮询时最多 LEAD_ACTIVITY_SYNC_MS 一次：处置的变化（Lead 记处置、看过、别处已处理）没有新事件，只能这样发现。
  let syncLeadActivity: ((reason: "event" | "poll") => void) | null = null;
  // 提醒（工单 07）：调度器建好以后才有（见下面 createScheduler）。轮询每一拍调一次，提醒准时到，不等每分钟一次的 tick。
  let tickReminders: (() => void) | null = null;
  // 后台检查（.scratch/lead-watch/spec.md）：执行器建好以后才有（见下面 createWatchRunner）。轮询每一拍调一次，间隔能到 10 秒。
  let tickWatches: (() => void) | null = null;
  // 控件的数据源（.scratch/custom-views/spec.md D3）：执行器建好以后才有（见下面 createWidgetSourceRunner）。轮询每一拍调一次。
  let tickWidgetSources: (() => void) | null = null;
  // 推一次提醒（scheduler 的 onReminderPush，常设指令 reminder.fire）：scheduler 已经在事务里记下这一次（reminder.pushed）。
  // 推送路径和主人操作的提醒一样：Slack 总是推（手机上看得到）；没人在看会话，或者提醒是 interrupt 级的，再弹桌面通知。
  // 然后让客户端重取通知（「待你」托盘）。会话里的到点卡由「Lead 动态」的投影推（到点事件写进日志时马上 sync）。
  function pushReminder(push: ReminderPush): void {
    aishNotify(`${push.occasion === "repeat" ? "🔁" : "⏰"} ${push.text}`);
    if (clientCount() === 0 || push.level === "interrupt") notifyDesktop(push.text);
    publishControlEvent({ type: "snapshot.required", requiredScope: "notices", payload: { resource: "notifications" } });
    log(`reminder #${push.reminderId}: pushed (${push.occasion} ${push.attempt}/${push.planned})`);
  }
  function pollStep<T>(step: string, work: () => T): T | undefined {
    try {
      return work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      const last = lastPollStepErrors.get(step);
      if (last?.message === message && now - last.at < 60_000) return undefined;
      lastPollStepErrors.set(step, { message, at: now });
      log(`[poller] ${step} failed: ${message}`);
      return undefined;
    }
  }
  // 通道（工单 11）：外部来源的消息进事件日志，按常设指令投递成会话卡，代你行动的闸门按 09 的影子判断。
  // 外部来源的事件永远不插进 Lead 正在进行的回合（lead-input.ts 的 busyPlacement）：这里不碰 Lead 的会话。
  // 通道的凭据设置（设置页「消息通道」，slack-settings 工单 S1）：密钥先看设置页存进保险库的，再看 daemon 专用的环境变量，
  // 最后看 Keychain。设置页改了以后热重连，不用重启 daemon。
  const channelOptions = opts.channels === false ? undefined : opts.channels;
  const channelSettings = new ChannelSettings({
    db, vault, log,
    env: (name) => daemonOnlySecrets.get(name) ?? null,
    keychain: channelOptions?.keychain ?? (testDaemon ? () => null : cachedKeychainSecret),
    forgetKeychain: (names) => { for (const name of names) keychainCache.delete(name); },
    publish: () => {
      publishControlEvent({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: CHANNEL_SETTINGS_SNAPSHOT_RESOURCE } });
    },
  });
  // 首次启动引导（.scratch/onboarding）：7 项关键设置配没配好（存进 kv，网关读），准备清单卡和每轮结束时的建议卡。
  // 会话工厂不报告大脑能不能用时（测试的替身）当作能用。
  setupTracker = createSetupTracker({
    db, log,
    // 有项变了：App 重取 GET /v1/setup（首次启动页、设置页）。会话里的两种卡由 lead-activity 的比较推出去。
    onChange: () => publishControlEvent({ type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: SETUP_RESOURCE } }),
    sources: {
      brain: async () => ({ ready: brainReady ? await brainReady() : true, model: leadModelName }),
      memory: () => {
        if (!memoryControl) return null;
        const { embedding } = memoryControl.get();
        return { mode: embedding.mode, remoteBaseUrl: embedding.remote.baseUrl };
      },
      slack: () => {
        const view = channelSettings.list().find((source) => source.source === "slack");
        if (!view) return null;
        return {
          configured: view.status !== "not_configured",
          autoReply: channelPolicy(db, "slack")?.params.autoReply ?? false,
          account: view.account?.teamName ?? null,
        };
      },
      connections: () => connections.list().map((connection) => ({ key: connection.key, state: connection.state, account: connection.account })),
    },
  });
  void setupTracker.refresh().catch((error) => log(`[setup] 重算设置状态失败：${error instanceof Error ? error.message : String(error)}`));
  const startedChannels = startChannels({
    db, log, options: opts.channels, config: loadChannelsConfig(opts.dataDir, log),
    // 别人发来的消息紧不紧急，通道内核问 Lead 会话的 SmartModel（Jev 优先，LLM 兜底）。它自己记 decision_model.called。
    smartModel: () => leadSmartModel ?? null,
    // 收件判断的 LLM 兜底（issue 10）：决策模型没有配置或者失败时，同一条消息由 Lead 的便宜模型按原生提示判断。
    textModel: () => leadComplete ?? null,
    // 凭据：适配器声明的密钥（保险库、daemon 专用的环境变量、Keychain；不进 process.env），
    // 或者 connections 表的连接（channels.ts 的 channelCredentials）。
    secret: (name) => channelSettings.secret(name),
    onSourceStatus: (source, update) => channelSettings.sourceStatus(source, update),
    accessToken: (id) => connections.accessToken(id),
    // 推送加会话卡、「稍后」到点：和别的推送一样，没人在看会话时弹桌面通知，也推到 Slack 的 aish 对话。
    push: (notice) => {
      const line = `${notice.title}：${notice.body}`;
      broadcast({ type: "notice", text: `[通道] ${line}` });
      aishNotify(`💬 ${line}`);
      if (clientCount() === 0) notifyDesktop(line);
    },
    onCardsChanged: () => {
      publishControlEvent({ type: "snapshot.required", requiredScope: "chat", payload: { resource: CHANNEL_CARDS_SNAPSHOT_RESOURCE } });
    },
    // 请求 A 的候选仓库、披露署名里的主人名（凭据里取不到时用配置的）和助手名。
    // 助手名：配置的 channels.assistantName，没有时是 Lead 的名字（设置 → 身份与风格；用户 2026-10-22，以前缺省是 Fairy）。
    lookupCandidates,
    ownerName: () => plcConfig.channels?.ownerName?.trim() || null,
    assistantName: channelAssistantName,
    // 署名里助手名前面的 emoji（Lead 的形象，2026-10-28）：设置页的值 > 配置 > 缺省，每发一条消息读一次，改了以后下一条就用新的。
    assistantEmoji: () => leadAvatarSlackEmoji(db, configSlackEmoji()),
    // 交给 Lead 的请求里「代码认出的对象」：认 PR 只用明确的语法（链接、owner/repo#n）。
    pullRequestOf: (text) => findPullRequestRef(text),
    // 上下文包（统一消息事件 spec D5，工单 04）：对话摘要用记忆沉淀的同一个便宜模型；提到的 PR 用本机的 gh 只读地查
    // （测试 daemon 不查）；笔记按发信人和原话召回（NotesMemory 的 search：选了 Hindsight 时只问它，不能用时全文检索）。
    // Hindsight 的一条记忆按它的第一条来源笔记交出去，文字是 Hindsight 提取或整理的那句话。
    contextPack: {
      complete: () => leadComplete ?? null,
      objectStatus: contextObjectStatus({ gh: testDaemon ? null : localGh }),
      recallNotes: async (query, { limit }) => {
        const found = await memory.search(query, { limit });
        return [
          ...found.notes,
          ...found.memories.flatMap((recalled) => recalled.notes.slice(0, 1).map((note) => ({
            id: note.id, title: note.title, content: recalled.text, kind: note.kind,
          }))),
        ];
      },
    },
    // 交给 Lead（落地计划 B，用户 2026-10-22）：要干活、要打扰用户的消息先交给 Lead；Lead 派的子 agent 工单走 C 的派单器。
    // Lead 不能工作（leadIncapacity）时系统只按投递方式推送卡，不替 Lead 做任何事（统一消息事件工单 06）。
    lead: { dispatcher: agentTasks, available: () => leadIncapacity() === null, taken: (seq) => leadInput.taken(seq) },
    // 用户本人在通道里写给 Lead 的话（例如发给自己的私信）：按用户本人的一轮交给 Lead（acceptChannelOwnerMessage）。
    owner: (message) => acceptChannelOwnerMessage(message),
  });
  channelHub = startedChannels?.hub ?? null;
  // 外部消息卡的动作交给操作层（engine 的 ui-actions/ 的 channel_card）：页面的按钮和 Lead 代用户回复用同一个对象
  // （用户 2026-10-23）。通道在 Lead 会话之后才建好，所以在这里补上。
  if (channelHub) {
    const hub = channelHub;
    uiActionServices.channelCards = {
      actionsFor: (cardId) => {
        const card = getChannelCard(db, cardId);
        return card ? hub.actionsFor(card) : [];
      },
      act: async (cardId, action, options) => hub.cardDto(await hub.act(cardId, action, options)),
    };
    // Lead 代用户直接往一个对话里发消息、回表情，不经过卡片（用户 2026-10-23、10-26）。等你的卡跟着结束；发完给 Lead 还开着的卡自查。
    uiActionServices.channelMessages = {
      canSend: (source) => hub.canSendMessage(source),
      send: (conversationId, input) => hub.sendMessage(conversationId, input),
      react: (conversationId, input) => hub.react(conversationId, input),
      openCards: () => hub.openCards(),
    };
    // 设置 → 消息通道 → 自动代你处理的「测一条消息」：要快模型和来源的上下文（2026-10-23）。
    uiActionServices.channelPolicyTests = {
      test: (source, request) => hub.testPolicy(source, request),
      replay: (source, before, after) => hub.replayPolicy(source, before, after),
    };
    // 设置 → 消息通道 → 自动代你处理的「预演一条消息」（交接说明，issue 07）：要快模型。
    uiActionServices.channelHandbookRehearsal = { rehearse: (request) => hub.rehearseHandbook(request) };
  }
  // Lead 忙时排着的外部消息（统一消息事件 spec D6、D12，工单 10）：输入框上方的状态栏、面板和 Lead 都经过操作层的 lead_queue。
  uiActionServices.leadQueue = {
    snapshot: leadQueueSnapshot,
    moveNext: (key) => {
      if (!leadInput.promote(key)) throw new UiActionError("not_found", `${key} 现在没有排着的消息`);
      log(`lead queue: moved ${key} to the front`);
      publishLeadQueue();
      return leadQueueSnapshot();
    },
    // 移出队列：你自己处理。卡结束，和卡上的「我自己回」是同一个动作（hub 同时结束卡上排着的消息事件）；
    // 没有卡、卡已经不能「我自己回」的，直接记成处理完。Lead 不再处理它们。
    remove: async (key, by) => {
      const queued = leadInput.queuedMessages(key);
      if (!queued.length) throw new UiActionError("not_found", `${key} 现在没有排着的消息`);
      const cardIds = [...new Set(queued.map((event) => Number(event.payload.cardId)).filter((id) => Number.isSafeInteger(id) && id > 0))];
      for (const cardId of cardIds) {
        const card = getChannelCard(db, cardId);
        if (channelHub && card && channelHub.actionsFor(card).includes("reply_myself")) await channelHub.act(cardId, "reply_myself", { by });
      }
      const dispose = db.prepare(
        "UPDATE events SET disposition = 'handled', disposition_detail = ?, disposed_at = ? WHERE seq = ? AND disposition IS NULL",
      );
      for (const event of queued) {
        dispose.run(JSON.stringify({ by, action: "lead_queue.remove", cardId: event.payload.cardId ?? null }), new Date().toISOString(), event.seq);
      }
      leadInput.refresh();
      log(`lead queue: removed ${queued.length} message(s) of ${key}`);
      publishLeadQueue();
      return leadQueueSnapshot();
    },
  };
  // Lead 忙时用户排着的追问（用户 2026-10-28）：状态栏的「Steer」「×」和 Lead 都经过操作层的 follow_up。
  uiActionServices.followUps = { snapshot: followUpSnapshot, steer: steerFollowUp, cancel: cancelFollowUp };
  // 子 agent 工单的结果交回通道的 ⑦（信心模型决定代用户回复，还是交回 Lead）。登记以前结束的先留着，登记时交。
  if (channelHub) {
    const hub = channelHub;
    agentTasks.onFinished(CHANNEL_TASK_CALLBACK, (outcome) => hub.agentTaskFinished(outcome));
  }
  if (startedChannels) {
    channelSettings.attach({
      adapters: () => startedChannels.hub.registry.list(),
      reload: (source) => startedChannels.reloadChannelSource(source),
    });
  }
  // 记忆沉淀（slack-takeover 工单 07）：订阅频道里的对话整理成事实笔记（Lead 的 NotesMemory），模型是 Lead 会话的便宜模型。
  const channelMemory = startChannelMemory({
    hub: channelHub, db, notes: memory, complete: () => leadComplete ?? null, log, options: opts.channels,
  });
  // 重启时被打断的子 agent 工单：交回发起方（回调还没登记的，派单器先留着，登记时交）。
  for (const outcome of reclaimedAgentTasks) agentTasks.deliver(outcome);
  // Jev 分诊的影子模式（工单 09）：轮询每一拍看一次，问 Jev 在后台进行，不阻塞这一拍，也不改事件的级别和处置。
  // 通道消息代你行动的分类改由通道 hub 的请求 A 问（slack-takeover 工单 04），这里不再加问。
  const triageShadow = startTriageShadow({
    db, dataDir: opts.dataDir, log, options: opts.triageShadow,
    decisionModel: memoryControl ? () => memoryControl.decisionCredentials() : null,
  });
  function pollNotices(): void {
    // 审批过期 + 投递（不可逆动作的门禁，即时推送）
    pollStep("interventions", () => coordinator.expireInterventions(new Date()));
    pollStep("workspace-sweep", () => {
      const sweepNow = Date.now();
      if (lastWorkspaceSweepAt === null || sweepNow - lastWorkspaceSweepAt >= workspaceSweepMs) {
        lastWorkspaceSweepAt = sweepNow;
        const workspaceSweep = sweepWorkspaces(db, new Date(sweepNow));
        if (workspaceSweep.released) log(`workspace TTL sweep released ${workspaceSweep.released} workspace(s)`);
        if (workspaceSweep.cleaned) log(`workspace sweep removed ${workspaceSweep.cleaned} worktree(s) or checkout(s)`);
        for (const failure of workspaceSweep.failed) {
          // 孤儿目录没有工作区编号（0）：按错误文字去重。
          const key = failure.workspaceId ? String(failure.workspaceId) : failure.error;
          if (loggedSweepFailures.has(key)) continue;
          loggedSweepFailures.add(key);
          log(`workspace sweep could not handle ${failure.workspaceId ? `workspace #${failure.workspaceId}` : "an orphan"}: ${failure.error}`);
        }
      }
    });
    pollStep("auto-pull-request", () => {
      const sweepNow = Date.now();
      if (autoPrSweepRunning || sweepNow - lastAutoPrSweepAt < autoPrSweepMs) return;
      lastAutoPrSweepAt = sweepNow;
      autoPrSweepRunning = true;
      void syncAutoPullRequests(db)
        .then((sweep) => {
          for (const id of sweep.opened) log(`auto PR: opened a draft PR for item #${id}`);
          for (const id of sweep.updated) log(`auto PR: updated the PR of item #${id}`);
          for (const id of sweep.failed) log(`auto PR: failed for item #${id}`);
        })
        .catch((error: unknown) => log(`[poller] auto-pull-request failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { autoPrSweepRunning = false; });
    });
    const pollNow = Date.now();
    const attendedNow = clientCount() > 0;
    // 用户回来了（离开了至少 PRESENCE_IDLE_MS 以后又在看会话）：有在等的摘要时叫醒 Lead（spec D3，maybeWakeForDigest）。
    if (attendedNow && !attendedAtLastPoll && lastAttendedAt !== null && pollNow - lastAttendedAt >= PRESENCE_IDLE_MS) {
      userReturnedAt = new Date(pollNow);
    }
    attendedAtLastPoll = attendedNow;
    if (attendedNow) lastAttendedAt = pollNow;
    // 提醒到点、提前推送、没确认时的重复推送（工单 07）：每一拍看一次，不等每分钟一次的 tick。先于 Lead 的输入：
    // 到点事件写进日志，下面的 lead-input 一步（和事件通知）马上按级别交给 Lead。
    pollStep("reminders", () => tickReminders?.());
    // 后台检查：开始到点的检查，不等它们跑完（命令最多跑 120 秒，子代理检查交回时由 Run 结束的说明叫醒 Lead）。
    pollStep("watches", () => tickWatches?.());
    pollStep("widget sources", () => tickWidgetSources?.());
    // 在等自动重试的用户的那一轮：先于系统的唤醒，用户在等它。
    pollStep("user-retry", () => retryWaitingUserTurn(pollNow));
    // 高风险的主人操作（工单 15 第一步）：网关记下操作时写了推送用的通知。这里马上推，不经过 Lead：
    // 冒充用户的可能就是一个 child，提醒不能取决于 Lead 判断要不要说。三件事：
    //   · 会话里贴一张卡（system:owner-action，轮次编号带着事件编号和凭证编号，客户端据此画「不是我」；
    //     发出操作的那个客户端自己只显示一行记录）；
    //   · Slack 总是推（手机上看得到）；没人在看会话时再弹桌面通知；
    //   · 让客户端重取通知（收件箱里的那一行也有「不是我」）。
    // 先记已送达，再推送：记不上就不推，下一拍再来（和 lead-notices 一样，不重复推）。
    pollStep("ledger-guard", () => {
      if (pollNow - lastGuardCheckAt < (opts.ledgerGuardCheckMs ?? 60_000)) return;
      lastGuardCheckAt = pollNow;
      checkLedgerGuards();
    });
    // config.json 的核对：每 15 秒读一次。交给 Lead（tell 级），不直接推。
    pollStep("config-watch", () => {
      if (pollNow - lastConfigCheckAt < (opts.configWatchMs ?? 15_000)) return;
      lastConfigCheckAt = pollNow;
      configWatch.check();
    });
    pollStep("owner-actions", () => {
      const alerts = listNotifications(db, { state: ["pending"] }).filter((row) => isOwnerActionNotificationKind(row.kind));
      for (const alert of alerts) {
        markNotificationDelivered(db, alert.id, "fallback");
        const ref = ownerActionRefOfNotification({ kind: alert.kind, dedupKey: alert.dedup_key });
        const text = `${alert.title}\n${alert.body}`;
        // Lead 代你做的（审查 M5）：轮次编号里的凭证写 0。客户端按它判断「是不是你刚在这里点的」，代做的不是，
        // 所以发出那一轮的设备上也显示整张卡和「撤销」，不收成一行记录。
        const onBehalf = isOnBehalfOwnerActionNotification(alert);
        if (ref) publishSystemNotice(SYSTEM_TURN_ORIGINS.ownerAction, text, { id: ownerActionTurnId(ref.eventId, onBehalf ? 0 : ref.bindingId) });
        aishNotify(`🔐 ${text}\n（${onBehalf ? "「撤销」" : "「不是我」"}在 App 的收件箱和会话卡上。）`);
        if (clientCount() === 0) notifyDesktop(alert.title);
      }
      // 只记录的（扫码配对的手机做的）：不推送，会话里只贴一行记录（画布「代你操作」状态 7）。
      // 轮次编号带手机的凭证：手机自己的会话里是「你刚刚…」，别的设备上是「你在 <设备> 上…」。
      for (const event of listRecordedOwnerActions(db, { sinceSeq: ownerActionRecordCursor })) {
        ownerActionRecordCursor = event.seq;
        const credential = event.payload.credential as { bindingId?: unknown } | undefined;
        const source = event.payload.source as { deviceName?: unknown } | undefined;
        const bindingId = typeof credential?.bindingId === "number" ? credential.bindingId : null;
        if (bindingId === null) continue;
        const text = ownerActionRecordText({
          summary: String(event.payload.summary ?? ""),
          deviceName: typeof source?.deviceName === "string" && source.deviceName ? source.deviceName : "手机",
        });
        publishSystemNotice(SYSTEM_TURN_ORIGINS.ownerAction, `${text.title}\n${text.body}`, { id: ownerActionTurnId(event.eventId, bindingId) });
      }
      // 安全报警（security-alerts.ts）：同样直接推。没有「不是我」：没有发出操作的凭证。
      const security = listNotifications(db, { state: ["pending"] }).filter((row) => row.kind === SECURITY_ALERT_NOTIFICATION_KIND);
      for (const alert of security) {
        markNotificationDelivered(db, alert.id, "fallback");
        const text = `${alert.title}\n${alert.body}`;
        publishSystemNotice(SYSTEM_TURN_ORIGINS.securityAlert, text, { id: `turn_security_alert_${alert.id}` });
        aishNotify(`🔐 ${text}`);
        if (clientCount() === 0) notifyDesktop(alert.title);
      }
      if (alerts.length || security.length) {
        publishControlEvent({ type: "snapshot.required", requiredScope: "notices", payload: { resource: "notifications" } });
        log(`owner action: pushed ${alerts.length} alert(s), ${security.length} security alert(s)`);
      }
    });
    // 审批：界面照常收到它（会话里的审批卡片）。告诉用户由 Lead 来（它的 blocker 叫醒 Lead）；
    // 没人转达、离过期不远时，系统自己推，保证过期前送到。
    pollStep("approvals", () => {
      for (const a of pendingApprovals(db)) {
        if (!deliveredApprovals.has(a.id)) {
          deliveredApprovals.add(a.id);
          publishControlEvent({
            type: "approval.required", requiredScope: "approvals:respond",
            itemId: a.item_id ?? undefined,
            payload: {
              approvalId: a.id, requestedBy: a.requested_by, tool: a.tool,
              action: a.action, expiresAt: a.expires_at,
            },
          });
        }
        if (!approvalConveyed(a) && pollNow >= parseDbTime(a.expires_at) - approvalDeadlineMarginMs) pushApproval(a);
      }
    });
    // Lead 不能工作：把积压的事汇总成一条给用户。这一步出错时 incapacity 是 undefined：不知道 Lead 能不能工作，
    // 停摆卡片这一拍不动（outageStep）。
    const incapacity = pollStep("incapacity", () => leadIncapacity(pollNow));
    pollStep("outage", () => {
      const step = outageStep({
        incapacity, outage, leadOnline: () => leadHealth.status().state === "online",
        now: pollNow, daemonStartedAt, graceMs: leadDownGraceMs,
      });
      if (step === "summarize" && incapacity) summarizeBacklogForUser(incapacity);
      else if (step === "close") closeOutage();
    });

    // 和时间有关的一步：Lead 给自己设的跟进到点了，记成到点事件（timer.fired），交给 Lead（工单 04）。
    pollStep("follow-ups", () => recordDueLeadFollowUps(db, new Date(pollNow)));
    // Lead 的等待（2026-10-19，store 的 lead-waits.ts）：到了超时还没等到的，记一条 lead.wait_expired 交给 Lead；
    // 了结超过 7 天的行清理掉。
    pollStep("lead-waits", () => {
      expireLeadWaits(db, new Date(pollNow));
      purgeLeadWaits(db, new Date(pollNow));
    });
    // 事件写入时 daemon 马上知道（subscribeCommittedEvents），这一步只做两件兜底的事：
    //   · 别的连接写进库的事件（另一个进程、测试自己打开的连接）进程内收不到通知，在这里发现；
    //   · 和时间有关的叫醒：带着事的那一轮失败以后退避到点、摘要的间隔到了。
    // 它排在播报通知前面：blocker 和它的即时通知一起到时，先开处理 blocker 的那一轮，Lead 在那一轮里说了，
    // 通知就算送到（noteVoiced），不再单独播一遍。
    pollStep("lead-input", () => {
      flushCommittedEvents(db);
      dispatchLeadWork();
    });
    // 设置状态（首次启动引导）：节流到 5 秒重算一次；变了的卡由下一次 lead-activity 的比较推出去。
    pollStep("setup-status", () => { void setupTracker?.refreshThrottled(new Date(pollNow)); });
    pollStep("lead-activity", () => syncLeadActivity?.("poll"));
    pollStep("queue-notice", () => noticeQueue(pollNow));
    // 用户通知（spec §4）：lead 表达，系统保证。这里只把 immediate 通知交给 lead 去播报，
    // 播报成功才标 delivered_via='lead'。lead 没播（挂了、卡住、判断失误）就一直停在
    // pending，由 scheduler 第 4 步在 PLC_NOTIFY_FALLBACK_MS 之后兜底直推并标 'fallback'。
    // 在这里就直接广播等于取消了兜底闸门，也让 delivered_via 失去"lead 在漏播"的可观测性。
    // Lead 用 notify_user 写的通知：它在自己的那一轮里已经说过了，不再请它播报一遍。
    // 有人在看：那一轮就是送达。没人在看：马上推到桌面和 Slack，不等兜底窗口。
    pollStep("lead-notices", () => {
      for (const notice of listNotifications(db, { state: ["pending"] }).filter((row) => row.kind === "lead_notice")) {
        if (clientCount() > 0) {
          markNotificationDelivered(db, notice.id, "lead");
          continue;
        }
        // 先记已送达，再推送：记不上（库被锁、磁盘满）就不推，下一拍再来。反过来的话，记账抛错时通知已经推出去了，
        // 下一拍又推一遍（发布评审：Lead 信任修复留下的一项）。
        markNotificationDelivered(db, notice.id, "fallback");
        // 转达的是审批：Slack 里带批准按钮。
        const approvalId = /^approval:(\d+):lead-notice$/.exec(notice.dedup_key ?? "")?.[1];
        const approval = approvalId ? pendingApprovals(db).find((candidate) => candidate.id === Number(approvalId)) : undefined;
        if (approval && !isStandingOrderProposal(approval) && aishAdapter?.connected && lastAishOrigin) {
          void aishAdapter.requestApproval(lastAishOrigin.channelId, lastAishOrigin.threadTs, {
            approvalId: String(approval.id), tool: approval.tool, description: `${notice.title}${notice.body ? `\n${notice.body}` : ""}`,
          }).catch((e: any) => log(`[approval] aish request failed: ${e.message}`));
        } else {
          aishNotify(`🔔 ${notice.title}`);
        }
        notifyDesktop(notice.title);
      }
    });
    // 给用户的即时通知（提醒、要他登录或付费、等他验收……）：表是事实，由 Lead 决定怎样告诉用户（Jarvis 模式）。
    //   · 用户在看：请 Lead 当面说。Lead 说了、说完时还有人在看，记为 lead 已送达；没说就退避再请。
    //   · 用户不在：也马上请 Lead 判断。急的它用 notify_user 推（notification_ids 关联，算送达）；
    //     它在会话里说了，等用户回来时记为送达；它判断等用户回来再说（一言不发），用户回来时再请它当面说。
    // 系统不再按计时器兜底推送；只有 Lead 不能工作时，这些通知进兜底的汇总（summarizeBacklogForUser）。
    pollStep("notifications", () => {
      const attended = clientCount() > 0;
      if (attended) {
        for (const id of voicedUnattended) markNotificationDelivered(db, id, "lead");
        voicedUnattended.clear();
        heldForReturn.clear();
      }
      const pendingNotes = listNotifications(db, { state: ["pending"], urgency: "immediate" })
        .filter((notification) => !isDirectPushNotification(notification.kind));
      const pendingNoteIds = new Set(pendingNotes.map((notification) => notification.id));
      for (const map of [voicingTurns, voicingRetries]) for (const id of map.keys()) if (!pendingNoteIds.has(id)) map.delete(id);
      for (const set of [voicedUnattended, heldForReturn]) for (const id of set) if (!pendingNoteIds.has(id)) set.delete(id);
      const dueNotes = pendingNotes.filter((notification) => !deliveringNotifications.has(notification.id)
        && !voicedUnattended.has(notification.id)
        && !heldForReturn.has(notification.id)
        && (voicingRetries.get(notification.id)?.at ?? 0) <= pollNow);
      // 一次只播一组：已经有一轮的通知只和同一轮的通知一起播，还没有一轮的通知另成一组。
      // 这样一条通知从第一次落成一轮起就固定在那一轮里，会话流里一条通知最多一轮。
      const reuseTurnId = dueNotes.length ? voicingTurns.get(dueNotes[0]!.id) : undefined;
      const userNotes = dueNotes.filter((notification) => voicingTurns.get(notification.id) === reuseTurnId);
      // lead 正忙时不往当前回合里塞 followUp：那只是排进队列，等它空下来再开一轮。
      if (userNotes.length && !busy && !draining && !incapacity && network.online) {
        for (const notification of userNotes) deliveringNotifications.add(notification.id);
        const listed = userNotes.map((n) => `- [#${n.id}] ${n.title}${n.body ? `：${n.body}` : ""}`);
        const noteText = attended
          ? ["以下是必须立即告知用户的系统通知，他现在正在看会话。请清楚播报事实与影响，不得省略或只说已知悉：", ...listed].join("\n")
          : [
            "以下是给用户的通知，他现在不在会话里。由你决定怎样告诉他：",
            "他必须马上知道的（他自己设的提醒到点、要他登录或付费、要他审批、要他做决定），用 notify_user 推给他，"
              + "notification_ids 填这些通知的编号；不急的等他回来再说，这时只回复 NO_REPLY。",
            ...listed,
          ].join("\n");
        void runTurn(noteText, {
          system: SYSTEM_TURN_ORIGINS.notification,
          ...(reuseTurnId ? { reuseTurnId } : {}),
        }).then((outcome) => {
          const voiced = outcome.ok && outcome.voiced;
          const heard = voiced && clientCount() > 0;
          for (const notification of userNotes) {
            if (outcome.systemTurnId && !voicingTurns.has(notification.id)) voicingTurns.set(notification.id, outcome.systemTurnId);
            // Lead 用 notify_user 转达了：已经送达。
            if (getNotification(db, notification.id)?.state !== "pending") continue;
            if (heard) {
              markNotificationDelivered(db, notification.id, "lead");
            } else if (voiced) {
              voicedUnattended.add(notification.id);
            } else if (outcome.ok && !attended) {
              heldForReturn.add(notification.id);
            } else if (outcome.deferred || outcome.offline) {
              // 这次没开（有一轮在跑，或者断网）：不算播报失败，下一次轮询再请 Lead。
            } else {
              const failures = (voicingRetries.get(notification.id)?.failures ?? 0) + 1;
              const delay = Math.min(voicingRetryBaseMs * 2 ** (failures - 1), 5 * 60_000);
              voicingRetries.set(notification.id, { at: Date.now() + delay, failures });
            }
          }
        }).finally(() => {
          for (const notification of userNotes) deliveringNotifications.delete(notification.id);
        });
      }
    });
    // Jev 分诊的影子模式（工单 09）：只记录 Jev 的判断，不改事件的级别和处置。
    pollStep("triage-shadow", () => triageShadow?.tick());
    // 通道（工单 11）：闸门判断、「稍后」到点、没发成的回复。在后台跑，不阻塞这一拍。
    pollStep("channels", () => { void channelHub?.tick(); });
    // 记忆沉淀（工单 07）：整理攒够了的对话。在后台跑，不阻塞这一拍。
    pollStep("channel-memory", () => { void channelMemory?.tick(); });
  }

  // ── 排着的外部消息的推送（工单 10）────────────────────────────────────────────────────
  // Lead 开始、结束一轮，消息进来、交给 Lead、移出队列、换了顺序时推一份新的（snapshot.required，带着整份快照，
  // 只发给声明了 include=lead_queue 的连接）。合并 100 毫秒内的变化再比，和上一次推的一样就不推：推送会落库。
  // 探网络、准备开系统回合的那一会儿也算忙：这一轮结束到下一轮开始之间，状态栏不闪。
  function leadQueueSnapshot(): LeadQueue {
    return { busy: busy || systemTurnStarting, entries: leadInput.queue() };
  }
  function publishLeadQueue(): void {
    if (leadQueueTimer || leadQueueStopped) return;
    leadQueueTimer = setNodeTimeout(() => {
      leadQueueTimer = null;
      try {
        const queue = leadQueueSnapshot();
        // 没有排着的消息时状态栏不显示，忙不忙都一样：不为每一轮的开始和结束各推一次。
        const key = queue.entries.length ? JSON.stringify(queue) : "[]";
        if (key === leadQueueSent) return;
        leadQueueSent = key;
        publishControlEvent({ type: "snapshot.required", requiredScope: "chat", payload: { resource: LEAD_QUEUE_RESOURCE, queue } });
      } catch (error) {
        log(`lead queue: could not publish: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 100);
    leadQueueTimer.unref();
  }

  // ── Lead 的输入：叫醒、插话、排队（工单 04，spec D6）──────────────────────────────────
  // Lead 空着时该做什么。事件写入时、每次轮询、每一轮结束、网络恢复时调用。顺序：
  //   1. 用户的消息：上一轮剩下的（赶不上的插话、交给 pi 时已经晚了的排队消息），然后是在等自动重试的；
  //   2. 要 Lead 处理的系统事件（tell、interrupt 级）：单独开一轮。带着事的上一轮失败了，按退避到点再叫；
  //   3. 按批的摘要（digest 级）：digestBatch 说该叫醒时，开一轮摘要（system:digest）。
  // Lead 正忙时只做一件事：interrupt 级的事插进这一轮（外部来源除外，lead-input.ts 的 busyPlacement）；
  // 其余的排队，等这一轮（和用户排队的消息）答完。
  function dispatchLeadWork(): void {
    if (draining) return;
    if (busy) {
      steerInterrupts();
      return;
    }
    if (systemTurnStarting) return;
    const carried = carryOverTurns.shift();
    if (carried) {
      log(`answering queued user message ${carried.entry.turn.id} in a turn of its own`);
      startQueuedTurn(db, carried.entry.turn.id);
      const { turn, commandId } = carried.entry;
      void runTurn(carried.prompt, { channelTurn: { turn, assistantText: "", ...(commandId ? { commandId } : {}) } });
      return;
    }
    retryWaitingUserTurn();
    if (busy || !network.online) return;
    if (leadInput.pendingMessages().length && !(leadWakeRetry && leadWakeRetry.at > Date.now())) {
      wakeForEvents();
      return;
    }
    maybeWakeForDigest();
  }

  const EVENT_WAKE_TEXT = "（系统检测到新的异常、完成的工作或要你决定的事，上面是它们的说明（带 # 编号，以及 Run 号、影响、下一步、根因和证据）。"
    + "请现在就处理：要看工单当前的完整状态和根因，用 get_ticket_status，"
    + "能自己处理的直接处理（例如用 recover_ticket_run 换模型、换 runtime 或带着新指令再跑）。"
    + "然后决定怎样告诉用户：他在看会话就用一两句话说清发生了什么、你做了什么；他不在、而且需要他行动或者他必须马上知道"
    + "（登录、付费、审批、需求和产品决定、你处理不了的异常），用 notify_user 推给他，说清原因、影响和要他做什么；"
    + "不急的等他回来再说。想过一会儿再看，用 follow_up 给自己设跟进。用 record_disposition 记下每件事你是怎么处置的。"
    + "不要只回复已知悉，也不要另建重复工单。）";

  const REMINDER_WAKE_TEXT = "（一条提醒到点了，上面是它和卡片现在的状态。系统已经准时推送给用户，会话里已经有到点卡。"
    + "按上面的规则处理：用户已确认时一般不说话，回复 NO_REPLY；没确认时补一句有用的话，不要重复提醒的内容；"
    + "关联了要查的事，先查，再把结果写到卡上。不要用 notify_user 再推一遍。你这一轮说的话显示在提醒卡下面。）";

  // 要 Lead 处理的事单独开一轮（spec D6 的 tell 级）。交给 Lead 的事在 runTurnNow 开头才取：探网络的这段时间里
  // 又来的事一起交。
  function wakeForEvents(): void {
    // 到点的提醒先处理，一条一轮（工单 07）：这一轮说的话挂在提醒卡下面，不和别的事混在一个气泡里。
    const reminder = leadInput.pendingMessages().find(isReminderFireEvent);
    if (reminder) {
      log(`reminder: waking lead for event #${reminder.seq}${leadWakeRetry ? " (retry)" : ""}`);
      void runTurn(REMINDER_WAKE_TEXT, { system: SYSTEM_TURN_ORIGINS.reminder, deliverEvents: true, respondTo: [reminder] });
      return;
    }
    // 用户本人设的跟进到点也单独一轮（2026-10-28）：只有它的一轮才算用户的一轮（userTimerOf），和别的事一起交时，
    // 那一轮只有 Lead 自己的权限，设下一次跟进也不再算用户的。
    const userTimer = leadInput.pendingMessages().find(isUserFollowUpFire);
    const only = userTimer ? { only: [userTimer] } : {};
    log(`system event: waking lead (${userTimer ? `the user's follow-up #${userTimer.seq}` : `${leadInput.pendingMessages().length} event(s)`}`
      + `${leadWakeRetry ? ", retry" : ""})`);
    void runTurn(EVENT_WAKE_TEXT, { system: SYSTEM_TURN_ORIGINS.blocker, deliverEvents: true, ...only }).then((outcome) => {
      if (!outcome.ok || !outcome.voiced || !outcome.inboxIds?.length) return;
      const ids = new Set(outcome.inboxIds);
      noteVoiced(blockerNotificationIds(listInbox(db).filter((row) => ids.has(row.id))));
    });
  }

  // 外部来源交来的事件：通道 hub 的事（channel.*），外部来源登记的事件（例如连接），和带外部标记的消息事件
  // （统一消息事件 spec D1：来源是 system，正文是别人写的）。它们带着别人写的话。
  function isExternalEvent(event: EventRecord): boolean {
    return event.kind.startsWith("channel.") || !(EVENT_SOURCES as readonly string[]).includes(event.source)
      || event.payload.external === true;
  }

  // 交给这一轮的外部事件：这一轮算外部的一轮，记下是哪个来源的消息（turn-origin.ts）。消息事件（message.received）和
  // 通道 hub 的事件记成 system：消息事件的来源在 payload.source（例如 slack），通道 hub 的事件取对象键的前缀
  // （slack:@U123 的 slack）。外部来源登记的事件就是 event.source。外部来源的定时器到点（timer.fired 带 external，spec D16）
  // 也算：来源在 payload.source。事件的编号记进 externalEvents，设定时器时据此记下是谁要求的。
  function withExternalEvents(origin: LeadTurnOrigin, events: readonly EventRecord[]): LeadTurnOrigin {
    return events.filter(isExternalEvent).reduce((next, event) => {
      const named = typeof event.payload.source === "string" && event.payload.source ? event.payload.source : null;
      const source = named
        ?? (event.kind.startsWith("channel.") ? /^([a-z][a-z0-9_-]*):/u.exec(event.entityKey)?.[1] ?? event.kind : event.source);
      const marked = withExternalContent(next, { via: "message", source });
      return { ...marked, externalEvents: [...(marked.externalEvents ?? []), event.seq] };
    }, origin);
  }

  // 用户本人设的跟进到点（timer.fired 带 setByUser）。
  function isUserFollowUpFire(event: EventRecord): boolean {
    return event.kind === "timer.fired" && event.payload.setByUser === true;
  }

  // 只为用户本人设的跟进开的一轮：交给这一轮的事全是这种跟进到点（timer.fired 带 setByUser），取第一条的 inbox 编号。
  function userTimerOf(events: readonly EventRecord[]): number | null {
    if (!events.length || !events.every(isUserFollowUpFire)) return null;
    const inboxId = Number(events[0]!.payload.inboxId);
    return Number.isSafeInteger(inboxId) ? inboxId : null;
  }

  // 超预算转派（lead-tools-and-routing spec D7）：就地做的一轮，顶层的工具调用次数或时长超过阈值时，插一条提醒，
  // 请 Lead 把剩下的交给轻子 agent。每一轮只提醒一次；排空时不插。codemode 脚本里的嵌套调用不算次数。
  function remindOnOverflow(): void {
    runToolCalls += 1;
    if (overflowReminded || draining || turnStartedAt === null) return;
    const state = { toolCalls: runToolCalls, startedAt: turnStartedAt };
    const now = Date.now();
    const reason = overflowReached(state, now, overflowLimits());
    if (!reason) return;
    overflowReminded = true;
    log(`lead overflow: ${reason} (${runToolCalls} tool calls), reminding Lead to hand the rest to a sub-agent`);
    const usage = currentContextUsage();
    const extra = { context: usage ? contextUsageLine(usage) : null, waiting: waitingText(waitingConversations(now)) };
    session.steer(overflowReminder(state, now, reason, extra)).catch((error: any) => {
      log(`overflow reminder failed: ${error?.message ?? String(error)}`);
    });
  }

  // 排着队的外部消息，按对话：谁、在哪、几条、排了多久（lead-input.ts 的 queue，和状态栏同一份）。
  function waitingConversations(now: number): WaitingConversation[] {
    return leadInput.queue().map((entry) => ({
      who: entry.senders.join("、") || entry.conversation, conversation: entry.conversation, count: entry.count,
      waitedMs: Math.max(0, now - Date.parse(entry.firstAt)),
    }));
  }

  // 代价信号（lead-self-routing spec C 第 3 条）：Lead 在一轮里时，一条外部消息排队超过 PLC_LEAD_QUEUE_NOTICE_MS（缺省 5 分钟），
  // 插一条说明，告诉它谁在等、等了多久。同一轮只插一次；是信息，不停下这一轮。2026-10-28：Lead 在主会话里发评审时，
  // 两条 Slack 消息排着队，它不知道。
  function noticeQueue(now: number): void {
    if (queueNoticed || draining || !busy || turnStartedAt === null) return;
    const threshold = queueNoticeMs();
    const waiting = waitingConversations(now).filter((entry) => entry.waitedMs >= threshold);
    if (!waiting.length) return;
    queueNoticed = true;
    log(`lead queue: ${waiting.length} conversation(s) waited over ${Math.round(threshold / 1_000)}s, telling Lead in the running turn`);
    session.steer(queueNotice(waiting)).catch((error: any) => {
      log(`queue notice failed: ${error?.message ?? String(error)}`);
    });
  }

  // Lead 正在跑一轮时到达的 interrupt 级事件：插进这一轮（pi 的 steer，在当前这批工具调用结束后加进去）。
  // 这次运行结束时它还在 pi 的队列里，就不算交给了 Lead（takeLeftoverInputs），之后单独一轮再交。
  function steerInterrupts(): void {
    if (draining || !leadInput.runKind()) return;
    const events = leadInput.pendingInterrupts({ origin: runningSystemOrigin });
    if (!events.length) return;
    const taken = leadInput.takeMessages({ events, steered: true });
    // 插进来的事也算这一轮的输入：带外部原文的，这一轮算读过外部原文；不再是只为用户的跟进开的一轮。
    runOrigin = withExternalEvents(runOrigin, taken.events);
    if (taken.events.length) runOrigin = { ...runOrigin, timer: null };
    const text = [
      leadSystemEvent("system", "紧急：下面的事插进了你正在做的这一轮。先看它，再接着做原来的事。", { topic: "interrupt" }),
      taken.text,
    ].join("\n");
    const seqs = taken.events.map((event) => event.seq);
    steeredEvents.set(text, seqs);
    log(`system event: steering ${seqs.length} urgent event(s) into the running turn`);
    session.steer(text).catch((error: any) => {
      steeredEvents.delete(text);
      leadInput.release(seqs);
      log(`steering urgent events failed: ${error?.message ?? String(error)}`);
    });
  }

  // 一拍出错（库被锁、磁盘满、某条记录坏了）不能让 daemon 退出：定时器回调里的异常没人接住，进程就没了，
  // 重启以后同样的错再来一遍（发布评审）。每一步已经各自接住错误（pollStep），这里是最后一道兜底。
  // 记一行日志，下一拍照常。同一句错误一分钟只记一次。
  let lastPollError: { message: string; at: number } | null = null;
  const poller = setNodeInterval(() => {
    try {
      pollNotices();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      if (lastPollError?.message === message && now - lastPollError.at < 60_000) return;
      lastPollError = { message, at: now };
      log(`[poller] tick failed: ${message}`);
    }
  }, Number(process.env.PLC_NOTICE_POLL_MS ?? 3000)) as unknown as NodeJS.Timeout;
  poller.unref();

  // 看门狗每分钟一次：卡在启动的 Run 停掉重排（PLC_START_STALL_MS，缺省 5 分钟），疑似卡死的提醒（PLC_STALL_MS）。
  const watchdog = createWatchdog(db, { log });
  const wdTimer = setNodeInterval(() => watchdog.check(), 60_000) as unknown as NodeJS.Timeout;
  wdTimer.unref();

  // 时间调度器（spec §10）：Trigger 到点 → 提醒到点 → 逾期 → 兜底投递。
  // action_type='create_and_start' 的 trigger 复用 spawnItemChild（原 schedules.spawn=1）。
  // schedDeps 已在 onChildDone 之后定义（孤儿重派共用），此处直接复用。
  const scheduler = createScheduler(db, {
    onStartRun: (itemId) => { spawnItemChild(schedDeps, itemId, {}); },
    // 不再接计时兜底（spec §4 的 onFallbackNotify）：2026-10-15 起由 Lead 决定怎样告诉用户，
    // 系统只在 Lead 不能工作时兜底（poller 里的 summarizeBacklogForUser）。
    // 提醒例外（工单 07，常设指令 reminder.fire）：到点、提前、没确认时的重复推送都由 daemon 直接推，不等 Lead。
    onReminderPush: pushReminder,
    onError: (step, error: any) => log(`[scheduler] ${step} failed: ${error?.message ?? error}`),
  });
  tickReminders = () => scheduler.tickReminders();

  // 后台检查（.scratch/lead-watch/spec.md）：命令检查在 Lead 的 bash 沙箱里跑（同一份 policy、同一个临时目录）；
  // 子代理检查建一张轻工单再派发，和 create_task(light=true) + spawn_child 一样。派发失败时取消这张工单，不让它留在 ready。
  const leadScratch = leadScratchDir(opts.dataDir);
  mkdirSync(leadScratch, { recursive: true, mode: 0o700 });
  const watchRunner = createWatchRunner(db, {
    runCommand: sandboxWatchCommand(sandboxedBashOperations(() => leadSandboxPolicy(db, opts.dataDir)), leadScratch),
    startAgentCheck: (watch, task) => {
      const itemId = createWatchLightTask(db, { dataDir: opts.dataDir, watchId: watch.id, task, agent: watchAgentChoice(watch) });
      try {
        spawnItemChild(schedDeps, itemId, {});
      } catch (error) {
        try {
          transition(db, { itemId, to: "cancelled", actor: "system", reason: `后台检查 #${watch.id} 的子 agent 没派出去` });
        } catch (cancelError: any) {
          log(`[watch] cancel #${itemId} failed: ${cancelError?.message ?? cancelError}`);
        }
        throw error;
      }
      return itemId;
    },
    onError: (step, error: any) => log(`[watch] ${step} failed: ${error?.message ?? error}`),
  });
  watchRunner.recover();
  tickWatches = () => { void watchRunner.tick(); };
  // 控件的数据源：命令在 Lead 的 bash 沙箱里跑（和后台检查同一个沙箱、同一个临时目录），不叫醒 Lead。
  // 操作层建、改数据源时也用它先跑一次（uiActionServices.widgetCommands）。
  const widgetCommands = sandboxWidgetCommand(sandboxedBashOperations(() => leadSandboxPolicy(db, opts.dataDir)), leadScratch);
  uiActionServices.widgetCommands = widgetCommands;
  const widgetSourceRunner = createWidgetSourceRunner(db, {
    runCommand: widgetCommands,
    onError: (step, error: any) => log(`[widget source] ${step} failed: ${error?.message ?? error}`),
  });
  widgetSourceRunner.recover();
  tickWidgetSources = () => { void widgetSourceRunner.tick(); };
  const schedTimer = setNodeInterval(() => {
    try { scheduler.tick(); } catch (e: any) { log(`[scheduler] tick error: ${e.message}`); }
  }, Number(process.env.PLC_SCHEDULER_MS ?? 60_000)) as unknown as NodeJS.Timeout;
  schedTimer.unref();

  // preflight（工单 05）：检查的 adapter 就是 spawnClaimedItem 执行时用的 adapter，所以检查的是同一个 profile。
  // spawnItemChild 也读它的缓存：已知会失败的目标改为排一个派发请求。
  const preflight = createRuntimePreflight(db, { runtime: (id) => childRuntimeAdapter(schedDeps, id), log });
  schedDeps.preflight = preflight;
  orchestrator = createOrchestrator(db, {
    reviewerRuntime: opts.childPi ? LOCAL_RUNTIME_ID : undefined,
    dataDir: opts.dataDir,
    // 派发 gate 查的 profile 必须就是 spawnClaimedItem 执行时用的 profile（工单 03）。
    runtimeProfile: (runtime) => childRuntimeProfile(schedDeps, runtime),
    // 核查挂起时的通知和 Lead 的 D11 托管范围用同一个判断（工单 11 复核第 2 条）：和 userActions.host 同一个函数。
    runtimeDisabledBy: (runtime) => runtimeSettings.disabledByForDelegation(runtime),
    preflight,
    // 收尾中的 Run 还占着工单：manager 的 live 表，加上 Lead 工具看管、还没收完尾的 Run。
    itemBusy: (itemId) => liveChildren().has(itemId) || runningChildren().has(itemId),
    log,
    onDispatch: (claim) => { spawnClaimedItem(schedDeps, claim); },
  });
  const orchestratorTimer = setNodeInterval(
    tickOrchestrator,
    Number(process.env.PLC_ORCHESTRATOR_MS ?? 1_000),
  ) as unknown as NodeJS.Timeout;
  orchestratorTimer.unref();
  tickOrchestrator();
  const healthRecovery = startDaemonHealthRecovery(db, schedDeps, {
    log, onRelease: () => setImmediate(tickOrchestrator),
  });

  // 按批叫醒（spec D3，工单 04、05）：「现在该不该叫醒、有哪些事」由 digestBatch 判断，缺省按常设指令 events.digest_batch
  // （最早的一条等满 25 分钟，或者用户回来了）。叫醒和把它们交给 Lead（写在当前局面里）在这里，这一轮的来源是 system:digest。
  // 这一轮成功以后，当前局面里列出的摘要记成 digested（lead-input.ts 的 endRun 调 markEventsDigested）。
  // 每一次轮询都判断一次（dispatchLeadWork）。心跳巡检照旧每 PLC_HEARTBEAT_MS（缺省 30 分钟）查一次：
  // 没有在等的摘要时，只更新「最近巡检」。
  const heartbeatMs = Number(process.env.PLC_HEARTBEAT_MS ?? 30 * 60_000);
  const digestBatch: DigestBatchPolicy = opts.digestBatch ?? defaultDigestBatch;
  let lastDigestWakeAt = Date.now();
  let userReturnedAt: Date | null = null;
  let attendedAtLastPoll = false;
  // 上一次判断时，按等待时间该叫醒的时间（顶栏的「下一次自动调用」）。
  let digestDueAt: number | null = null;
  // 摘要的那一轮失败了（模型的问题）：按退避再叫，不在每次轮询时重来。成功时清掉。
  let digestRetry: { at: number; failures: number } | null = null;
  scheduledLeadAttempts.push(() => (digestRetry && digestRetry.at > Date.now() ? digestRetry.at : digestDueAt));
  const DIGEST_WAKE_TEXT = "（摘要：上面当前局面（kind=\"situation\"）里「上一轮以后的变化」是这一批积压的事。请消化处理——需要跟进的工单用工具跟进，"
    + "纯知悉的简要记录即可。同一个根因合并进来的几件事说一次就够了。"
    + `处理完如果没有需要用户知道的事，只回复 ${QUIET_REPLY}（不写别的字），会话里不会留下这一轮；有要告诉用户的事才正常说。）`;
  function maybeWakeForDigest(options: { patrol?: boolean } = {}): void {
    if (busy || systemTurnStarting || draining || !network.online) return;
    // 带着事的那一轮刚失败过、还在退避：也等到点，不另外再调模型（发布评审 f796c1c 的 B1）。
    if (leadWakeRetry && leadWakeRetry.at > Date.now()) return;
    if (digestRetry && digestRetry.at > Date.now()) return;
    const decision = digestBatch(db, {
      now: new Date(), pending: leadInput.pendingDigest(), lastWakeAt: new Date(lastDigestWakeAt), userReturnedAt,
    });
    digestDueAt = decision.wake ? null : decision.dueAt?.getTime() ?? null;
    if (!decision.wake) {
      // 没有在等的摘要了（例如别的一轮的当前局面里列出了它们）：失败的退避也不用了。
      if (decision.dueAt === null) digestRetry = null;
      if (options.patrol && decision.dueAt === null) leadHealth.patrolled();
      return;
    }
    const previousWakeAt = lastDigestWakeAt;
    lastDigestWakeAt = Date.now();
    log(`digest: waking lead (${decision.events.length} event(s): ${decision.reason})`);
    void runTurn(DIGEST_WAKE_TEXT, { system: SYSTEM_TURN_ORIGINS.digest }).then((outcome) => {
      // 这一次没开成（断网、有一轮在跑）：不算叫醒过，网络恢复或者空下来时再叫。
      if (outcome.offline || outcome.deferred) {
        lastDigestWakeAt = previousWakeAt;
        return;
      }
      if (outcome.ok) {
        digestRetry = null;
        leadHealth.patrolled();
        return;
      }
      const failures = (digestRetry?.failures ?? 0) + 1;
      digestRetry = { at: Date.now() + Math.min(leadWakeRetryBaseMs * 2 ** (failures - 1), 5 * 60_000), failures };
    });
  }
  const heartbeat = setNodeInterval(() => {
    // 已经知道断网：不叫醒 Lead，网络恢复时 NetworkMonitor 会叫。
    if (!network.online || busy) return;
    maybeWakeForDigest({ patrol: true });
  }, heartbeatMs) as unknown as NodeJS.Timeout;
  heartbeat.unref();

  // 事件写入时马上知道（推）：事务提交以后通知（store 的 event-notify.ts）。要 Lead 处理的事据此马上叫醒它，
  // interrupt 级的插进正在跑的这一轮；其余的等按批叫醒。
  const unsubscribeEvents = subscribeCommittedEvents(db, (events) => {
    if (events.some((event) => event.level === "tell" || event.level === "interrupt")) dispatchLeadWork();
    // 排着的外部消息可能变了：进来了新消息，或者卡结束了（卡上的动作也记一条事件）。
    publishLeadQueue();
  });
  // 启动时游标后面就有的事（上一个 daemon 没处理完的、第一次建立游标时转过来的）：马上处理，不等第一次轮询。
  setImmediate(dispatchLeadWork);

  // 网关先于 plc.sock 启动，所以 plc.sock 能回答时，这个地址已经可以连。
  let gatewayUrl = "";
  let gatewayExposure: { status(): GatewayExposureStatus; stop(): Promise<void> } | null = null;
  function statusData(): DaemonLocalStatus {
    const runningItemIds = [...runningChildren().keys()];
    return {
      model: leadModelName, busy, pid: process.pid, clients: clientCount(),
      sessionId: session.sessionId,
      runningChildren: runningItemIds,
      runningItemIds,
      aish: aishAdapter ? { connected: aishAdapter.connected, bot: aishAdapter.botName ?? null } : null,
      gatewayUrl,
      gatewayExposure: gatewayExposure?.status() ?? null,
    };
  }

  // paired 平面（DESIGN-GATEWAY §2）：桌面/手机端入口
  const gatewayPlan = resolveGatewayListen(opts.gatewayPort, process.env);
  const controlPlane = createControlPlaneService(db, {
    dataDir: opts.dataDir,
    runtimeProfile: (runtime) => childRuntimeProfile(schedDeps, runtime),
    runtime: () => {
      const status = statusData();
      return {
        model: status.model,
        sessionId: status.sessionId,
        busy: status.busy,
        runningItemIds: status.runningItemIds,
        aish: status.aish,
        lead: leadHealth.status(),
      };
    },
  });
  listTicketSummaries = () => controlPlane.listItems();
  ticketSummaryOf = (id) => controlPlane.getItem(id)?.ticket;
  // 「Lead 动态」和横幅（工单 06）：digest、auto、interrupt 级的事件和常设指令的修改写进日志时，马上把变了的卡推出去
  // （spec D10：只显示的写入马上进会话，不进 Lead 的模型，不打断 Lead 正在写的回答）。
  const leadActivitySyncMs = Number(process.env.PLC_LEAD_ACTIVITY_SYNC_MS ?? 2_000);
  let lastLeadActivitySync = 0;
  let leadActivitySyncQueued = false;
  syncLeadActivity = (reason) => {
    const now = Date.now();
    if (reason === "poll" && now - lastLeadActivitySync < leadActivitySyncMs) return;
    lastLeadActivitySync = now;
    const pushed = controlPlane.syncLeadActivity((event) => publishControlEvent(event));
    if (pushed) log(`lead activity: pushed ${pushed} card update(s) (${reason})`);
  };
  const unsubscribeLeadActivity = subscribeCommittedEvents(db, (events) => {
    if (!events.some(isLeadActivityEvent) || leadActivitySyncQueued) return;
    leadActivitySyncQueued = true;
    setImmediate(() => {
      leadActivitySyncQueued = false;
      pollStep("lead-activity", () => syncLeadActivity?.("event"));
    });
  });
  const devLoopbackAutoPairOrigins = process.env.PLC_DEV === "1"
    ? ["http://localhost:8081", "http://127.0.0.1:8081"]
    : [];
  const configuredLoopbackAutoPairOrigins = (process.env.PLC_LOOPBACK_AUTO_PAIR_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const loopbackAutoPairOrigins = [...new Set([
    ...configuredLoopbackAutoPairOrigins,
    ...devLoopbackAutoPairOrigins,
  ])];
  // 用户的一句话交给 Lead（App 的输入框，以及外部通道里用户本人写给 Lead 的话，channels 的 owner）：开用户本人的一轮，
  // 按 Lead 忙不忙定新开、插话还是排队。turnId：调用方给的轮次编号（外部通道按投递编号给，同一条消息只开一轮）。
  // context：放在用户的话前面给 Lead 的说明（例如回复会发回 Slack）。
  function acceptChatMessage(
    command: Parameters<NonNullable<PairedBridge["chatV2"]>>[0], options: { turnId?: string; context?: string } = {},
  ): { mode: ChatSendMode; turnId: string } {
    // /fairyeye on|off（Lead 的形象，用户 2026-10-28）：只认 Lead 的会话里、不带图片、整条消息只有这条命令。
    // daemon 自己答，不交给 Lead、不调模型，Lead 忙着、正在停机时也马上答。这是打开矢量 FairyEye 的唯一入口。
    const fairyEye = command.itemId === undefined && !command.images?.length ? parseFairyEyeCommand(command.message) : null;
    if (fairyEye) return answerFairyEyeCommand(command, fairyEye === "on");
    const item = command.itemId === undefined ? undefined : getItem(db, command.itemId);
    if (command.itemId !== undefined && !item) {
      throw new PairedCommandError("not_found", `item #${command.itemId} not found`);
    }
    const originKind = `paired:${command.bindingKind}`;
    // 图片和这一轮一起存（同一个事务）：交给 Lead 时按轮次取（leadTurnImages）。
    const images = command.images ?? [];
    let imageIds: string[] = [];
    const turn = db.transaction(() => {
      const created = createTurn(db, {
        ...(options.turnId ? { id: options.turnId } : {}),
        originBindingId: command.bindingId,
        originKind,
        itemId: command.itemId,
        userText: command.message,
        state: busy || draining ? "queued" : "streaming",
      });
      if (images.length) imageIds = insertChatImages(db, created.id, images).map((image) => image.id);
      return created;
    })();
    const prompt = [
      options.context ? leadSystemEvent("context", options.context) : "",
      userTurnPrompt({ via: command.bindingName, channel: originKind, itemId: item?.id ?? null, message: command.message, imageIds }),
    ].filter(Boolean).join("\n");
    // 这一轮要是因为断网或临时故障没答上，自动再试一次时用同一段原文（waitToRetry）。
    userTurnPrompts.set(turn.id, prompt);

    if (draining) {
      // 正在停机：这条消息存成排队的轮次，重启后的 daemon 回答它（不插进马上要被中断的这一轮）。
      const entry: ActiveChannelTurn = { turn, assistantText: "", commandId: command.commandId };
      publishTurnStarted(entry, "queued");
      holdTurnForRestart(entry);
      return { mode: "started", turnId: turn.id };
    }

    // 交给正在跑的这一轮之前，这一轮可能刚好结束了：那时 pi 已经空了，交给它的消息要等下一次运行才送到，
    // Lead 一直空着就一直没有回答。这时开新的一轮答它（工单 04）。
    const startOwnTurn = () => {
      void runTurn(prompt, { channelTurn: { turn, assistantText: "", commandId: command.commandId } });
    };
    if (userMessagePlacement({ busy, external: runOrigin.external, followUp: command.mode === "followUp" }) === "own_turn_after") {
      // 这一轮带着外部内容（lead-tools-and-routing spec D16，user-placement.ts）：不插进去，等它结束后开一轮只属于用户的。
      holdForOwnTurn(prompt, { turn, assistantText: "", commandId: command.commandId });
      return { mode: "queued", turnId: turn.id };
    }
    if (busy && command.mode === "followUp") {
      // 用户选了「排队」（工单 04，spec D6）：Lead 答完这一轮以后再放进去，连着排队的几条一起答。
      queueMicrotask(() => {
        if (busy) queueLeadFollowUp(prompt, turn, command.commandId);
        else startOwnTurn();
      });
      return { mode: "queued", turnId: turn.id };
    }
    if (busy) {
      // 插话（缺省）：插话的轮次不只是一条记录，它接管出水口，lead 接下来说的话长在它下面。
      queueMicrotask(() => {
        if (!busy) {
          startOwnTurn();
          return;
        }
        void steerLead(prompt, turn, command.commandId).catch(() => { /* 已落 failed */ });
      });
      return { mode: "steered", turnId: turn.id };
    }

    queueMicrotask(() => {
      void runTurn(prompt, { channelTurn: { turn, assistantText: "", commandId: command.commandId } });
    });
    return { mode: "started", turnId: turn.id };
  }

  // 外部通道里用户本人写给 Lead 的话（channels 的 owner；用户 2026-10-30：Slack 里发给自己的私信「直接交给 Lead，并且只要确认是
  // 我本人，就跟 companion 的权限保持一致，只是 reply 要遵循 slack 的语法规范」）。通道的凭据认出是用户本人：适配器只把
  // 凭据里的账号本人、发在对方也是本人的私信里的话交过来。这里按那个账号的凭证（channelOwnerBinding，权限和 Companion 一样）
  // 开用户本人的一轮，回复发回那个对话（replyToChannelOwner，适配器换成来源的格式）。用户撤销了这张凭证时不收，
  // hub 照用户本人在通道里说的话处理。同一条消息（投递编号）只开一轮。
  function acceptChannelOwnerMessage(message: ChannelOwnerMessage): boolean {
    const label = channelHub?.registry.get(message.source)?.label ?? message.source;
    const binding = channelOwnerBinding(db, { subject: `${message.source}:${message.account}`, name: `${label} 私信（你自己）` });
    if (!binding) {
      log(`[channels] ${message.source}: the user's own messages to ${leadDisplayName(db)} are revoked in Settings → Devices; not handed over`);
      return false;
    }
    const turnId = message.deliveryId === null ? undefined
      : `turn_${message.source}_${createHash("sha256").update(message.deliveryId).digest("hex").slice(0, 32)}`;
    if (turnId && db.prepare("SELECT 1 FROM channel_turns WHERE id = ?").get(turnId)) return true;
    const accepted = acceptChatMessage({
      message: message.text, bindingId: binding.id, bindingKind: message.source, bindingName: binding.display_name,
      commandId: `channel:${turnId ?? message.conversation}`,
    }, {
      ...(turnId ? { turnId } : {}),
      context: `这条消息是用户本人在 ${label} 里发给自己的私信，系统凭 ${label} 的连接认出是用户本人：这一轮是用户本人的一轮，`
        + `和在 App 里说话一样。你这一轮的回复会发回那条私信，系统把 Markdown 换成 ${label} 的格式，照常用 Markdown 写，不用表格。`
        + "render_ui 的卡片只在 App 里看得到：要用户在卡上点的，说清楚去 App 里点。",
    });
    channelOwnerReplies.set(accepted.turnId, [...(channelOwnerReplies.get(accepted.turnId) ?? []), message.conversation]);
    return true;
  }

  // 用户本人写给 Lead 的话那一轮结束了：回复发回它来的对话。幂等键是轮次和对话，重试不会发两次。没发出去只记日志，回复在 App 里照样有。
  function replyToChannelOwner(turnId: string, text: string): void {
    const conversations = channelOwnerReplies.get(turnId);
    if (!conversations) return;
    channelOwnerReplies.delete(turnId);
    const hub = channelHub;
    if (!text.trim() || !hub) return;
    for (const conversation of new Set(conversations)) {
      hub.replyToOwner(conversation, text, `${turnId}:${conversation}`).catch((error: unknown) => {
        log(`[channels] could not send the reply of turn ${turnId} to ${conversation}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  const { value: paired, host: gatewayHost } = await listenWithFallback((port, host) => startPairedServer({
        db, log, controlPlane,
        // 用户控制面（spec §6.4/§8）。resumeRun 把"重新拉起进程"这件事接回 daemon——
        // user-actions 只管账，不认识运行时。
        userActions,
        // 用户对 lead 的授权：plc 和 companion 都从控制面进来，都只有用户能按到；
        // lead 没有任何工具走得到这里。
        leadTrust,
        ...(memoryControl ? { memory: memoryControl, decisionModel: memoryControl.decisionModelService() } : {}),
        runtimeSettings, uiActionServices,
        // 外部通道的凭据（设置页「消息通道」）。没有通道时缺席：路由回 503。
        ...(startedChannels ? { channelSettings } : {}),
        // 外部来源的会话卡（工单 11）：卡在通道的 hub 里。卡上的动作经操作层（uiActionServices.channelCards）。
        ...(channelHub ? { channels: { list: (limit: number) => channelHub!.listCards(limit) } } : {}),
        // Lead 的形象（设置页「身份与风格 → 形象」）：配置的 Slack 署名 emoji，和设置页的 Slack 预览（问通道 hub）。
        leadAvatar: {
          configSlackEmoji,
          previewSlackEmoji: (code) => slackEmojiPreview({
            code,
            lookup: channelHub ? (mark) => channelHub!.previewDisclosureMark(mark) : null,
            byline: () => autoReplyDisclosure(
              disclosureAssistantName(channelAssistantName()), disclosureOwnerName(plcConfig.channels?.ownerName), "",
            ).parts.byline,
          }),
        },
        connections: {
          list: () => {
            const items = connections.list();
            return { items, attention: connections.attentionCount(items) };
          },
          start: (key, input) => connections.start(key, input),
          addCustom: (serverUrl) => connections.addCustom(serverUrl),
          flowStatus: (flowId) => connections.flowStatus(flowId),
          completeCallback: (params) => connections.completeCallback(params),
          updateSettings: (key, settings) => connections.updateSettings(key, settings),
          test: (key) => connections.test(key),
          disconnect: (key) => connections.disconnect(key),
          tools: (key) => connections.toolDtos(key),
          confirmation: (id) => connections.confirmation(id),
          resolveConfirmation: (id, approve, by) => connections.resolveConfirmation(id, approve, by),
        },
        hello: () => ({ model: leadModelName, sessionId: session.sessionId, busy }),
        // paired 侧的 response/steered 由 paired-server 自行发送，这里只做路由
        chat: (message, origin) =>
          handleChatCore(leadUserMessage({ via: origin.label, channel: "paired:v1" }, message), {
            originKind: origin.label, userText: message,
          }) ? "started" : "steered",
        chatV2: (command) => acceptChatMessage(command),
        ticketMessageV2: handleTicketMessage,
        addClient: (send) => { senders.add(send); return () => senders.delete(send); },
        recheckRuntimes: (runtime) => healthRecovery.recheck({ runtime }),
      }, {
        port,
        host,
        ...(process.env.PLC_GATEWAY_HEARTBEAT_MS ? { heartbeatMs: Number(process.env.PLC_GATEWAY_HEARTBEAT_MS) } : {}),
        allowLoopbackAutoPair: loopbackAutoPairEnabled() ? true : undefined,
        loopbackAutoPairOrigins: loopbackAutoPairOrigins.length ? loopbackAutoPairOrigins : undefined,
        webRoot: opts.webRoot ?? defaultWebRoot(),
      }), gatewayPlan, log);
  publishControlEvent = paired.publish;
  gatewayChatListeners = paired.chatListenerCount;
  gatewayClientSeen = paired.clientSeenSinceStart;
  // 回调地址用网关的端口。端口通常固定是 47130；被占用时是随机端口，hub 会按新地址重新注册客户端。
  connectionsGatewayPort = paired.port;
  connections.run(opts.connections?.tickMs);
  // 本机客户端总是走 127.0.0.1（通配监听也包含它）。
  gatewayUrl = gatewayBaseUrl("127.0.0.1", paired.port);
  // 对外地址（显式配置 PLC_GATEWAY_HOST 和 PLC_GATEWAY_PORT 时），状态写进 plc.sock 的 status：
  // - 具体地址：同一个端口另开一个监听，绑不上就在后台退避重试；
  // - 通配地址：它就是主监听；绑不上时上面已经退回回环。
  if (gatewayPlan.exposeHost) {
    const listener = new ExposureListener({ host: gatewayPlan.exposeHost, port: paired.port, listen: paired.listenAlso, log });
    gatewayExposure = listener;
    await listener.start();
  } else if (isWildcardHost(gatewayPlan.primaryHost)) {
    const bound = gatewayHost === gatewayPlan.primaryHost;
    gatewayExposure = wildcardExposure(gatewayPlan.primaryHost, paired.port, bound,
      bound ? null : "cannot bind the wildcard address; listening on loopback only (see the daemon log)");
  }

  // plc.sock：本机自举和运维（0600）。plc 在这里换一个网关凭证，supervisor 用它探活和停机。
  // 聊天、事项动作、授权和重检都走网关，这里一条都没有：plc 和 companion 走同一条路。
  // 连接不算"有客户端在听"，也收不到广播。
  const server: Server = createServer((sock) => {
    clients.add(sock);
    attachJsonlReader(sock, (line) => {
      if (!line.trim()) return;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { sendTo(sock, { type: "response", success: false, error: "parse error" }); return; }
      if (!isLocalSocketCommand(raw)) {
        const { id, type } = (raw ?? {}) as { id?: unknown; type?: unknown };
        sendTo(sock, {
          type: "response", ...(typeof id === "string" ? { id } : {}), success: false,
          error: `unknown command: ${String(type)}`,
        });
        return;
      }
      const cmd = raw;
      // 账本错误（SQLITE_BUSY、磁盘满）不能让 daemon 崩溃：答给调用方，daemon 继续运行。
      try {
        handleLocalCommand(cmd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[plc.sock] ${cmd.type} failed: ${message}`);
        sendTo(sock, { type: "response", id: cmd.id, success: false, error: message });
      }
    });
    function handleLocalCommand(cmd: LocalSocketCommand): void {
      switch (cmd.type) {
        case "status": {
          sendTo(sock, { type: "response", id: cmd.id, success: true, data: statusData() });
          break;
        }
        // supervisor 停 daemon 之前先发它（见 drainLead），收到回答再发 shutdown。
        case "drain": {
          void drainLead(cmd.timeoutMs ?? leadDrainMs).then(
            (data) => sendTo(sock, { type: "response", id: cmd.id, success: true, data }),
            (error: any) => sendTo(sock, { type: "response", id: cmd.id, success: false, error: String(error?.message ?? error) }),
          );
          break;
        }
        case "shutdown": {
          sendTo(sock, { type: "response", id: cmd.id, success: true });
          void close().then(() => process.exit(0));
          break;
        }
        // 本机凭证交换：plc 在这里换一个 kind=cli 的网关凭证（CLI_CREDENTIAL_SCOPES，没有用户的决定），存进数据目录。
        // 能连上 0600 的 plc.sock 的进程（包括 child）都拿得到它。日志里只记 binding 编号，不记 token。
        case "cli_credential": {
          const name = cmd.name?.trim() || "plc";
          const { binding, accessToken } = createCliBinding(db, { name });
          log(`[plc.sock] issued a cli credential: binding #${binding.id} (${binding.display_name})`);
          const data: CliCredentialResponse = {
            accessToken,
            binding: { id: binding.id, kind: binding.kind, name: binding.display_name, scopes: bindingScopes(binding) },
            gatewayUrl,
          };
          sendTo(sock, { type: "response", id: cmd.id, success: true, data });
          break;
        }
        // plc lead use：经 daemon 写 config.json（config-watch.ts 只认 daemon 自己写下的内容）。
        case "set_lead_model": {
          try {
            const path = setLeadModelInConfig(cmd.spec, opts.dataDir);
            const models = loadLeadModelConfig(opts.dataDir).models;
            log(`[plc.sock] lead model set to ${cmd.spec} in config.json`);
            sendTo(sock, { type: "response", id: cmd.id, success: true, data: { path, models } });
          } catch (error) {
            sendTo(sock, { type: "response", id: cmd.id, success: false, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        // 临时 admin token：只在网关的内存里，几分钟后作废。plc 每次执行管理命令时换一个，不落盘。
        case "admin_token": {
          const issued = paired.issueAdminToken();
          log(`[plc.sock] issued a temporary admin token (expires ${issued.expiresAt})`);
          const data: AdminTokenResponse = { ...issued, gatewayUrl };
          sendTo(sock, { type: "response", id: cmd.id, success: true, data });
          break;
        }
      }
    }
    sock.on("close", () => { clients.delete(sock); });
    sock.on("error", () => { clients.delete(sock); });
  });

  // 0600：只有本机同一个用户能连。所在目录先收紧成 0700，listen 之后再把 socket 改成 0600（见 listenOwnerOnly）。
  await listenOwnerOnly(server, sockPath, (err) => log(`[plc.sock] server error: ${err.message}`));
  log(`listening on ${sockPath}`);

  // aish binding 登记（connected 后）
  aishAdapter?.on("connected", (msg: any) => upsertAishBinding(db, msg.bot_id, msg.bot_name));

  // paired chat 的纯路由核心：true=新回合，false=已插话
  function handleChatCore(message: string, steerOrigin: { originKind: string; userText: string }): boolean {
    if (draining) {
      // 旧版 v1 入口没有轮次：这里现建一条，存成排队的轮次，重启后的 daemon 回答它。来源记成 paired:v1：
      // v1 的 label 是 paired:<kind>:<设备名>，设备名里带 ":ticket" 时会被启动查询当成工单消息排除掉（发布评审 909e217）。
      const turn = createTurn(db, { originKind: "paired:v1", userText: steerOrigin.userText, state: "queued" });
      userTurnPrompts.set(turn.id, message);
      holdTurnForRestart({ turn, assistantText: "" });
      return true;
    }
    if (userMessagePlacement({ busy, external: runOrigin.external, followUp: false }) === "own_turn_after") {
      // 这一轮带着外部内容（lead-tools-and-routing spec D16）：等它结束后开一轮只属于用户的。
      const turn = createTurn(db, { originKind: steerOrigin.originKind, userText: steerOrigin.userText, state: "queued" });
      userTurnPrompts.set(turn.id, message);
      holdForOwnTurn(message, { turn, assistantText: "" });
      return false;
    }
    if (busy) { void steerLead(message, steerOrigin).catch((e: any) => log(`steer error: ${e.message}`)); return false; }
    void runTurn(message);
    return true;
  }

  // 停机前排空 Lead（2026-10-16 07:57：部署时 plc daemon stop 打断了建提醒 #83 的那一轮，这一轮被记成
  // 「Lead 未生成回复」，没人告诉 Lead，「重发」会再建一个提醒）。plc daemon stop、重启和升级、supervisor 停机、
  // SIGTERM、launchctl kickstart 最后都走到这里（drain 命令，或者 close）：
  //   1. 不再开新的 Lead 回合（draining）。用户的新消息存成排队的轮次（holdTurnForRestart），重启后回答；
  //   2. 等正在跑的这一轮，最多 timeoutMs（缺省 LEAD_DRAIN_TIMEOUT_MS，远小于 supervisor 等 daemon 退出的 20 秒）；
  //   3. 到时还在跑就正式中断：先 abort，等这一轮按「被重启打断」收尾，close 之后才 dispose。
  //      只 dispose 的话，pi 同时丢掉全部监听，daemon 收不到中断。
  // 只收到 drain、迟迟没收到 shutdown（例如 supervisor 中途死了）：排空在 drainExpiryMs 后作废，daemon 照常工作。
  const leadDrainMs = Number(process.env.PLC_LEAD_DRAIN_MS ?? LEAD_DRAIN_TIMEOUT_MS);
  const drainExpiryMs = Number(process.env.PLC_LEAD_DRAIN_EXPIRY_MS ?? 60_000);
  // 中断以后等这一轮收尾的时限。
  const leadAbortGraceMs = Number(process.env.PLC_LEAD_ABORT_GRACE_MS ?? 3_000);
  let drainInFlight: Promise<DaemonDrainResult> | null = null;
  let drainExpiry: NodeJS.Timeout | null = null;
  let closing: Promise<void> | null = null;

  function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  // 还没交给 Lead 的用户消息（排着等下一轮的、还在 pi 队列里的）：等重启后的 daemon 来答，不随这个进程丢掉（工单 04）。
  function holdQueuedUserInputs(): void {
    for (const carried of carryOverTurns.splice(0)) holdTurnForRestart(carried.entry);
    if (busy) return;
    for (const input of queuedInputs.splice(0)) holdTurnForRestart(input.entry);
  }

  function drainLead(timeoutMs: number): Promise<DaemonDrainResult> {
    draining = true;
    holdQueuedUserInputs();
    if (!closing) {
      if (drainExpiry) clearTimeout(drainExpiry);
      drainExpiry = setTimeout(() => {
        drainExpiry = null;
        if (closing) return;
        log("drain expired without a shutdown: Lead takes turns again");
        draining = false;
        restartAbort = false;
        retryWaitingUserTurn();
      }, drainExpiryMs);
      drainExpiry.unref();
    }
    drainInFlight ??= (async (): Promise<DaemonDrainResult> => {
      const running = currentTurn;
      if (!busy || !running) return { drained: true, interrupted: false };
      // 前一次排空已经中断了这一轮，它却还没收尾（例如一个工具不理中断信号）：不再等第二遍，直接去 dispose。
      // 再等一遍会让停机超过 supervisor 和 launchd 的 20 秒，最后被 SIGKILL（发布评审 909e217）。
      if (restartAbort) return { drained: false, interrupted: true };
      log(`drain: waiting up to ${timeoutMs}ms for the running Lead turn`);
      if (await settledWithin(running, timeoutMs)) return { drained: true, interrupted: false };
      log("drain: the Lead turn is still running; interrupting it for the restart");
      restartAbort = true;
      // 会话不能单独中断时（没有 abort），这一轮在 dispose 时结束：不在这里空等。
      if (session.abort) {
        try {
          await settledWithin(Promise.resolve(session.abort()), leadAbortGraceMs);
        } catch (error: any) {
          log(`drain: abort failed: ${error?.message ?? String(error)}`);
        }
        await settledWithin(running, leadAbortGraceMs);
      }
      return { drained: false, interrupted: true };
    })().finally(() => { drainInFlight = null; });
    return drainInFlight;
  }

  // 只停一次：SIGTERM 赶上正在进行的停机时，等同一次停机做完。
  function close(): Promise<void> {
    closing ??= closeOnce();
    return closing;
  }

  async function closeOnce(): Promise<void> {
    if (drainExpiry) clearTimeout(drainExpiry);
    leadQueueStopped = true;
    if (leadQueueTimer) clearNodeTimeout(leadQueueTimer);
    clearNodeInterval(poller); clearNodeInterval(wdTimer); clearNodeInterval(heartbeat); catalogWatch?.stop();
    // 关库之前等影子分诊这一批停下（正在进行的调用被取消），通道的传输停下、这一拍跑完。
    await triageShadow?.stop();
    modelSettings.stop();
    // 先停子 agent 工单（被打断的记成失败交回 hub），再停通道：hub 停下时要等它们的回复决定做完，然后才关库。
    await agentTasks.close();
    await stopChannels(startedChannels);
    await channelMemory?.stop();
    network.stop();
    if (livenessTimer) clearTimeout(livenessTimer);
    clearNodeInterval(schedTimer); clearNodeInterval(orchestratorTimer);
    healthRecovery.stop();
    preflight.stop();
    const drained = await drainLead(leadDrainMs);
    if (drained.interrupted) log("interrupted the running Lead turn; the next daemon continues it");
    unsubscribeEvents();
    unsubscribeLeadActivity();
    syncLeadActivity = null;
    holdQueuedUserInputs();
    aishAdapter?.stop();
    if (agentConnectionHost() === connectionHost) setAgentConnectionHost(null);
    await connections.close();
    // 正常停机不停止正在执行的 child（spec D7，工单 15）：垫片启动的 Run 分离出去，重启后的 daemon 接管它们。
    // 空闲的 child 照旧中断。没有垫片的 child 仍然等它结束。
    const detached = detachRunningChildren();
    if (detached) log(`detached ${detached} running child(ren); the next daemon adopts them`);
    killIdleChildren();
    await Promise.allSettled([...runningChildren().values()]);
    // 对话结束后的工作区检查在后台算（engine review-currency.ts），关库之前等它们算完。
    // 每个检查自己有时限（最多 30 秒）。
    await conversationWorkspaceChecksSettled();
    // Run 结束后的交付快照（engine delivery-snapshot.ts）也在后台跑，关库之前等它们。每条 git 命令自己有时限。
    await deliverySnapshotsSettled();
    // 所有 Run 都已经分离或结束。同一进程里之后启动的 Run（例如测试）照常看管，宿主退出时照常停止。
    acceptRunningChildren();
    retainChildrenOnHostExit(false);
    session.dispose?.();
    // 被中断的这一轮还在写它的记录时，等它写完再关库。pi 的 dispose 之后这一轮几毫秒内就结束。
    if (currentTurn) await settledWithin(currentTurn, 500);
    // 先关网关（断开所有 WebSocket 客户端，包括从对外地址连进来的），再停对外地址的监听：
    // 反过来的话，对外地址的监听会等它的连接自己断开，停机就卡住了。
    await paired.close();
    await gatewayExposure?.stop();
    // server.close 会等待存量连接——必须先主动断开客户端，否则与等待关闭确认的 stop 客户端死锁
    for (const c of clients) c.destroy();
    clients.clear();
    senders.clear();
    await new Promise<void>((r) => server.close(() => r()));
    if (existsSync(sockPath)) unlinkSync(sockPath);
    // 记忆同步读 notes，关库之前等它跑完。Hindsight 是独立的 launchd 任务，不跟着 daemon 停。
    memoryControl?.stop();
    stopMemorySync();
    // 关机不等推完全部笔记：正在跑的同步在这一批之后停下，剩下的下次启动再推。
    memory.stop();
    await memory.idle();
    // 回复按钮的判断写库：关库之前取消正在进行的，之后答完的轮次不再判断。
    await replyActionsJudge?.stop();
    runtimeSettings.close();
    db.close();
    ownership.release();
    log("daemon closed");
  }

  return {
    sockPath, close, pairedPort: paired.port, reloadLeadExtensions, channels: channelHub, agentTasks,
    reloadChannelSource: (source) => startedChannels?.reloadChannelSource(source) ?? Promise.reject(new Error("没有接任何外部通道")),
  };
}

// 健康恢复（工单 04）：探针通过就关闭故障（2026-10-20 去掉了金丝雀）。探针用执行时的 adapter（childRuntimeAdapter）。
// 所以探针检查的 profile 就是派发 gate 查的 profile。recheck 给 socket 命令 runtime_recheck 用。
// 有故障关闭时，onRelease 让编排器马上 claim。
function startDaemonHealthRecovery(
  db: Db,
  deps: LeadDeps,
  options: { log: (line: string) => void; onRelease: () => void },
): { recheck(cmd: { runtime?: unknown }): Promise<RecheckResult[]>; stop(): void } {
  const recovery = createHealthRecovery(db, { runtime: (id) => childRuntimeAdapter(deps, id), log: options.log });
  const loop = startHealthRecoveryLoop(recovery, {
    intervalMs: recoveryIntervalMs(),
    onRelease: options.onRelease,
    log: options.log,
  });
  return {
    async recheck(cmd) {
      const results = await recovery.recheck({ runtime: parseRecheckRuntime(cmd.runtime) });
      if (results.some((result) => result.outcome === "recovered")) options.onRelease();
      return results;
    },
    stop: () => loop.stop(),
  };
}

// 工具结果里给 Lead 看的那段文字（pi 的结果包在 { content: [{ type: "text", text }] } 里）。先遮住密钥，缩成一行。
function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  const text = Array.isArray(content)
    ? content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text as string)
      .join("\n")
    : typeof result === "string" ? result : "";
  const flat = redactSecretText(text).replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

// 系统回合在 <system_event> 里的 kind。
function systemEventKind(origin: SystemTurnOrigin): LeadSystemEventKind {
  if (origin === SYSTEM_TURN_ORIGINS.digest) return "digest";
  if (origin === SYSTEM_TURN_ORIGINS.heartbeat) return "heartbeat";
  if (origin === SYSTEM_TURN_ORIGINS.blocker) return "blocker";
  if (origin === SYSTEM_TURN_ORIGINS.notification) return "notification";
  if (origin === SYSTEM_TURN_ORIGINS.precipitate) return "precipitate";
  return "system";
}

// 系统回合的说明以前用一对全角括号标出"这是系统的话"。包进 <system_event> 以后不再需要：去掉最外面那一对。
function unwrapNote(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("（") && trimmed.endsWith("）") ? trimmed.slice(1, -1) : trimmed;
}

// 一条用户消息的文字（pi 的 message_start 里，content 是字符串或者几段文字）。pi 按同样的方式比对它和队列里的原文。
function userMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text as string)
    .join("");
}
