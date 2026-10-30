// 派单器（landing.md 第 3 节 C1，给 B 的接口）：实现 protocol 的 AgentTaskDispatcher。
//   - dispatch：算权限清单（上限 ∩ Lead 选的范围，protocol 的 computeRunGrant），在同一笔事务里建工单、建 Run、建清单、
//     写活动；再交给 runItem，runtime 是进程内的子 agent（lead 的 agent-task/：只读形态，工具都经连接中心）。立刻返回。
//   - 结束：工单按结局进 done 或 cancelled（store 的 transition，不直接改 stage）；结果交给发起方登记的回调（callback.kind），
//     不叫醒 Lead（purpose=lookup 的 Run 不经过 onChildDone，run-finished.ts 也排除了它）。
//   - cancel：停掉 Run（记成 stopped），工单进 cancelled，回调 cancelled。超时：停掉 Run（记成 failed），回调 failed。
//   - daemon 重启：被打断的 Run 记成失败，交回发起方，不重新派发（recoverAgentTasksAfterRestart）。
// 工单的标题和正文只有结构化的说明，不带对方的原话：原话只进子 agent 的提示词（包在不可信的标签里）。
// 这张工单的 Run 的 purpose 是 lookup：内核里「进程内的受限 Run，结果交给通道，不是交付」这一类。代查（lookup.ts）退役以后它只剩这一种。
import { join } from "node:path";
import { Value } from "typebox/value";
import type { Item } from "@pi-lead-child/core";
import type { ConnectionHub } from "@pi-lead-child/connections";
import { runItem, liveChildren } from "@pi-lead-child/engine";
import {
  agentTaskConnections, agentTaskPrompt, AGENT_TASK_RUNTIME_PROFILE, createAgentTaskRuntime, createLookupSessionFactory,
  type AgentTaskToolLimits, type LookupSessionFactory,
} from "@pi-lead-child/lead";
import {
  AgentTaskRequestSchema, computeRunGrant, DEFAULT_INTENT_GRANT_BOUNDS, describeRunGrant, redactSecretText,
  type AgentTaskAction, type AgentTaskDispatch, type AgentTaskDispatcher, type AgentTaskOutcome, type AgentTaskRequest,
  type GrantLocalRepo, type RunGrant,
} from "@pi-lead-child/protocol";
import { runtimeProfileHash, typedFailure } from "@pi-lead-child/runtime";
import {
  addActivity, createItem, createRun, getItem, getRun, getRunGrant, insertRunGrant, listRunWrites, replyStyleText, transition, transitionRunState,
  type Db,
} from "@pi-lead-child/store";
import { closeLookupItem } from "./lookup.js";

export const DEFAULT_AGENT_TASK_TIMEOUT_MS = 20 * 60_000;
export const AGENT_TASK_STARTED = "agent_task_started";
export const AGENT_TASK_FINISHED = "agent_task_finished";
const RESTART_MESSAGE = "daemon 重启，子 agent 被打断";
// 没有登记回调时最多留多少个结果（例如重启时找回来的，通道还没登记回调）。
const MAX_UNDELIVERED = 50;

const INTENT_WORDS: Record<AgentTaskRequest["intent"], string> = {
  code_review: "代码 review", approve: "approve PR", knowledge: "咨询", progress: "项目进度",
};

export interface DaemonAgentTaskDispatcher extends AgentTaskDispatcher {
  /** 还在跑的 Run。 */
  running(): number[];
  /** 等所有正在跑的结束。 */
  idle(): Promise<void>;
  /** daemon 停机：取消计时器，中断正在跑的并等它们收尾。 */
  close(): Promise<void>;
  /** 重启时找回来的结果：交给发起方的回调（还没登记的先留着，登记时交）。 */
  deliver(outcome: AgentTaskOutcome): void;
}

export interface AgentTaskDispatcherOptions {
  db: Db;
  dbPath: string;
  dataDir: string;
  connections: Pick<ConnectionHub, "searchTools" | "callTool" | "runReads" | "releaseRun">;
  // 本地仓库的名字解析成根目录（候选仓库）。
  resolveLocalRepo: (name: string) => GrantLocalRepo | null;
  // 用户的名字（子 agent 的提示词用）。
  ownerName: () => string | null;
  sessionFactory?: LookupSessionFactory;
  timeoutMs?: number;
  limits?: Partial<AgentTaskToolLimits>;
  maxDurationMs?: number;
  onEvent?: (itemId: number, runId: number, event: Parameters<NonNullable<Parameters<typeof runItem>[2]["onEvent"]>>[0]) => void;
  onSettled?: (itemId: number) => void;
  log?: (line: string) => void;
  now?: () => Date;
}

interface RunningTask {
  runId: number;
  itemId: number;
  callback: AgentTaskRequest["callback"];
  stop: "cancelled" | "timeout" | "shutdown" | null;
  timer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
}

const oneLine = (text: string, max: number): string => {
  const line = redactSecretText(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** 工单的标题：「<来源> <意图>：<请求者> 的请求」。不带原话。 */
export function agentTaskTitle(request: Pick<AgentTaskRequest, "intent" | "request">): string {
  const source = oneLine(request.request.source, 20) || "外部消息";
  const requester = oneLine(request.request.requester, 20) || "对方";
  return `${source} ${INTENT_WORDS[request.intent]}：${requester} 的请求`;
}

/** 这个 Run 是哪一次派单（建 Run 的那笔事务里记的 agent_task_started）：发起方的回调。 */
export function agentTaskCallbackOfRun(db: Db, runId: number): AgentTaskRequest["callback"] | null {
  const row = db.prepare(
    `SELECT json_extract(payload, '$.callback.kind') AS kind, json_extract(payload, '$.callback.ref') AS ref FROM activities
     WHERE run_id=? AND kind='decision' AND json_extract(payload, '$.decision')=? ORDER BY id LIMIT 1`,
  ).get(runId, AGENT_TASK_STARTED) as { kind: string | null; ref: string | null } | undefined;
  return row?.kind && row.ref ? { kind: row.kind, ref: row.ref } : null;
}

function writesOf(db: Db, runId: number): AgentTaskAction[] {
  return listRunWrites(db, runId).map((call) => ({
    connection: call.connection, tool: call.tool, summary: call.summary ?? `调用了 ${call.tool}`,
    target: call.target, url: call.url, visible: call.visible ?? true, at: call.createdAt,
  }));
}

function grantOf(db: Db, runId: number): RunGrant {
  return getRunGrant(db, runId)?.grant ?? { version: 1, intent: "knowledge", rules: [], localRepos: [] };
}

function recordFinished(db: Db, outcome: AgentTaskOutcome, stage: Item["stage"] | null): void {
  addActivity(db, {
    itemId: outcome.itemId, runId: outcome.runId, actor: "system", kind: "decision",
    payload: {
      decision: AGENT_TASK_FINISHED, status: outcome.status, error: outcome.error?.slice(0, 500) ?? null,
      actions: outcome.actions.map((action) => action.summary).slice(0, 20), reads: outcome.reads.length,
      refusedReads: outcome.reads.filter((read) => read.refused !== undefined).length, stage,
    },
  });
}

/**
 * daemon 启动时调用一次（在代查的恢复之前）：还在 starting、running 的子 agent Run 是上一个 daemon 的进程内会话，
 * 已经不在了：记成失败（不扣额度），工单进 cancelled，不重新派发，不叫醒 Lead。返回要交回发起方的结果。
 * 只看带清单的进程内 Run（purpose=lookup），修过的不再匹配，所以有界、幂等。
 */
export function recoverAgentTasksAfterRestart(db: Db, now: Date = new Date()): AgentTaskOutcome[] {
  const rows = db.prepare(
    `SELECT r.id FROM runs r JOIN run_grants g ON g.run_id = r.id
     WHERE r.purpose = 'lookup' AND r.state IN ('starting','running','paused') ORDER BY r.id`,
  ).all() as Array<{ id: number }>;
  const out: AgentTaskOutcome[] = [];
  for (const row of rows) {
    const outcome = db.transaction((): AgentTaskOutcome | null => {
      const run = getRun(db, row.id);
      if (!run || (run.state !== "starting" && run.state !== "running" && run.state !== "paused")) return null;
      transitionRunState(db, run.id, "failed", {
        endedAt: true, errorCode: "daemon_restart", errorMessage: RESTART_MESSAGE,
        failure: typedFailure("run_interrupted", { errorCode: "daemon_restart", message: RESTART_MESSAGE }),
      });
      const callback = agentTaskCallbackOfRun(db, run.id);
      const result: AgentTaskOutcome = {
        runId: run.id, itemId: run.item_id, callback: callback ?? { kind: "unknown", ref: "-" }, status: "failed",
        result: null, actions: writesOf(db, run.id), reads: [], error: RESTART_MESSAGE, grant: grantOf(db, run.id),
      };
      const stage = closeLookupItem(db, { itemId: run.item_id, runId: run.id, status: "failed", reason: RESTART_MESSAGE, now });
      recordFinished(db, result, stage);
      return callback ? result : null;
    }).immediate();
    if (outcome) out.push(outcome);
  }
  return out;
}

export function createAgentTaskDispatcher(options: AgentTaskDispatcherOptions): DaemonAgentTaskDispatcher {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TASK_TIMEOUT_MS;
  const sessionFactory = options.sessionFactory ?? createLookupSessionFactory({ dataDir: options.dataDir, log });
  const connections = agentTaskConnections(options.connections, db);
  const running = new Map<number, RunningTask>();
  const handlers = new Map<string, (outcome: AgentTaskOutcome) => void>();
  const undelivered: AgentTaskOutcome[] = [];
  let closed = false;

  const deliver = (outcome: AgentTaskOutcome): void => {
    const handler = handlers.get(outcome.callback.kind);
    if (!handler) {
      undelivered.push(outcome);
      while (undelivered.length > MAX_UNDELIVERED) undelivered.shift();
      log(`[agent-task] run #${outcome.runId}: no callback "${outcome.callback.kind}" yet; kept the outcome`);
      return;
    }
    try {
      handler(outcome);
    } catch (error) {
      log(`[agent-task] run #${outcome.runId} callback failed: ${String(error)}`);
    }
  };

  const stopRun = async (entry: RunningTask, reason: NonNullable<RunningTask["stop"]>): Promise<void> => {
    entry.stop ??= reason;
    const message = reason === "cancelled" ? "子 agent 被取消"
      : reason === "timeout" ? `子 agent 超时（超过 ${Math.round(timeoutMs / 60_000)} 分钟）` : "daemon 停机，子 agent 被打断";
    try {
      db.transaction(() => {
        const run = getRun(db, entry.runId);
        if (!run || (run.state !== "starting" && run.state !== "running")) return;
        if (reason === "cancelled") {
          transitionRunState(db, entry.runId, "stopped", { endedAt: true, errorCode: "agent_task_cancelled", errorMessage: message });
        } else {
          const code = reason === "timeout" ? "agent_task_timeout" : "daemon_shutdown";
          transitionRunState(db, entry.runId, "failed", {
            endedAt: true, errorCode: code, errorMessage: message, failure: typedFailure("run_interrupted", { errorCode: code, message }),
          });
        }
      }).immediate();
    } catch (error) {
      log(`[agent-task] could not mark run #${entry.runId} ${reason}: ${String(error)}`);
    }
    const child = liveChildren().get(entry.itemId);
    if (child && child.runId === entry.runId) await child.handle?.interrupt(message).catch(() => {});
  };

  const finalize = (entry: RunningTask, runtime: ReturnType<typeof createAgentTaskRuntime>, failure: unknown): void => {
    if (entry.timer) clearTimeout(entry.timer);
    running.delete(entry.runId);
    let outcome: AgentTaskOutcome;
    const reads = (() => {
      try { return options.connections.runReads(entry.runId).records(); } catch { return []; }
    })();
    const base = { runId: entry.runId, itemId: entry.itemId, callback: entry.callback, result: null, reads };
    // 结局（含核实过出处的结果）要在连接中心丢掉这个 Run 的读取记录以前读。
    try {
      const ran = runtime.outcome();
      if (getRun(db, entry.runId)?.state === "paused") {
        transitionRunState(db, entry.runId, "stopped", { endedAt: true, errorCode: "agent_task_cancelled", errorMessage: "子 agent 被暂停，不能恢复" });
      }
      const run = getRun(db, entry.runId);
      const item = getItem(db, entry.itemId);
      const actions = writesOf(db, entry.runId);
      const grant = grantOf(db, entry.runId);
      if (entry.stop === "cancelled" || (entry.stop === null && item?.stage === "cancelled") || run?.state === "stopped") {
        outcome = { ...base, status: "cancelled", actions, grant, error: entry.stop === "cancelled" ? null : "工单被取消或停止" };
      } else if (entry.stop === "timeout" || entry.stop === "shutdown") {
        outcome = { ...base, status: "failed", actions, grant, error: run?.error_message ?? entry.stop };
      } else if (failure !== null) {
        outcome = { ...base, status: "failed", actions, grant, error: failure instanceof Error ? failure.message : String(failure) };
      } else if (run?.state === "finished" && ran.result) {
        outcome = { ...base, status: "finished", result: ran.result, actions, grant, error: null };
      } else {
        outcome = { ...base, status: "failed", actions, grant, error: ran.error ?? run?.error_message ?? "子 agent 没有正常结束" };
      }
      db.transaction(() => {
        const stage = closeLookupItem(db, {
          itemId: entry.itemId, runId: entry.runId, status: outcome.status,
          reason: outcome.status === "finished" ? "agent task finished" : `agent task ${outcome.status}: ${outcome.error ?? ""}`,
          now: now(),
        });
        recordFinished(db, outcome, stage);
      }).immediate();
    } catch (error) {
      log(`[agent-task] run #${entry.runId} finalize failed: ${String(error)}`);
      outcome = { ...base, status: "failed", actions: [], grant: grantOf(db, entry.runId), error: `收尾出错：${String(error)}` };
    }
    options.connections.releaseRun(entry.runId);
    try { options.onSettled?.(entry.itemId); } catch (error) { log(`[agent-task] onSettled failed: ${String(error)}`); }
    deliver(outcome);
  };

  const dispatch = async (request: AgentTaskRequest): Promise<AgentTaskDispatch> => {
    if (closed) throw new Error("agent task dispatcher is closed");
    if (!Value.Check(AgentTaskRequestSchema, request)) {
      const first = [...Value.Errors(AgentTaskRequestSchema, request)][0];
      throw new Error(`agent task request is invalid: ${first ? `${(first as { instancePath?: string }).instancePath || "/"} ${first.message}` : "?"}`);
    }
    const bound = request.bound ?? DEFAULT_INTENT_GRANT_BOUNDS[request.intent];
    const { grant, dropped } = computeRunGrant({ intent: request.intent, scope: request.scope, bound, resolveLocalRepo: options.resolveLocalRepo });
    const labels = describeRunGrant(grant);
    const brief = [
      `${INTENT_WORDS[request.intent]}（通道派的工单）。${oneLine(request.request.summary, 300)}`,
      `权限清单：${labels.length ? labels.join("；") : "空"}。`,
      ...(dropped.length ? [`超出上限、没有给的：${dropped.join("；")}。`] : []),
      "对方的原话在通道卡上。结果由派单器交回发起方；这张工单跟着子 agent 结束。",
    ].join("\n");
    const { itemId, runId } = db.transaction(() => {
      const itemId = createItem(db, { title: agentTaskTitle(request), brief, createdBy: "system", purpose: "lookup", priority: "normal" });
      const runId = createRun(db, {
        itemId, role: "executor", purpose: "lookup", runtime: AGENT_TASK_RUNTIME_PROFILE.runtime,
        runtimeProfileHash: runtimeProfileHash(AGENT_TASK_RUNTIME_PROFILE),
      });
      insertRunGrant(db, { itemId, runId, grant, bound, scope: request.scope, dropped, actor: "lead", reason: oneLine(request.request.summary, 300), now: now() });
      // 开跑是系统的动作，和 runItem 给执行 Run 的 ready → active 一样，发生在 Run 建好的同一笔事务里。
      transition(db, { itemId, to: "active", actor: "system", reason: "agent task started", runId });
      addActivity(db, {
        itemId, runId, actor: "system", kind: "decision",
        payload: {
          decision: AGENT_TASK_STARTED, intent: request.intent, callback: request.callback,
          source: oneLine(request.request.source, 60), requester: oneLine(request.request.requester, 100),
          ...(request.request.ref ? { ref: oneLine(request.request.ref, 200) } : {}),
          grant: labels, dropped, timeoutMs,
        },
      });
      return { itemId, runId };
    }).immediate();
    // 代回复风格（设置 → 消息通道，2026-10-28）：子 agent 的回复草稿按它写。每次派活时现读。
    const runtime = createAgentTaskRuntime({
      intent: request.intent, ownerName: options.ownerName() ?? "用户", replyStyle: replyStyleText(db), connections, sessionFactory,
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
      now,
    });
    const entry: RunningTask = { runId, itemId, callback: request.callback, stop: null, timer: null, done: Promise.resolve() };
    running.set(runId, entry);
    entry.timer = setTimeout(() => { void stopRun(entry, "timeout"); }, timeoutMs);
    entry.timer.unref?.();
    const started = runItem(db, itemId, {
      dbPath: options.dbPath,
      dataDir: options.dataDir,
      sessionDir: join(options.dataDir, "sessions", `item-${itemId}`),
      prompt: agentTaskPrompt(request),
      runtime,
      role: "executor",
      purpose: "lookup",
      runId,
      lingerMs: 0,
      ...(options.onEvent ? { onEvent: (event, context) => options.onEvent!(context.itemId, context.runId, event) } : {}),
    });
    entry.done = started.then(
      () => finalize(entry, runtime, null),
      (error: unknown) => finalize(entry, runtime, error ?? new Error("agent task run failed")),
    );
    log(`[agent-task] ${request.intent} started on item #${itemId} run #${runId}`);
    return { itemId, runId, grant, dropped };
  };

  return {
    dispatch,
    async cancel(runId: number): Promise<void> {
      const entry = running.get(runId);
      if (!entry) return;
      await stopRun(entry, "cancelled");
      await entry.done;
    },
    onFinished(kind, handler) {
      handlers.set(kind, handler);
      for (const outcome of undelivered.splice(0)) {
        if (outcome.callback.kind === kind) deliver(outcome);
        else undelivered.push(outcome);
      }
    },
    deliver,
    running: () => [...running.keys()],
    async idle(): Promise<void> {
      await Promise.allSettled([...running.values()].map((entry) => entry.done));
    },
    async close(): Promise<void> {
      closed = true;
      const entries = [...running.values()];
      await Promise.allSettled(entries.map((entry) => stopRun(entry, "shutdown")));
      await Promise.allSettled(entries.map((entry) => entry.done));
    },
  };
}
